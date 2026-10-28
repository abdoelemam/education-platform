import { AppError } from '../../errors/index.js';
import { COURSE_ERRORS } from '../courses/course.constants.js';
import { isCourseFree } from '../courses/course.pricing.js';
import {
  courseRepository,
  type CourseRepository,
} from '../courses/course.repository.js';
import {
  lessonRepository,
  type LessonRepository,
} from '../courses/lesson.repository.js';
import {
  sectionRepository,
  type SectionRepository,
} from '../courses/section.repository.js';
import type {
  CatalogInstructor,
  CourseDocument,
} from '../courses/course.types.js';
import {
  progressService,
  type ProgressService,
} from '../progress/progress.service.js';
import {
  userRepository,
  type UserRepository,
} from '../users/user.repository.js';
import type { AuthUser } from '../users/user.types.js';
import { canAccessCourse } from './enrollment.access.js';
import { ENROLLMENT_ERRORS } from './enrollment.constants.js';
import {
  enrollmentRepository,
  type EnrollmentRepository,
} from './enrollment.repository.js';
import {
  toMyCourseSummary,
  toRosterEnrollment,
  toStudentEnrollment,
} from './enrollment.mapper.js';
import type {
  EnrollmentStatusView,
  MyCourseItem,
  PaginatedMyCourses,
  PaginatedRoster,
  RosterStudent,
  StudentEnrollment,
} from './enrollment.types.js';

/**
 * Fallback instructor card when the owning user record is no longer present.
 * Mirrors the public catalog behavior so historical rows still render.
 */
const UNKNOWN_INSTRUCTOR: CatalogInstructor = { name: 'Unknown instructor' };
const UNKNOWN_STUDENT_NAME = 'Unknown student';

export interface EnrollResult {
  enrollment: StudentEnrollment;
  /** True only when this request created the enrollment. */
  created: boolean;
  /**
   * Whether this enrollment currently grants access. A repeated request for a
   * cancelled/expired record returns it unchanged with `hasAccess: false`.
   */
  hasAccess: boolean;
}

export class EnrollmentService {
  constructor(
    private readonly enrollmentRepo: EnrollmentRepository = enrollmentRepository,
    private readonly courseRepo: CourseRepository = courseRepository,
    private readonly sectionRepo: SectionRepository = sectionRepository,
    private readonly lessonRepo: LessonRepository = lessonRepository,
    private readonly userRepo: UserRepository = userRepository,
    private readonly progressSvc: ProgressService = progressService,
  ) {}

