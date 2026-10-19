import mongoose, { Schema } from 'mongoose';
import { COURSE_STATUSES, type CourseDocument } from './course.types.js';

/**
 * Course metadata model.
 *
 * Sections and lessons are stored in their own collections (see section.model
 * and lesson.model) and reference the course, which keeps structural ordering
 * and cascade deletes straightforward as content grows.
 */
const courseSchema = new Schema<CourseDocument>(
  {
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: [80, 'Slug cannot exceed 80 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [5000, 'Description cannot exceed 5000 characters'],
      default: undefined,
    },
    status: {
      type: String,
      enum: {
        values: COURSE_STATUSES,
        message: 'Invalid course status: {VALUE}',
      },
      default: 'draft',
    },
    submittedAt: {
      type: Date,
      default: undefined,
    },
    reviewedAt: {
      type: Date,
      default: undefined,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: undefined,
    },
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [1000, 'Rejection reason cannot exceed 1000 characters'],
      default: undefined,
    },
    /**
     * Internal edit lease. Not client-controlled and never mapped to API
     * responses. Submission refuses to run while this is true.
     */
    editLocked: {
      type: Boolean,
      default: false,
    },
    editLockedAt: {
      type: Date,
      default: undefined,
    },
    editLockToken: {
      type: String,
      default: undefined,
    },
    /** Database-time lease expiry checked by every content write filter. */
    editLeaseExpiresAt: {
      type: Date,
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

// Primary listing access pattern: a teacher's courses, newest first.
courseSchema.index({ ownerId: 1, createdAt: -1 });

// Admin moderation queue: courses filtered by review status, newest first.
courseSchema.index({ status: 1, createdAt: -1 });

export const CourseModel = mongoose.model<CourseDocument>('Course', courseSchema);
