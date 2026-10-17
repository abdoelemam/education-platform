import type { Document, Types } from 'mongoose';

/**
 * Upload lifecycle for a video asset.
 *
 * - `not_authorized`: metadata exists, no upload instructions have been issued.
 * - `authorized`: short-lived upload instructions were issued to the owner.
 * - `completed`: the provider confirmed the uploaded asset exists.
 * - `failed`: the upload could not be confirmed at the provider.
 *
 * Authorization expiry is exposed via `uploadAuthorizationExpiresAt`; clients
 * request a new authorization rather than relying on a separate status.
 */
export const VIDEO_UPLOAD_STATUSES = [
  'not_authorized',
  'authorized',
  'completed',
  'failed',
] as const;
export type VideoUploadStatus = (typeof VIDEO_UPLOAD_STATUSES)[number];

/**
 * Provider-side processing lifecycle. Derived from provider data, never from
 * client input.
 */
export const VIDEO_PROCESSING_STATUSES = [
  'pending',
  'processing',
  'ready',
  'failed',
] as const;
export type VideoProcessingStatus = (typeof VIDEO_PROCESSING_STATUSES)[number];

/**
 * Core Video entity. Stores metadata and provider references only.
 * Raw video bytes are never stored in MongoDB or proxied through the API.
 */
export interface IVideo {
  ownerId: Types.ObjectId;
  title: string;
  description?: string;
  /** Identifier of the storage provider that owns the asset (e.g. `cloudinary`). */
  provider: string;
  /** Provider-side asset reference (never raw bytes). */
  providerAssetId?: string;
  uploadStatus: VideoUploadStatus;
  processingStatus: VideoProcessingStatus;
  durationSeconds?: number;
  width?: number;
  height?: number;
  format?: string;
  sizeBytes?: number;
  thumbnailUrl?: string;
  /** Only populated once the provider reports the asset ready. */
  playbackUrl?: string;
  uploadAuthorizationExpiresAt?: Date;
  uploadedAt?: Date;
  readyAt?: Date;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VideoDocument extends IVideo, Document<Types.ObjectId> {
  _id: Types.ObjectId;
}

/**
 * Sanitized video representation safe for API responses.
 *
 * `playbackUrl` is only exposed when the provider reports the asset as ready,
 * regardless of the persisted value.
 */
export interface PublicVideo {
  id: string;
  ownerId: string;
  title: string;
  description?: string;
  provider: string;
  providerAssetId?: string;
  uploadStatus: VideoUploadStatus;
  processingStatus: VideoProcessingStatus;
  durationSeconds?: number;
  width?: number;
  height?: number;
  format?: string;
  sizeBytes?: number;
  thumbnailUrl?: string;
  playbackUrl?: string;
  uploadAuthorizationExpiresAt?: string;
  uploadedAt?: string;
  readyAt?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Server-authorized instructions the browser uses to upload directly to the
 * storage provider. Never contains provider secrets.
 */
export interface VideoUploadAuthorizationResult {
  videoId: string;
  provider: string;
  assetId: string;
  uploadUrl: string;
  method: 'POST';
  fields: Record<string, string>;
  expiresAt: string;
}
