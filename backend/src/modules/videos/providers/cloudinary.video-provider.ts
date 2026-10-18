import crypto from 'node:crypto';
import { AppError } from '../../../errors/index.js';
import { VIDEO_ERRORS } from '../video.constants.js';
import type {
  ProviderAssetInfo,
  VideoPlaybackReference,
  VideoProvider,
  VideoUploadAuthorization,
  VideoUploadAuthorizationRequest,
} from './video-provider.interface.js';

/**
 * Cloudinary enforces a fixed one-hour validity window on upload signatures:
 * the signed `timestamp` must be within one hour of the request and there is
 * no parameter to make that window shorter. This is therefore the real,
 * server-enforced lifetime of the instructions we return, not a preference.
 *
 * @see https://cloudinary.com/documentation/upload_images ("The signature is
 * valid for 1 hour")
 */
const CLOUDINARY_UPLOAD_SIGNATURE_TTL_SECONDS = 60 * 60;

/** Abort a hung Admin API call instead of hanging the originating request. */
const ADMIN_REQUEST_TIMEOUT_MS = 15_000;

export interface CloudinaryProviderConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * Shape of the Cloudinary Admin API resource response we consume.
 * Only fields we rely on are modeled; everything else is ignored.
 */
interface CloudinaryResource {
  public_id?: string;
  format?: string;
  duration?: number;
  width?: number;
  height?: number;
  bytes?: number;
  secure_url?: string;
  url?: string;
}

/**
 * Cloudinary adapter.
 *
 * Uses signature-based direct uploads:
 *   1. The browser asks our API for upload instructions.
 *   2. We sign `public_id`, `timestamp` and `overwrite=false` with the API
 *      secret, so the asset can never be replaced by a later upload.
 *   3. The browser uploads directly to Cloudinary. The API server never sees
 *      the file and never exposes `api_secret` (only `api_key`, `timestamp`
 *      and the derived `signature` are returned).
 *
 * The adapter makes no network calls when signing; only `getAsset`/`deleteAsset`
 * contact the Cloudinary Admin API.
 */
export class CloudinaryVideoProvider implements VideoProvider {
  readonly name = 'cloudinary';

  constructor(private readonly config: CloudinaryProviderConfig) {}

  isConfigured(): boolean {
    return Boolean(
      this.config.cloudName && this.config.apiKey && this.config.apiSecret,
    );
  }

  async createUploadAuthorization(
    request: VideoUploadAuthorizationRequest,
  ): Promise<VideoUploadAuthorization> {
    const timestamp = Math.floor(Date.now() / 1000);

    const signedParams: Record<string, string> = {
      public_id: request.assetId,
      timestamp: String(timestamp),
      // Never replace an existing asset: when the public id already exists,
      // Cloudinary returns immediately instead of overwriting it. This is what
      // prevents a still-valid older signature from replacing a video that has
      // already uploaded successfully.
      overwrite: 'false',
    };

    const signature = this.sign(signedParams);

    return {
      provider: this.name,
      assetId: request.assetId,
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.config.cloudName}/video/upload`,
      method: 'POST',
      // api_key and signature are safe to expose; api_secret never is.
      fields: {
        ...signedParams,
        api_key: this.config.apiKey,
        signature,
      },
      // Cloudinary enforces this window itself; it cannot be shortened.
      expiresAt: new Date(
        (timestamp + CLOUDINARY_UPLOAD_SIGNATURE_TTL_SECONDS) * 1000,
      ),
    };
  }

  async getAsset(assetId: string): Promise<ProviderAssetInfo> {
    const response = await this.adminRequest(
      'GET',
      `resources/video/upload/${encodeURIComponent(assetId)}`,
    );

    if (response.status === 404) {
      return { exists: false, assetId, status: 'failed' };
    }

    if (!response.ok) {
      throw new AppError(
        502,
        VIDEO_ERRORS.VIDEO_PROVIDER_ERROR,
        'The video provider could not be reached',
      );
    }

    const resource = (await response.json()) as CloudinaryResource;
    const playbackUrl = resource.secure_url ?? resource.url;

    // Cloudinary processes assets on delivery; a resource returned by the
    // Admin API is available for playback.
    return {
      exists: true,
      assetId: resource.public_id ?? assetId,
      status: 'ready',
      durationSeconds: resource.duration,
      width: resource.width,
      height: resource.height,
      format: resource.format,
      sizeBytes: resource.bytes,
      thumbnailUrl: this.buildThumbnailUrl(playbackUrl),
      playbackUrl,
    };
  }

  buildPlaybackReference(asset: ProviderAssetInfo): VideoPlaybackReference {
    if (!asset.playbackUrl) {
      throw new AppError(
        502,
        VIDEO_ERRORS.VIDEO_PROVIDER_ERROR,
        'The video provider did not return a playable URL',
      );
    }

    return {
      provider: this.name,
      assetId: asset.assetId,
      url: asset.playbackUrl,
    };
  }

  async deleteAsset(assetId: string): Promise<void> {
    // Cloudinary deletes by public id through the bulk Admin API endpoint; the
    // single-resource path only supports reads. The asset id is sent as a form
    // field so public ids containing `/` are handled correctly.
    const body = new URLSearchParams();
    body.append('public_ids[]', assetId);

    const response = await this.adminRequest(
      'DELETE',
      'resources/video/upload',
      body,
    );

    // A nonexistent public id is reported as a 200 with a `not_found` entry;
    // any other non-2xx response is a real provider failure.
    if (!response.ok) {
      throw new AppError(
        502,
        VIDEO_ERRORS.VIDEO_PROVIDER_ERROR,
        'The video provider could not delete the asset',
      );
    }
  }

  /**
   * Cloudinary signature: SHA-1 of the alphabetically sorted `key=value` pairs
   * joined by `&`, with the API secret appended.
   */
  private sign(params: Record<string, string>): string {
    const toSign = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');

    return crypto
      .createHash('sha1')
      .update(`${toSign}${this.config.apiSecret}`)
      .digest('hex');
  }

  private async adminRequest(
    method: 'GET' | 'DELETE',
    path: string,
    body?: URLSearchParams,
  ): Promise<Response> {
    const auth = Buffer.from(
      `${this.config.apiKey}:${this.config.apiSecret}`,
    ).toString('base64');

    const headers: Record<string, string> = {
      Authorization: `Basic ${auth}`,
    };

    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    try {
      return await fetch(
        `https://api.cloudinary.com/v1_1/${this.config.cloudName}/${path}`,
        {
          method,
          headers,
          body: body?.toString(),
          signal: AbortSignal.timeout(ADMIN_REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      throw new AppError(
        502,
        VIDEO_ERRORS.VIDEO_PROVIDER_ERROR,
        'The video provider could not be reached',
      );
    }
  }

  private buildThumbnailUrl(playbackUrl?: string): string | undefined {
    if (!playbackUrl) {
      return undefined;
    }
    return `${playbackUrl.replace(/\.[a-zA-Z0-9]+$/, '')}.jpg`;
  }
}
