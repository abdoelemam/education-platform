import { randomBytes } from 'node:crypto';
import { config } from '../../config/index.js';
import { AppError } from '../../errors/index.js';
import { logger } from '../../utils/index.js';
import type { AuthUser } from '../users/user.types.js';
import { VIDEO_ERRORS } from './video.constants.js';
import { toPublicVideo } from './video.mapper.js';
import {
  videoRepository,
  type VideoRepository,
  type VideoUpdate,
} from './video.repository.js';
import { resolveVideoProvider } from './providers/index.js';
import type {
  VideoPlaybackReference,
  VideoProvider,
} from './providers/video-provider.interface.js';
import type {
  PublicVideo,
  VideoDocument,
  VideoUploadAuthorizationResult,
} from './video.types.js';

export interface PaginatedVideos {
  items: PublicVideo[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Business rules for the video system.
 *
 * The provider owns the raw bytes; this service owns metadata, authorization,
 * ownership checks and the server-side verification of upload/processing state.
 */
export class VideoService {
  constructor(
    private readonly repo: VideoRepository = videoRepository,
    private readonly provider: VideoProvider = resolveVideoProvider(),
  ) {}

  async createVideo(params: {
    ownerId: string;
    title: string;
    description?: string;
  }): Promise<PublicVideo> {
    const video = await this.repo.create({
      ownerId: params.ownerId,
      title: params.title,
      description: params.description,
      provider: this.provider.name,
    });

    return toPublicVideo(video);
  }

  async listVideos(params: {
    ownerId: string;
    page: number;
    limit: number;
  }): Promise<PaginatedVideos> {
    const skip = (params.page - 1) * params.limit;
    const { items, total } = await this.repo.listByOwner({
      ownerId: params.ownerId,
      skip,
      limit: params.limit,
    });

    return {
      items: items.map(toPublicVideo),
      page: params.page,
      limit: params.limit,
      total,
      totalPages: params.limit > 0 ? Math.ceil(total / params.limit) : 0,
    };
  }

  async getVideo(params: {
    videoId: string;
    requester: AuthUser;
  }): Promise<PublicVideo> {
    const video = await this.requireAccessibleVideo(params.videoId, params.requester);
    return toPublicVideo(video);
  }

  /**
   * Issue short-lived, server-authorized direct-upload instructions.
   * Only the owner (or an admin) may request them.
   */
  async authorizeUpload(params: {
    videoId: string;
    requester: AuthUser;
  }): Promise<VideoUploadAuthorizationResult> {
    const video = await this.requireAccessibleVideo(params.videoId, params.requester);

    if (video.uploadStatus === 'completed' && video.processingStatus === 'ready') {
      throw new AppError(
        409,
        VIDEO_ERRORS.VIDEO_UPLOAD_ALREADY_COMPLETE,
        'This video has already been uploaded',
      );
    }

    const previousAssetId = video.providerAssetId;

    // A provider-confirmed asset that is not ready (for example, failed
    // processing) cannot be overwritten: signed uploads are `overwrite=false`.
    // A retry therefore targets a fresh asset id.
    const needsRotation =
      Boolean(previousAssetId) && video.uploadStatus === 'completed';
    const assetId = needsRotation
      ? this.buildRetryAssetId(video._id.toString())
      : previousAssetId ?? this.buildAssetId(video._id.toString());

    const authorization = await this.provider.createUploadAuthorization({
      videoId: video._id.toString(),
      ownerId: video.ownerId.toString(),
      assetId,
    });

    const updated = await this.repo.updateById(
      video._id.toString(),
      {
        provider: this.provider.name,
        providerAssetId: authorization.assetId,
        uploadStatus: 'authorized',
        processingStatus: 'pending',
        uploadAuthorizationExpiresAt: authorization.expiresAt,
      },
      ['failureReason'],
    );

    if (!updated) {
      throw new AppError(404, VIDEO_ERRORS.VIDEO_NOT_FOUND, 'Video not found');
    }

    // Delete the superseded asset only after the new asset id is persisted, so a
    // failed authorization or DB write never leaves the record pointing at an
    // already-deleted asset. Cleanup stays best effort.
    if (needsRotation && previousAssetId) {
      await this.deleteSupersededAsset(previousAssetId);
    }

    return {
      videoId: updated._id.toString(),
      provider: authorization.provider,
      assetId: authorization.assetId,
      uploadUrl: authorization.uploadUrl,
      method: authorization.method,
      // Fields contain a signed token; never the provider secret.
      fields: authorization.fields,
      expiresAt: authorization.expiresAt.toISOString(),
    };
  }

  /**
   * Verify the upload with the provider and refresh metadata/processing state.
   *
   * Client-supplied metadata is never trusted: duration, dimensions, format,
   * processing status and playback URL all come from the provider response.
   */
  async completeUpload(params: {
    videoId: string;
    requester: AuthUser;
  }): Promise<PublicVideo> {
    const video = await this.requireAccessibleVideo(params.videoId, params.requester);

    // Authorization expiry is intentionally not enforced here: the provider is
    // the source of truth. A video uploaded before the window closed must still
    // be verified, while one that was never uploaded is caught below by the
    // missing asset at the provider.
    // Idempotent once ready.
    if (video.processingStatus === 'ready') {
      return toPublicVideo(video);
    }

    const canVerify =
      Boolean(video.providerAssetId) &&
      (video.uploadStatus === 'authorized' || video.uploadStatus === 'completed');

    if (!canVerify || !video.providerAssetId) {
      throw new AppError(
        409,
        VIDEO_ERRORS.VIDEO_UPLOAD_NOT_AUTHORIZED,
        'Upload authorization is required before completing an upload',
      );
    }

    const asset = await this.provider.getAsset(video.providerAssetId);

    if (!asset.exists) {
      await this.repo.updateById(video._id.toString(), {
        uploadStatus: 'failed',
        processingStatus: 'failed',
        failureReason: 'The uploaded video could not be found at the storage provider',
      });

      throw new AppError(
        409,
        VIDEO_ERRORS.VIDEO_UPLOAD_NOT_FOUND,
        'The uploaded video could not be found at the storage provider',
      );
    }

    const isReady = asset.status === 'ready';
    const update: VideoUpdate = {
      uploadStatus: 'completed',
      processingStatus: asset.status,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height,
      format: asset.format,
      sizeBytes: asset.sizeBytes,
      thumbnailUrl: asset.thumbnailUrl,
    };

    // `uploadedAt` records the first confirmed upload, not the last refresh.
    if (!video.uploadedAt) {
      update.uploadedAt = new Date();
    }

    if (isReady) {
      update.playbackUrl = this.provider.buildPlaybackReference(asset).url;
      update.readyAt = new Date();
    } else if (asset.status === 'failed') {
      update.failureReason =
        asset.failureReason ?? 'The video provider reported a processing failure';
    }

    const updated = await this.repo.updateById(
      video._id.toString(),
      update,
      asset.status === 'failed' ? [] : ['failureReason'],
    );

    if (!updated) {
      throw new AppError(404, VIDEO_ERRORS.VIDEO_NOT_FOUND, 'Video not found');
    }

    if (asset.status === 'failed') {
      throw new AppError(
        502,
        VIDEO_ERRORS.VIDEO_PROVIDER_ERROR,
        asset.failureReason ?? 'The video provider reported a processing failure',
      );
    }

    return toPublicVideo(updated);
  }

  /**
   * Return a playback reference only after the provider reports the asset ready.
   */
  async getPlaybackReference(params: {
    videoId: string;
    requester: AuthUser;
  }): Promise<VideoPlaybackReference> {
    const video = await this.requireAccessibleVideo(params.videoId, params.requester);

    if (video.processingStatus !== 'ready' || !video.playbackUrl) {
      throw new AppError(
        409,
        VIDEO_ERRORS.VIDEO_NOT_READY,
        'This video is not ready for playback yet',
      );
    }

    return {
      provider: video.provider,
      assetId: video.providerAssetId ?? video._id.toString(),
      url: video.playbackUrl,
    };
  }

  async deleteVideo(params: {
    videoId: string;
    requester: AuthUser;
  }): Promise<void> {
    const video = await this.requireAccessibleVideo(params.videoId, params.requester);

    if (video.providerAssetId && this.provider.deleteAsset) {
      await this.provider.deleteAsset(video.providerAssetId);
    }

    await this.repo.deleteById(video._id.toString());
  }

  /**
   * Load a video and enforce that the requester owns it (admins may bypass).
   */
  private async requireAccessibleVideo(
    videoId: string,
    requester: AuthUser,
  ): Promise<VideoDocument> {
    const video = await this.repo.findById(videoId);

    if (!video) {
      throw new AppError(404, VIDEO_ERRORS.VIDEO_NOT_FOUND, 'Video not found');
    }

    if (requester.role !== 'admin' && video.ownerId.toString() !== requester.id) {
      throw new AppError(
        403,
        VIDEO_ERRORS.VIDEO_FORBIDDEN,
        'You do not have access to this video',
      );
    }

    return video;
  }

  private buildAssetId(videoId: string): string {
    const folder = config.VIDEO_UPLOAD_FOLDER.replace(/^\/+|\/+$/g, '');
    return folder ? `${folder}/${videoId}` : videoId;
  }

  private buildRetryAssetId(videoId: string): string {
    return `${this.buildAssetId(videoId)}-${randomBytes(6).toString('hex')}`;
  }

  /**
   * Remove a superseded, non-ready attempt so retries do not leave orphaned
   * storage. Cleanup is best effort: failing to delete the old asset must not
   * block the new upload.
   */
  private async deleteSupersededAsset(assetId: string): Promise<void> {
    if (!this.provider.deleteAsset) {
      return;
    }

    try {
      await this.provider.deleteAsset(assetId);
    } catch (error) {
      logger.warn('Failed to clean up a superseded video asset', {
        assetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const videoService = new VideoService();
