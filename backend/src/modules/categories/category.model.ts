import mongoose, { Schema } from 'mongoose';
import {
  CATEGORY_DESCRIPTION_MAX,
  CATEGORY_NAME_MAX,
  CATEGORY_NAME_MIN,
  CATEGORY_SLUG_MAX,
} from './category.constants.js';
import type { CategoryDocument } from './category.types.js';

const categorySchema = new Schema<CategoryDocument>(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      minlength: [CATEGORY_NAME_MIN, `Category name must be at least ${CATEGORY_NAME_MIN} characters`],
      maxlength: [CATEGORY_NAME_MAX, `Category name cannot exceed ${CATEGORY_NAME_MAX} characters`],
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      lowercase: true,
      trim: true,
      maxlength: [CATEGORY_SLUG_MAX, `Category slug cannot exceed ${CATEGORY_SLUG_MAX} characters`],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [
        CATEGORY_DESCRIPTION_MAX,
        `Category description cannot exceed ${CATEGORY_DESCRIPTION_MAX} characters`,
      ],
      default: undefined,
    },
    parentId: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      default: undefined,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * Staged rows are invisible until the creator's fenced commit succeeds.
     * Legacy rows have no field and are treated as committed.
     */
    committed: {
      type: Boolean,
      default: true,
    },
    /** Internal mutation lease token. Never mapped to API responses. */
    mutationToken: {
      type: String,
      default: undefined,
    },
    /**
     * Monotonic lease generation. A stale holder may not copy its older
     * generation over a newer holder's fence.
     */
    fenceGeneration: {
      type: Number,
      default: undefined,
      min: 0,
    },
    /** Database-time lease expiry used by every fenced category write. */
    leaseExpiresAt: {
      type: Date,
      default: undefined,
    },
    /**
     * Course-reference membership. `courseRefs` blocks deletion; the protected
     * subset blocks hiding/moving a branch that contains a protected course.
     * Both are internal and never exposed by the API.
     */
    courseRefs: {
      type: [Schema.Types.ObjectId],
      ref: 'Course',
      default: undefined,
    },
    protectedCourseRefs: {
      type: [Schema.Types.ObjectId],
      ref: 'Course',
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

// Children are loaded together with their parent; ordering is deterministic.
categorySchema.index({ parentId: 1, sortOrder: 1, name: 1 });

// Public tree scans active nodes and their parent links.
categorySchema.index({ isActive: 1, parentId: 1, sortOrder: 1 });

// Lease refresh/release and expired staged-row cleanup.
categorySchema.index({ committed: 1, mutationToken: 1, leaseExpiresAt: 1 });

// Acquisition refreshes only rows with an older generation.
categorySchema.index({ committed: 1, fenceGeneration: 1 });

export const CategoryModel = mongoose.model<CategoryDocument>(
  'Category',
  categorySchema,
);
