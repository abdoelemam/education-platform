import type { Document, Types } from 'mongoose';
import type {
  CatalogInstructor,
  CourseLevel,
} from '../courses/course.types.js';

/**
 * Enrollment lifecycle.
 *
 * - `active`    the student currently has access (subject to the course still
 *               being published at access time).
 * - `completed` the student finished the course requirements. Set by the
 *               Progress System (Phase 9) through the authoritative backend
 *               completion rule; never accepted from clients.
 * - `cancelled` enrollment revoked by an authorized flow.
 * - `expired`   time-limited access ended.
 *
 * Only `active` is produced by this phase. The remaining values are part of the
 * domain model so later phases can transition an enrollment without a schema
 * migration.
 */
export const ENROLLMENT_STATUSES = [
  'active',
  'completed',
  'cancelled',
  'expired',
] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/**
 * How access was granted. `purchase` is reserved for the Payments phase, when a
 * verified provider webhook creates the order and the enrollment. This phase
 * only creates `free` enrollments.
 */
export const ENROLLMENT_SOURCES = ['free', 'purchase'] as const;
export type EnrollmentSource = (typeof ENROLLMENT_SOURCES)[number];

/**
 * Student ↔ course relationship.
 *
 * The enrollment deliberately stores only relationship and lifecycle state:
 * course metadata, pricing, student profile data, progress counters and payment
 * amounts stay owned by Course, User, Progress (Phase 9) and Order (Phase 12).
 */
export interface IEnrollment {
  studentId: Types.ObjectId;
  courseId: Types.ObjectId;
  status: EnrollmentStatus;
  /** When the student was enrolled. Historical; never recalculated. */
  enrolledAt: Date;
  /** Set together with `status = completed` by authoritative completion logic. */
  completedAt?: Date;
  source: EnrollmentSource;
  /**
   * Order that authorized a paid enrollment. Optional and unused until the
   * Payments phase; there is no Order model yet.
   */
  orderId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnrollmentDocument
  extends IEnrollment,
    Document<Types.ObjectId> {
  _id: Types.ObjectId;
}

/**
 * Runtime shape of an enrollment row as read from MongoDB. `status`,
 * `enrolledAt` and `source` are optional here on purpose: rows written before
 * those fields existed (or inserted by an older/raw writer) are normalized by
 * the mapper instead of requiring a backfill.
 */
export interface EnrollmentLike {
  _id: { toString(): string };
  studentId: { toString(): string };
  courseId: { toString(): string };
  status?: EnrollmentStatus;
  enrolledAt?: Date;
  completedAt?: Date;
  source?: EnrollmentSource;
  orderId?: Types.ObjectId;
  createdAt?: Date;
}

/** Student-facing enrollment representation. */
export interface StudentEnrollment {
  id: string;
  studentId: string;
  courseId: string;
  status: EnrollmentStatus;
  /**
   * Null only for a raw/legacy row that has neither `enrolledAt` nor
   * `createdAt`. The API never fabricates a timestamp.
   */
  enrolledAt: string | null;
  completedAt?: string;
  source: EnrollmentSource;
}

/**
 * Enrollment included in `GET /api/courses/:courseId/enrollment`.
 *
 * `enrolled` describes record existence only. `hasAccess` is the separate
 * lifecycle/publication check; it is still not a substitute for a protected
 * endpoint verifying authentication and authorization.
 */
export interface EnrollmentStatusView {
  enrolled: boolean;
  hasAccess: boolean;
  enrollment: StudentEnrollment | null;
}

/**
 * Safe course summary for a student's own course list. It intentionally omits
 * owner ids, review metadata, category internals and all lesson payloads.
 */
export interface MyCourseSummary {
  id: string;
  title: string;
  slug: string;
  description?: string;
  thumbnailUrl?: string;
  level?: CourseLevel;
  language?: string;
  priceMinor: number;
  currency?: string;
  isFree: boolean;
  publishedAt: string;
  instructor: CatalogInstructor;
  totalSections: number;
  totalLessons: number;
}

export interface MyCourseItem {
  enrollment: StudentEnrollment;
  course: MyCourseSummary;
  /**
   * Convenience flag for the student UI: the enrollment lifecycle grants
   * access and the course is currently published. Protected reads must still
   * enforce this on the backend.
   */
  hasAccess: boolean;
  /**
   * Reserved for the Progress System (Phase 9). It stays `null` until lesson
   * progress exists; the API never fabricates progress numbers.
   */
  progress: null;
}

/** Display-safe student summary for the teacher roster (no email). */
export interface RosterStudent {
  id: string;
  name: string;
  avatar?: string;
}

export interface RosterEnrollment {
  id: string;
  student: RosterStudent;
  status: EnrollmentStatus;
  enrolledAt: string | null;
  completedAt?: string;
  source: EnrollmentSource;
}

export interface PaginatedMyCourses {
  items: MyCourseItem[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedRoster {
  items: RosterEnrollment[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
