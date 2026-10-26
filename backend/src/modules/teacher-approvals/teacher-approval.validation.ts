import { z } from 'zod';
import {
  TEACHER_REJECTION_REASON_MAX,
  TEACHER_STATUSES,
} from '../users/user.types.js';
import {
  TEACHER_APPROVAL_PAGE_DEFAULT_LIMIT,
  TEACHER_APPROVAL_PAGE_MAX_LIMIT,
} from './teacher-approval.constants.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export const teacherIdParamSchema = z.object({
  teacherId: z
    .string()
    .regex(OBJECT_ID_PATTERN, 'Invalid teacher id'),
});

export type TeacherIdParam = z.infer<typeof teacherIdParamSchema>;

export const listTeacherApplicationsQuerySchema = z.object({
  status: z.enum(TEACHER_STATUSES).default('pending'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(TEACHER_APPROVAL_PAGE_MAX_LIMIT)
    .default(TEACHER_APPROVAL_PAGE_DEFAULT_LIMIT),
});

export type ListTeacherApplicationsQuery = z.infer<
  typeof listTeacherApplicationsQuerySchema
>;

export const rejectTeacherApplicationSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Rejection reason is required')
    .max(
      TEACHER_REJECTION_REASON_MAX,
      `Rejection reason cannot exceed ${TEACHER_REJECTION_REASON_MAX} characters`,
    ),
});

export type RejectTeacherApplicationInput = z.infer<
  typeof rejectTeacherApplicationSchema
>;