  /**
   * Enroll the authenticated student in a published, free course.
   *
   * Eligibility is derived only from server-owned course data. The request body
   * is not consulted, so a client cannot supply a price, payment status, order,
   * enrollment status or timestamps.
   *
   * Paid courses are blocked until verified payment exists. No enrollment is
   * created, and the response reports the price so the client can show a
   * checkout placeholder. Faking a successful payment is never possible here.
   *
   * Idempotency is lifecycle-preserving: a repeated request for an existing
   * cancelled/expired enrollment returns that row unchanged with
   * `created: false`, `hasAccess: false`. Reactivation requires an explicit
   * future lifecycle operation; this endpoint never silently restores access.
   */
  async enroll(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<EnrollResult> {
    const course = await this.requirePublishedCourse(params.courseId);

    if (!isCourseFree(course.priceMinor)) {
      throw new AppError(
        409,
        ENROLLMENT_ERRORS.PAYMENT_REQUIRED,
        'This course requires a verified purchase before enrollment',
        {
          priceMinor: course.priceMinor ?? 0,
          ...(course.currency ? { currency: course.currency } : {}),
        },
      );
    }

    const { enrollment, created } = await this.enrollmentRepo.findOrCreate({
      studentId: params.requester.id,
      courseId: course._id.toString(),
      source: 'free',
    });

    return {
      enrollment: toStudentEnrollment(enrollment),
      created,
      hasAccess: canAccessCourse(enrollment, course.status),
    };
  }

  /**
   * The authenticated student's enrollment status in one published course.
   *
   * Unpublished or unknown courses are reported as not found so their existence
   * is not leaked. A published course the student has not joined returns
   * `{ enrolled: false, hasAccess: false, enrollment: null }`.
   */
  async getEnrollmentStatus(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<EnrollmentStatusView> {
    const course = await this.requirePublishedCourse(params.courseId);

    const enrollment = await this.enrollmentRepo.findByStudentAndCourse(
      params.requester.id,
      params.courseId,
    );

    return {
      // Record existence only. Never treat this as authorization by itself.
      enrolled: enrollment !== null,
      hasAccess: canAccessCourse(enrollment, course.status),
      enrollment: enrollment ? toStudentEnrollment(enrollment) : null,
    };
  }

  /**
   * Paginated list of the student's enrollments with safe course summaries.
   *
   * `progress` is computed by the Progress System from committed,
   * progress-eligible lessons. It is never accepted from a client and never
   * invents a completion percentage. Curriculum counts come from committed
   * sections/lessons only.
   *
   * Published courses cannot be deleted (course deletion is limited to
   * `draft`/`rejected`), so an enrollment cannot normally reference a missing
   * course. The repository query excludes legacy orphans from both the page
   * and the count so pagination metadata always describes the returned set.
   */
  async listMyCourses(params: {
    studentId: string;
    page: number;
    limit: number;
  }): Promise<PaginatedMyCourses> {
    const skip = (params.page - 1) * params.limit;

    const { items, total } = await this.enrollmentRepo.listByStudent(
      params.studentId,
      { skip, limit: params.limit },
    );

    const courseIds = [
      ...new Set(items.map((enrollment) => enrollment.courseId.toString())),
    ];

    const [courses, sectionCounts, lessonCounts, progressByCourse] =
      await Promise.all([
        this.courseRepo.findByIds(courseIds),
        this.sectionRepo.countCommittedByCourseIds(courseIds),
        this.lessonRepo.countCommittedByCourseIds(courseIds),
        this.progressSvc.getCourseSummaries({
          studentId: params.studentId,
          courseIds,
        }),
      ]);

    const coursesById = new Map(
      courses.map((course) => [course._id.toString(), course]),
    );
    const instructors = await this.loadInstructors(courses);

    const data: MyCourseItem[] = [];

    for (const enrollment of items) {
      const course = coursesById.get(enrollment.courseId.toString());
      if (!course) {
        continue;
      }

      const courseId = course._id.toString();
      data.push({
        enrollment: toStudentEnrollment(enrollment),
        course: toMyCourseSummary(
          course,
          instructors.get(course.ownerId.toString()) ?? UNKNOWN_INSTRUCTOR,
          sectionCounts.get(courseId) ?? 0,
          lessonCounts.get(courseId) ?? 0,
        ),
        hasAccess: canAccessCourse(enrollment, course.status),
        progress: progressByCourse.get(courseId) ?? {
          completedLessons: 0,
          totalLessons: 0,
          percent: 0,
        },
      });
    }

    return {
      items: data,
      page: params.page,
      limit: params.limit,
      total,
      totalPages:
        params.limit > 0 ? Math.ceil(total / params.limit) : 0,
    };
  }

  /**
   * Teacher/admin roster for one course.
   *
   * Only the course owner may list its students; admins follow the existing
   * ownership-bypass convention. Student email is deliberately excluded from
   * the response. Approved-teacher enforcement happens in the route middleware.
   */
  async listCourseEnrollments(params: {
    courseId: string;
    requester: AuthUser;
    page: number;
    limit: number;
  }): Promise<PaginatedRoster> {
    await this.requireManagedCourse(params.courseId, params.requester);

    const skip = (params.page - 1) * params.limit;

    const { items, total } = await this.enrollmentRepo.listByCourse(
      params.courseId,
      { skip, limit: params.limit },
    );

    const studentIds = [
      ...new Set(items.map((enrollment) => enrollment.studentId.toString())),
    ];
    const users = await this.userRepo.findPublicByIds(studentIds);
    const usersById = new Map(
      users.map((user) => [user._id.toString(), user]),
    );

    const roster = items.map((enrollment) => {
      const studentId = enrollment.studentId.toString();
      const user = usersById.get(studentId);
      const student: RosterStudent = user
        ? { id: studentId, name: user.name, avatar: user.avatar }
        : { id: studentId, name: UNKNOWN_STUDENT_NAME };

      return toRosterEnrollment(enrollment, student);
    });

    return {
      items: roster,
      page: params.page,
      limit: params.limit,
      total,
      totalPages:
        params.limit > 0 ? Math.ceil(total / params.limit) : 0,
    };
  }

  /**
   * Enrollment requires a currently published course. Draft, in-review,
   * approved-but-unpublished, rejected and archived courses are treated as not
   * found, exactly like the public catalog.
   *
   * `priceMinor` is optional only on legacy published rows created before the
   * publishing phase. The public catalog already renders those as free, so
   * enrollment follows the same rule instead of inventing a price.
   */
  private async requirePublishedCourse(
    courseId: string,
  ): Promise<CourseDocument> {
    const course = await this.courseRepo.findById(courseId);

    if (!course || course.status !== 'published') {
      throw new AppError(404, COURSE_ERRORS.COURSE_NOT_FOUND, 'Course not found');
    }

    return course;
  }

  /**
   * Course management scope: the owner or an admin. This mirrors the existing
   * course-builder ownership rule; admins may inspect a roster for moderation
   * and support without becoming the owner.
   */
  private async requireManagedCourse(
    courseId: string,
    requester: AuthUser,
  ): Promise<CourseDocument> {
    const course = await this.courseRepo.findById(courseId);

    if (!course) {
      throw new AppError(404, COURSE_ERRORS.COURSE_NOT_FOUND, 'Course not found');
    }

    if (requester.role !== 'admin' && course.ownerId.toString() !== requester.id) {
      throw new AppError(
        403,
        COURSE_ERRORS.COURSE_FORBIDDEN,
        'You do not have access to this course',
      );
    }

    return course;
  }

  /** Load only display-safe instructor fields in one query. */
  private async loadInstructors(
    courses: CourseDocument[],
  ): Promise<Map<string, CatalogInstructor>> {
    const ownerIds = [
      ...new Set(courses.map((course) => course.ownerId.toString())),
    ];
    if (ownerIds.length === 0) {
      return new Map();
    }

    const users = await this.userRepo.findPublicByIds(ownerIds);
    return new Map(
      users.map((user) => [
        user._id.toString(),
        { name: user.name, avatar: user.avatar },
      ]),
    );
  }
}

export const enrollmentService = new EnrollmentService();
