import mongoose, { Schema } from 'mongoose';
import type { SectionDocument } from './course.types.js';

/**
 * Section model: an ordered container of lessons inside a single course.
 */
const sectionSchema = new Schema<SectionDocument>(
  {
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
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
    order: {
      type: Number,
      required: true,
      min: [1, 'Order must be at least 1'],
    },
    /**
     * Edit-lease fence. Every write must match the current token and a
     * database-time-unexpired lease. Staged creates are invisible until their
     * fenced commit succeeds.
     */
    editToken: { type: String, default: undefined },
    editLeaseExpiresAt: { type: Date, default: undefined },
    committed: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  },
);

// Sections are always read (and ordered) per course.
sectionSchema.index({ courseId: 1, order: 1 });

export const SectionModel = mongoose.model<SectionDocument>(
  'Section',
  sectionSchema,
);
