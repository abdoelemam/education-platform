import mongoose, { Schema } from 'mongoose';
import { LESSON_TYPES, type LessonDocument } from './course.types.js';

/**
 * Lesson model: an ordered, typed content unit inside a section.
 *
 * Only fields relevant to `type` are populated; the service clears the others
 * when a lesson's type changes.
 */
const lessonSchema = new Schema<LessonDocument>(
  {
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    sectionId: {
      type: Schema.Types.ObjectId,
      ref: 'Section',
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
    type: {
      type: String,
      required: true,
      enum: {
        values: LESSON_TYPES,
        message: 'Invalid lesson type: {VALUE}',
      },
    },
    order: {
      type: Number,
      required: true,
      min: [1, 'Order must be at least 1'],
    },
    // Type-specific payloads.
    videoId: { type: Schema.Types.ObjectId, ref: 'Video', default: undefined },
    content: {
      type: String,
      default: undefined,
      maxlength: [20000, 'Content cannot exceed 20000 characters'],
    },
    documentUrl: {
      type: String,
      trim: true,
      default: undefined,
      maxlength: [2048, 'Document URL cannot exceed 2048 characters'],
    },
    documentName: {
      type: String,
      trim: true,
      default: undefined,
      maxlength: [200, 'Document name cannot exceed 200 characters'],
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

// Lessons are read (and ordered) per section; courseId supports cascade deletes.
lessonSchema.index({ sectionId: 1, order: 1 });
lessonSchema.index({ courseId: 1 });

export const LessonModel = mongoose.model<LessonDocument>('Lesson', lessonSchema);
