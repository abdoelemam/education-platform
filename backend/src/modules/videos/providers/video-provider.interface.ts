/**
 * Provider-neutral contract for the video storage/processing backend.
 *
 * The application talks to videos exclusively through this interface so the
 * concrete provider (Cloudinary, Mux, S3, ...) remains replaceable. Providers
 * are responsible for issuing direct-upload instructions; the API server never
 * proxies video bytes and never exposes provider secrets to the browser.
 */

export interface VideoUploadAuthorizationRequest {
  /** Internal video id (used for tracing / provider metadata). */
  videoId: string;
  /** Owner (teacher) id. */
  ownerId: string;
  /**
   * Provider asset identifier chosen by the server. Reused across
   * re-authorizations so a retry overwrites the same asset.
   */
  assetId: string;
}

export interface VideoUploadAuthorization {
  provider: string;
  assetId: string;
  uploadUrl: string;
  method: 'POST';
  /** Signed form fields the browser submits directly to the provider. */
  fields: Record<string, string>;
  expiresAt: Date;
}

export type ProviderAssetStatus = 'processing' | 'ready' | 'failed';

/**
 * Normalized provider asset state. Values here are authoritative; client
 * supplied metadata is always ignored.
 */
export interface ProviderAssetInfo {
  exists: boolean;
  assetId: string;
  status: ProviderAssetStatus;
  durationSeconds?: number;
  width?: number;
  height?: number;
  format?: string;
  sizeBytes?: number;
  thumbnailUrl?: string;
  playbackUrl?: string;
  failureReason?: string;
}

export interface VideoPlaybackReference {
  provider: string;
  assetId: string;
  url: string;
  expiresAt?: Date;
}

export interface VideoProvider {
  readonly name: string;

  /** Whether the provider has the credentials it needs to operate. */
  isConfigured(): boolean;

  /** Build short-lived, server-authorized direct-upload instructions. */
  createUploadAuthorization(
    request: VideoUploadAuthorizationRequest,
  ): Promise<VideoUploadAuthorization>;

  /** Fetch authoritative asset state/metadata from the provider. */
  getAsset(assetId: string): Promise<ProviderAssetInfo>;

  /** Build a playback reference from a ready asset. */
  buildPlaybackReference(asset: ProviderAssetInfo): VideoPlaybackReference;

  /** Delete an asset. Optional; providers without it fall back to metadata-only deletion. */
  deleteAsset?(assetId: string): Promise<void>;
}
