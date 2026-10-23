import mongoose, { Schema } from 'mongoose';
import {
  COURSE_LEVELS,
  COURSE_STATUSES,
  type CourseDocument,
} from './course.types.js';

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
    /**
     * Public taxonomy placement. Optional while drafting; publishing requires
     * the category (and every ancestor) to be active.
     */
    categoryId: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
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
    thumbnailUrl: {
      type: String,
      trim: true,
      maxlength: [2048, 'Thumbnail URL cannot exceed 2048 characters'],
      default: undefined,
    },
    level: {
      type: String,
      enum: {
        values: COURSE_LEVELS,
        message: 'Invalid course level: {VALUE}',
      },
      default: undefined,
    },
    language: {
      type: String,
      trim: true,
      maxlength: [11, 'Language cannot exceed 11 characters'],
      default: undefined,
    },
    learningOutcomes: {
      type: [String],
      default: undefined,
    },
    requirements: {
      type: [String],
      default: undefined,
    },
    /** Integer minor units (for example cents). 0 means free. */
    priceMinor: {
      type: Number,
      min: [0, 'Price cannot be negative'],
      validate: {
        validator: (value: number) => Number.isInteger(value),
        message: 'Price must be an integer amount in minor units',
      },
      default: undefined,
    },
    currency: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [3, 'Currency must be an ISO 4217 code'],
      default: undefined,
    },
    /** Set only by the publish transition; never accepted from clients. */
    publishedAt: {
      type: Date,
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

// Public catalog: published courses only, newest publication first.
courseSchema.index({ status: 1, publishedAt: -1 });

// Public catalog filtered by a category subtree.
courseSchema.index({ status: 1, categoryId: 1, publishedAt: -1 });

// Category deletion/deactivation guards resolve course references by category.
courseSchema.index({ categoryId: 1 });

export const CourseModel = mongoose.model<CourseDocument>('Course', courseSchema);
