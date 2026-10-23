import { z } from 'zod';
import {
  ENROLLMENT_PAGE_DEFAULT_LIMIT,
  ENROLLMENT_PAGE_MAX,
  ENROLLMENT_PAGE_MAX_LIMIT,
} from './enrollment.constants.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;
const objectId = (label: string) =>
  z.string().regex(OBJECT_ID_PATTERN, `Invalid ${label}`);

/**
 * Course-scoped enrollment routes use the course id only. A malformed id is a
 * validation error rather than a database cast error.
 */
export const enrollmentCourseParamSchema = z.object({
  courseId: objectId('course id'),
});

export type EnrollmentCourseParam = z.infer<typeof enrollmentCourseParamSchema>;

/**
 * Enrollment takes no client fields. Price, status, timestamps, source, order
 * and payment state are server-owned; a body with any of them is rejected so a
 * client cannot attempt to influence eligibility.
 */
export const enrollCourseBodySchema = z.object({}).strict().optional();

export type EnrollCourseBody = z.infer<typeof enrollCourseBodySchema>;

/** Shared pagination for `my-courses` and the teacher roster. */
export const enrollmentListQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(ENROLLMENT_PAGE_MAX)
    .default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ENROLLMENT_PAGE_MAX_LIMIT)
    .default(ENROLLMENT_PAGE_DEFAULT_LIMIT),
});

export type EnrollmentListQuery = z.infer<typeof enrollmentListQuerySchema>;
