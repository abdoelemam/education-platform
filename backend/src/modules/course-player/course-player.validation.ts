import { z } from 'zod';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const objectId = (label: string) =>
  z.string().regex(OBJECT_ID_PATTERN, `Invalid ${label}`);

/**
 * Route parameters for the Course Player lesson endpoint.
 *
 * The endpoint is course-scoped: a lesson id from another course is treated as
 * missing rather than resolved globally.
 */
export const coursePlayerLessonParamSchema = z.object({
  courseId: objectId('course id'),
  lessonId: objectId('lesson id'),
});

export type CoursePlayerLessonParam = z.infer<
  typeof coursePlayerLessonParamSchema
>;
