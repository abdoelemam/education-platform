import type { CatalogInstructor, CourseDocument } from '../courses/course.types.js';
import { isCourseFree } from '../courses/course.pricing.js';
import { resolveEnrollmentStatus } from './enrollment.access.js';
import type {
  EnrollmentLike,
  EnrollmentSource,
  MyCourseSummary,
  RosterEnrollment,
  RosterStudent,
  StudentEnrollment,
} from './enrollment.types.js';

/**
 * Legacy normalization helpers.
 *
 * Enrollment rows written before `status`/`enrolledAt`/`source` existed (or by a
 * raw writer that bypassed schema defaults) are read without a migration. A
 * missing completion timestamp never invents one, and a missing enrollment
 * timestamp falls back to the document's own creation time.
 *
 * If both enrollment timestamps are absent, `enrolledAt` is exposed as `null`
 * rather than fabricating a date. This is only possible for raw/legacy rows.
 */
function resolveEnrolledAt(enrollment: EnrollmentLike): Date | null {
  return enrollment.enrolledAt ?? enrollment.createdAt ?? null;
}

function resolveSource(enrollment: EnrollmentLike): EnrollmentSource {
  if (enrollment.source) {
    return enrollment.source;
  }

  // A legacy row that already references an order must not be reclassified as
  // free access.
  return enrollment.orderId ? 'purchase' : 'free';
}

export function toStudentEnrollment(
  enrollment: EnrollmentLike,
): StudentEnrollment {
  return {
    id: enrollment._id.toString(),
    studentId: enrollment.studentId.toString(),
    courseId: enrollment.courseId.toString(),
    status: resolveEnrollmentStatus(enrollment),
    enrolledAt: resolveEnrolledAt(enrollment)?.toISOString() ?? null,
    completedAt: enrollment.completedAt?.toISOString(),
    source: resolveSource(enrollment),
  };
}

export function toRosterEnrollment(
  enrollment: EnrollmentLike,
  student: RosterStudent,
): RosterEnrollment {
  return {
    id: enrollment._id.toString(),
    student,
    status: resolveEnrollmentStatus(enrollment),
    enrolledAt: resolveEnrolledAt(enrollment)?.toISOString() ?? null,
    completedAt: enrollment.completedAt?.toISOString(),
    source: resolveSource(enrollment),
  };
}

/**
 * Map a course to the safe summary shown in a student's own course list.
 *
 * Owner ids, review metadata, category internals and lesson payloads are
 * excluded. The service adds the computed `progress` summary alongside this
 * course summary; it is not part of the course document.
 */
export function toMyCourseSummary(
  course: CourseDocument,
  instructor: CatalogInstructor,
  totalSections: number,
  totalLessons: number,
): MyCourseSummary {
  const priceMinor = course.priceMinor ?? 0;

  return {
    id: course._id.toString(),
    title: course.title,
    slug: course.slug,
    description: course.description,
    thumbnailUrl: course.thumbnailUrl,
    level: course.level,
    language: course.language,
    priceMinor,
    currency: course.currency,
    isFree: isCourseFree(course.priceMinor),
    publishedAt: (course.publishedAt ?? course.createdAt).toISOString(),
    instructor,
    totalSections,
    totalLessons,
  };
}
