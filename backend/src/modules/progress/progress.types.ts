import type { Document, Types } from 'mongoose';
import type { PROGRESS_LESSON_TYPES } from './progress.constants.js';

/** Lesson types that can carry progress in Phase 9. */
export type ProgressLessonType = (typeof PROGRESS_LESSON_TYPES)[number];

/**
 * Per-student progress for one lesson.
 *
 * The row is the authoritative record of what the backend has accepted for a
 * student/lesson pair. `watchedSeconds` is monotonic and `completed` is sticky;
 * neither is ever reset by a later request.
 */
export interface ILessonProgress {
  studentId: Types.ObjectId;
  courseId: Types.ObjectId;
  sectionId: Types.ObjectId;
  lessonId: Types.ObjectId;
  lessonType: ProgressLessonType;
  /** Server-accepted watched time, monotonic and clamped to the duration. */
  watchedSeconds: number;
  /** Authoritative duration snapshot for video lessons. */
  durationSeconds?: number;
  /** Most recently reported playback position. */
  lastPositionSeconds: number;
  completed: boolean;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface LessonProgressDocument
  extends ILessonProgress,
    Document<Types.ObjectId> {
  _id: Types.ObjectId;
}

/**
 * Runtime shape read from MongoDB with `lean()`. Dates stay optional because a
 * row inserted by a raw writer may not carry Mongoose timestamps.
 */
export interface LessonProgressLike {
  _id: { toString(): string };
  studentId: { toString(): string };
  courseId: { toString(): string };
  sectionId: { toString(): string };
  lessonId: { toString(): string };
  lessonType: ProgressLessonType;
  watchedSeconds: number;
  durationSeconds?: number;
  lastPositionSeconds: number;
  completed: boolean;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Client input accepted by the progress endpoint.
 *
 * `completed` is only an explicit action for text/document lessons. For video
 * lessons completion is derived from server-recorded watched time and the
 * authoritative video duration.
 */
export interface RecordProgressInput {
  positionSeconds?: number;
  watchedSeconds?: number;
  completed?: boolean;
}

/** Display-safe progress for one lesson. */
export interface LessonProgressView {
  lessonId: string;
  sectionId: string;
  lessonType: ProgressLessonType;
  watchedSeconds: number;
  durationSeconds?: number;
  lastPositionSeconds: number;
  completed: boolean;
  completedAt?: string;
}

/** Counts shared by the course summary and the student course list. */
export interface CourseProgressSummary {
  completedLessons: number;
  totalLessons: number;
  percent: number;
}

/** Full course progress for the authenticated student. */
export interface CourseProgressView extends CourseProgressSummary {
  courseId: string;
  currentLessonId: string | null;
  lessons: LessonProgressView[];
}
