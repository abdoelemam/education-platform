import mongoose, { Schema } from 'mongoose';
import {
  VIDEO_PROCESSING_STATUSES,
  VIDEO_UPLOAD_STATUSES,
  type VideoDocument,
} from './video.types.js';

/**
 * Video metadata model.
 *
 * Only metadata and provider references are stored; raw video bytes live in the
 * external storage provider and are never persisted in MongoDB.
 */
const videoSchema = new Schema<VideoDocument>(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
      default: undefined,
    },
    provider: {
      type: String,
      required: true,
      trim: true,
    },
    providerAssetId: {
      type: String,
      default: undefined,
      index: true,
    },
    uploadStatus: {
      type: String,
      enum: {
        values: VIDEO_UPLOAD_STATUSES,
        message: 'Invalid upload status: {VALUE}',
      },
      default: 'not_authorized',
      index: true,
    },
    processingStatus: {
      type: String,
      enum: {
        values: VIDEO_PROCESSING_STATUSES,
        message: 'Invalid processing status: {VALUE}',
      },
      default: 'pending',
      index: true,
    },
    durationSeconds: { type: Number, default: undefined, min: 0 },
    width: { type: Number, default: undefined, min: 0 },
    height: { type: Number, default: undefined, min: 0 },
    format: { type: String, default: undefined },
    sizeBytes: { type: Number, default: undefined, min: 0 },
    thumbnailUrl: { type: String, default: undefined },
    playbackUrl: { type: String, default: undefined },
    uploadAuthorizationExpiresAt: { type: Date, default: undefined },
    uploadedAt: { type: Date, default: undefined },
    readyAt: { type: Date, default: undefined },
    failureReason: { type: String, default: undefined },
  },
  {
    timestamps: true,
  },
);

export const VideoModel = mongoose.model<VideoDocument>('Video', videoSchema);
