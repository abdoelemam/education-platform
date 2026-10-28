import { z } from 'zod';
import { PROGRESS_MAX_SECONDS } from './progress.constants.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const objectId = (label: string) =>
  z.string().regex(OBJECT_ID_PATTERN, `Invalid ${label}`);

/**
 * Route parameters for course-scoped progress reads.
 *
 * Progress is course-scoped: a lesson id from another course is treated as
 * missing rather than resolved globally.
 */
export const progressCourseParamSchema = z.object({
  courseId: objectId('course id'),
});

export const progressLessonParamSchema = z.object({
  courseId: objectId('course id'),
  lessonId: objectId('lesson id'),
});

/**
 * A client-reported playback value. The authoritative duration clamps video
 * values further; this schema only rejects malformed/absurd payloads before
 * they reach the database.
 */
const seconds = z.number().finite().min(0).max(PROGRESS_MAX_SECONDS);

/**
 * Body for `PUT /api/courses/:courseId/lessons/:lessonId/progress`.
 *
 * `durationSeconds`, `ended`, `score`, `studentId`, `completedAt` and any other
 * field are rejected because the schema is strict. The backend never accepts a
 * client duration or completion proof for a video; `completed` is only honored
 * as the explicit text/document action.
 */
export const recordProgressBodySchema = z
  .object({
    positionSeconds: seconds.optional(),
    watchedSeconds: seconds.optional(),
    completed: z.boolean().optional(),
  })
  .strict();

export type ProgressCourseParam = z.infer<typeof progressCourseParamSchema>;
export type ProgressLessonParam = z.infer<typeof progressLessonParamSchema>;
export type RecordProgressBody = z.infer<typeof recordProgressBodySchema>;
