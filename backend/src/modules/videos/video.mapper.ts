import type { IVideo, PublicVideo, VideoDocument } from './video.types.js';

/**
 * Map a Video document/entity into a sanitized public representation.
 * Guarantee: `playbackUrl` is only exposed once the provider reports the asset
 * as ready, never before.
 */
export function toPublicVideo(
  video: VideoDocument | (IVideo & { _id: unknown }),
): PublicVideo {
  return {
    id: String(video._id),
    ownerId: video.ownerId.toString(),
    title: video.title,
    description: video.description,
    provider: video.provider,
    providerAssetId: video.providerAssetId,
    uploadStatus: video.uploadStatus,
    processingStatus: video.processingStatus,
    durationSeconds: video.durationSeconds,
    width: video.width,
    height: video.height,
    format: video.format,
    sizeBytes: video.sizeBytes,
    thumbnailUrl: video.thumbnailUrl,
    playbackUrl: video.processingStatus === 'ready' ? video.playbackUrl : undefined,
    uploadAuthorizationExpiresAt: video.uploadAuthorizationExpiresAt?.toISOString(),
    uploadedAt: video.uploadedAt?.toISOString(),
    readyAt: video.readyAt?.toISOString(),
    failureReason: video.failureReason,
    createdAt: video.createdAt.toISOString(),
    updatedAt: video.updatedAt.toISOString(),
  };
}
