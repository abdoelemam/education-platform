import type { CourseStatus } from '../courses/course.types.js';
import type { EnrollmentLike, EnrollmentStatus } from './enrollment.types.js';

/**
 * Enrollment statuses that may grant course access.
 *
 * `completed` retains access so a student can revisit a finished course.
 * `cancelled` and `expired` never grant access.
 */
export const ACCESS_GRANTING_ENROLLMENT_STATUSES = [
  'active',
  'completed',
] as const satisfies readonly EnrollmentStatus[];

const ACCESS_GRANTING_STATUS_SET: ReadonlySet<EnrollmentStatus> = new Set(
  ACCESS_GRANTING_ENROLLMENT_STATUSES,
);

/**
 * Resolve the effective status of an enrollment row.
 *
 * Legacy rows written before `status` existed are normalized from stored data:
 * a completion timestamp means completed, otherwise the row is treated as
 * active. This is the single normalization rule used by both DTO mapping and
 * access checks.
 */
export function resolveEnrollmentStatus(
  enrollment: Pick<EnrollmentLike, 'status' | 'completedAt'>,
): EnrollmentStatus {
  if (enrollment.status) {
    return enrollment.status;
  }

  return enrollment.completedAt ? 'completed' : 'active';
}

export function isAccessGrantingStatus(status: EnrollmentStatus): boolean {
  return ACCESS_GRANTING_STATUS_SET.has(status);
}

/**
 * Authoritative access predicate for course content.
 *
 * This answers whether the enrollment lifecycle and course publication allow
 * access. Callers must still perform the normal request-level
 * authentication/authorization for the protected resource. `enrolled` on its
 * own is never sufficient authorization.
 */
export function canAccessCourse(
  enrollment: Pick<EnrollmentLike, 'status' | 'completedAt'> | null | undefined,
  courseStatus: CourseStatus,
): boolean {
  return (
    courseStatus === 'published' &&
    enrollment != null &&
    isAccessGrantingStatus(resolveEnrollmentStatus(enrollment))
  );
}
