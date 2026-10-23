import mongoose, { Schema, type Document } from 'mongoose';
import { CATEGORY_LOCK_ID } from './category.constants.js';

/**
 * Internal singleton lock document.
 *
 * Category hierarchy writes are cross-document operations (cycle check,
 * parent lookup, child/course reference checks). MongoDB standalone deployments
 * cannot use multi-document transactions, so a short-lived lease serializes the
 * read/validate/write sequence. The lease token, monotonic generation and
 * database-time expiry are copied onto committed category rows; every category
 * write must still match that fence. Release alone is not relied on to stop a
 * stalled writer.
 */
export interface CategoryLockDocument extends Document<string> {
  _id: string;
  locked: boolean;
  token?: string;
  lockedAt?: Date;
  expiresAt?: Date;
  /**
   * Monotonic acquisition generation. It survives release and is incremented
   * inside the same atomic acquisition update as the token and expiry.
   */
  fenceGeneration?: number;
}

const categoryLockSchema = new Schema<CategoryLockDocument>(
  {
    _id: {
      type: String,
      default: CATEGORY_LOCK_ID,
    },
    locked: {
      type: Boolean,
      default: false,
    },
    token: {
      type: String,
      default: undefined,
    },
    lockedAt: {
      type: Date,
      default: undefined,
    },
    expiresAt: {
      type: Date,
      default: undefined,
    },
    fenceGeneration: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: false,
    versionKey: false,
  },
);

export const CategoryLockModel = mongoose.model<CategoryLockDocument>(
  'CategoryLock',
  categoryLockSchema,
);
