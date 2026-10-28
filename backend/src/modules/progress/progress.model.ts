import mongoose, { Schema } from 'mongoose';
import { PROGRESS_LESSON_TYPES } from './progress.constants.js';
import type { ILessonProgress } from './progress.types.js';

/**
 * LessonProgress model: one row per (student, lesson).
 *
 * The row is the authoritative record of accepted progress. It stores the
 * course/section references (denormalized) so course-level summaries do not
 * need to join through the lesson collection, and a duration snapshot for
 * video lessons.
 */
const lessonProgressSchema = new Schema<ILessonProgress>(
  {
    studentId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
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
    lessonId: {
      type: Schema.Types.ObjectId,
      ref: 'Lesson',
      required: true,
    },
    lessonType: {
      type: String,
      enum: {
        values: PROGRESS_LESSON_TYPES,
        message: 'Invalid progress lesson type: {VALUE}',
      },
      required: true,
    },
    watchedSeconds: {
      type: Number,
      default: 0,
      min: [0, 'Watched seconds cannot be negative'],
    },
    durationSeconds: {
      type: Number,
      default: undefined,
      min: [0, 'Duration cannot be negative'],
    },
    lastPositionSeconds: {
      type: Number,
      default: 0,
      min: [0, 'Position cannot be negative'],
    },
    completed: {
      type: Boolean,
      default: false,
    },
    completedAt: {
      type: Date,
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * One progress row per student/lesson. This unique index is the duplicate
 * barrier for concurrent progress updates.
 */
lessonProgressSchema.index({ studentId: 1, lessonId: 1 }, { unique: true });

// Course summary: a student's progress rows for one course.
lessonProgressSchema.index({ studentId: 1, courseId: 1 });

// Completion aggregation for a course.
lessonProgressSchema.index({ courseId: 1, completed: 1 });

export const LessonProgressModel = mongoose.model<ILessonProgress>(
  'LessonProgress',
  lessonProgressSchema,
);
