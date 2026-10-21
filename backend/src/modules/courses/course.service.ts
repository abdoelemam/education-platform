import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { AppError } from '../../errors/index.js';
import { AUTH_ERRORS } from '../auth/auth.constants.js';
import type { AuthUser } from '../users/user.types.js';
import {
  userRepository,
  type UserRepository,
} from '../users/user.repository.js';
import {
  videoRepository,
  type VideoRepository,
} from '../videos/video.repository.js';
import {
  COURSE_DELETABLE_STATUSES,
  COURSE_EDITABLE_STATUSES,
  COURSE_EDIT_LOCK_TTL_MS,
  COURSE_ERRORS,
  COURSE_SLUG_MAX,
  COURSE_SLUG_MAX_ATTEMPTS,
  COURSE_STATUS_TRANSITIONS,
  type CourseErrorCode,
} from './course.constants.js';
import type { CourseEditFence } from './course.fence.js';
import {
  courseRepository,
  type CourseRepository,
  type CourseUpdate,
} from './course.repository.js';
import {
  sectionRepository,
  type SectionRepository,
  type SectionUpdate,
} from './section.repository.js';
import {
  lessonRepository,
  type LessonRepository,
  type LessonUpdate,
} from './lesson.repository.js';
import {
  toCatalogCourse,
  toCatalogCourseDetail,
  toCourseDetail,
  toManagedCourse,
} from './course.mapper.js';
import {
  collectPublishIssues,
  type PublishVideoState,
} from './course.publish-rules.js';
import type {
  CatalogCourse,
  CatalogCourseDetail,
  CatalogInstructor,
  CourseDetail,
  CourseDocument,
  CourseStatus,
  LessonDocument,
  LessonType,
  ManagedCourse,
  SectionDocument,
} from './course.types.js';
import type {
  CreateLessonInput,
  CreateSectionInput,
  UpdateCourseInput,
  UpdateLessonInput,
  UpdateSectionInput,
} from './course.validation.js';

/** Maximum length of the base slug before a uniqueness suffix is appended. */
const SLUG_BASE_MAX = COURSE_SLUG_MAX - 20;

/**
 * Fallback instructor card when the owning user record is no longer present.
 * Publishing requires an owner, but historical catalog rows should still render.
 */
const UNKNOWN_INSTRUCTOR: CatalogInstructor = { name: 'Unknown instructor' };

export interface PaginatedCourses {
  /**
   * Owner/admin course-management items. The public catalog uses the separate
   * `CatalogCourse` mapper, which excludes review and ownership internals.
   */
  items: ManagedCourse[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedCatalog {
  items: CatalogCourse[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface LessonPayload {
  videoId?: string;
  content?: string;
  documentUrl?: string;
  documentName?: string;
}

/**
 * IDs of content rows that existed when a stale takeover began. Rows outside
 * `...Ids` appeared during recovery, and rows in `staged...Ids` had not been
 * committed yet; both are discarded before the new lease starts.
 */
interface ContentSnapshot {
  sectionIds: string[];
  stagedSectionIds: string[];
  lessonIds: string[];
  stagedLessonIds: string[];
}

/**
 * Turn an arbitrary title into a URL-safe ASCII slug. Non-latin titles (for
 * example fully-Arabic titles) produce an empty base; the caller then falls
 * back to a random slug.
 */
function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX);
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Ensure the client's reorder list contains every current item exactly once.
 */
function assertSameIdSet(existingIds: string[], providedIds: string[]): void {
  const existing = new Set(existingIds.map((id) => id.toLowerCase()));
  const seen = new Set<string>();

  const invalid =
    existingIds.length !== providedIds.length ||
    providedIds.some((id) => {
      const normalized = id.toLowerCase();
      if (!existing.has(normalized) || seen.has(normalized)) {
        return true;
      }
      seen.add(normalized);
      return false;
    });

  if (invalid) {
    throw new AppError(
      400,
      COURSE_ERRORS.INVALID_REORDER,
      'The reorder list must include every item exactly once',
    );
  }
}

/**
 * Business rules for the Course Builder.
 *
 * The service owns ownership checks, slug generation, structural ordering and
 * the cross-field rules that keep a lesson consistent with its type. It never
 * trusts a client-supplied owner, status, order or slug.
 */
export class CourseService {
  constructor(
    private readonly courseRepo: CourseRepository = courseRepository,
    private readonly sectionRepo: SectionRepository = sectionRepository,
    private readonly lessonRepo: LessonRepository = lessonRepository,
    private readonly videoRepo: VideoRepository = videoRepository,
    private readonly userRepo: UserRepository = userRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Course
  // -------------------------------------------------------------------------

  async createCourse(params: {
    ownerId: string;
    input: { title: string; description?: string };
  }): Promise<CourseDetail> {
    const base = slugify(params.input.title) || `course-${randomBytes(4).toString('hex')}`;

    for (let attempt = 0; attempt <= COURSE_SLUG_MAX_ATTEMPTS; attempt += 1) {
      const slug =
        attempt === 0
          ? base.slice(0, COURSE_SLUG_MAX)
          : `${base.slice(0, SLUG_BASE_MAX)}-${attempt + 1}`;

      try {
        const course = await this.courseRepo.create({
          ownerId: params.ownerId,
          title: params.input.title,
          slug,
          description: params.input.description,
        });

        return toCourseDetail(course, [], []);
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
      }
    }

    // Practically unreachable: every numbered suffix collided.
    const course = await this.courseRepo.create({
      ownerId: params.ownerId,
      title: params.input.title,
      slug: `${base.slice(0, SLUG_BASE_MAX)}-${randomBytes(4).toString('hex')}`,
      description: params.input.description,
    });

    return toCourseDetail(course, [], []);
  }

  async listCourses(params: {
    ownerId: string;
    page: number;
    limit: number;
  }): Promise<PaginatedCourses> {
    const skip = (params.page - 1) * params.limit;
    const { items, total } = await this.courseRepo.listByOwner({
      ownerId: params.ownerId,
      skip,
      limit: params.limit,
    });

    return {
      items: items.map(toManagedCourse),
      page: params.page,
      limit: params.limit,
      total,
      totalPages: params.limit > 0 ? Math.ceil(total / params.limit) : 0,
    };
  }

  async getCourse(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<CourseDetail> {
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
    return this.buildDetail(course);
  }

  async updateCourse(params: {
    courseId: string;
    requester: AuthUser;
    input: UpdateCourseInput;
  }): Promise<CourseDetail> {
    return this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_EDITABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
      'edited',
      async (course, fence) => {
        const update: CourseUpdate = {};
        const unset: string[] = [];

        if (params.input.title !== undefined) {
          update.title = params.input.title;
          // The slug is a stable identifier and is intentionally not regenerated.
        }

        if (params.input.description !== undefined) {
          if (params.input.description === '') {
            unset.push('description');
          } else {
            update.description = params.input.description;
          }
        }

        if (params.input.thumbnailUrl !== undefined) {
          if (params.input.thumbnailUrl === null) {
            unset.push('thumbnailUrl');
          } else {
            update.thumbnailUrl = params.input.thumbnailUrl;
          }
        }

        if (params.input.level !== undefined) {
          if (params.input.level === null) {
            unset.push('level');
          } else {
            update.level = params.input.level;
          }
        }

        if (params.input.language !== undefined) {
          if (params.input.language === null) {
            unset.push('language');
          } else {
            update.language = params.input.language;
          }
        }

        if (params.input.learningOutcomes !== undefined) {
          update.learningOutcomes = params.input.learningOutcomes;
        }

        if (params.input.requirements !== undefined) {
          update.requirements = params.input.requirements;
        }

        if (params.input.priceMinor !== undefined) {
          if (params.input.priceMinor === null) {
            unset.push('priceMinor', 'currency');
          } else {
            update.priceMinor = params.input.priceMinor;
            // Zod guarantees both fields are present together.
            update.currency = params.input.currency ?? undefined;
          }
        }

        const updated = await this.courseRepo.updateById(
          course._id.toString(),
          update,
          unset,
          fence,
        );

        if (!updated) {
          // The course was deleted or the lease expired/was replaced between
          // request start and this write.
          throw this.editInProgressError();
        }

        return this.buildDetail(updated);
      },
    );
  }

  /**
   * Delete a draft or rejected course and cascade to its content.
   *
   * Courses under review or already approved are intentionally not deletable:
   * deletion would silently withdraw a submission or remove reviewed content.
   * An admin must reject a pending course before the owner can clean it up; an
   * explicit withdrawal flow is a future feature.
   */
  async deleteCourse(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<void> {
    await this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_DELETABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_DELETABLE,
      'deleted',
      async (course, fence) => {
        const courseId = course._id.toString();

        // The fenced course delete is the authorization commit. Only after it
        // succeeds do we clean up the now-unreachable content, even if the
        // lease expires while the cascade is still running.
        const deleted = await this.courseRepo.deleteById(courseId, fence);
        if (!deleted) {
          throw this.editInProgressError();
        }

        // Cascade to content. Videos are independent assets that may be reused
        // by other lessons, so they are never deleted here. This cleanup is
        // intentionally parent-first and not transactional: if it fails after
        // the course is gone, the remaining rows are unreachable orphans rather
        // than visible partial content. See docs/course-builder.md.
        await this.lessonRepo.deleteByCourse(courseId);
        await this.sectionRepo.deleteByCourse(courseId);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Teacher Workflow (submission + admin review)
  // -------------------------------------------------------------------------

  /**
   * Owner submits a `draft` or `rejected` course for admin review.
   *
   * Only the owner may submit: an admin cannot submit on a teacher's behalf,
   * because submission is the owner's declaration that the content is ready.
   */
  async submitCourse(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<CourseDetail> {
    const course = await this.requireCourseOwner(
      params.courseId,
      params.requester,
    );
    this.assertTransition(course.status, 'pending_review');

    // A new submission replaces the previous review outcome. The transition is
    // conditional on the edit lease being free: if a content write claimed the
    // lease just before this request, submission fails rather than freezing a
    // version that is still being written.
    const updated = await this.transitionToPendingReview(course);
    return this.buildDetail(updated);
  }

  /**
   * Admin moderation queue. Defaults to `pending_review` at the route layer;
   * any status can be requested for history views.
   */
  async listCoursesForReview(params: {
    requester: AuthUser;
    status: CourseStatus;
    page: number;
    limit: number;
  }): Promise<PaginatedCourses> {
    this.assertAdmin(params.requester);

    const skip = (params.page - 1) * params.limit;
    const { items, total } = await this.courseRepo.listByStatus({
      status: params.status,
      skip,
      limit: params.limit,
    });

    return {
      items: items.map(toManagedCourse),
      page: params.page,
      limit: params.limit,
      total,
      totalPages: params.limit > 0 ? Math.ceil(total / params.limit) : 0,
    };
  }

  /**
   * Full course content for a reviewing admin, regardless of owner.
   */
  async getCourseForReview(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<CourseDetail> {
    this.assertAdmin(params.requester);
    const course = await this.requireCourse(params.courseId);
    return this.buildDetail(course);
  }

  /**
   * Admin approves a `pending_review` submission. Approval is a review
   * outcome, not publication: the owner must publish separately (`approved` →
   * `published`).
   */
  async approveCourse(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<CourseDetail> {
    this.assertAdmin(params.requester);
    const course = await this.requireCourse(params.courseId);
    this.assertTransition(course.status, 'approved');

    const updated = await this.courseRepo.transitionStatus(
      course._id.toString(),
      [course.status],
      {
        status: 'approved',
        reviewedAt: new Date(),
        reviewedBy: new Types.ObjectId(params.requester.id),
      },
      ['rejectionReason'],
      this.submissionGuard(course),
    );

    if (!updated) {
      throw this.concurrentTransitionError();
    }

    return this.buildDetail(updated);
  }

  /**
   * Admin rejects a `pending_review` submission. The reason is required and is
   * returned to the owner; it is cleared when the owner resubmits.
   */
  async rejectCourse(params: {
    courseId: string;
    requester: AuthUser;
    reason: string;
  }): Promise<CourseDetail> {
    this.assertAdmin(params.requester);
    const course = await this.requireCourse(params.courseId);
    this.assertTransition(course.status, 'rejected');

    const updated = await this.courseRepo.transitionStatus(
      course._id.toString(),
      [course.status],
      {
        status: 'rejected',
        reviewedAt: new Date(),
        reviewedBy: new Types.ObjectId(params.requester.id),
        rejectionReason: params.reason,
      },
      [],
      this.submissionGuard(course),
    );

    if (!updated) {
      throw this.concurrentTransitionError();
    }

    return this.buildDetail(updated);
  }

  // -------------------------------------------------------------------------
  // Publishing + public catalog
  // -------------------------------------------------------------------------

  /**
   * Owner publishes an approved course.
   *
   * Approval is a review outcome; publication is a separate owner decision.
   * Publishing validates completeness against committed content only, requires
   * the content-edit lease to be free, and transitions with a compare-and-set so
   * a stale request cannot publish a later or already-published state.
   */
  async publishCourse(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<CourseDetail> {
    const course = await this.requireCourseOwner(params.courseId, params.requester);
    this.assertTransition(course.status, 'published');

    if (course.editLocked && !this.isEditLockStale(course)) {
      throw this.editInProgressError();
    }

    const courseId = course._id.toString();
    const [sections, lessons] = await Promise.all([
      this.sectionRepo.listByCourse(courseId),
      this.lessonRepo.listByCourse(courseId),
    ]);
    const videos = await this.loadPublishVideoStates(lessons);

    const issues = collectPublishIssues({
      course,
      sections,
      lessons,
      videos,
    });

    if (issues.length > 0) {
      throw new AppError(
        422,
        COURSE_ERRORS.COURSE_NOT_PUBLISHABLE,
        'The course does not meet the publishing requirements',
        { reasons: issues },
      );
    }

    const published = await this.transitionToPublished(course);

    return this.buildDetail(published);
  }

  /**
   * Public catalog: published courses only, newest publication first.
   */
  async listPublishedCourses(params: {
    page: number;
    limit: number;
  }): Promise<PaginatedCatalog> {
    const skip = (params.page - 1) * params.limit;
    const { items, total } = await this.courseRepo.listPublished({
      skip,
      limit: params.limit,
    });
    const instructors = await this.loadInstructors(items);

    return {
      items: items.map((course) =>
        toCatalogCourse(
          course,
          instructors.get(course.ownerId.toString()) ?? UNKNOWN_INSTRUCTOR,
        ),
      ),
      page: params.page,
      limit: params.limit,
      total,
      totalPages: params.limit > 0 ? Math.ceil(total / params.limit) : 0,
    };
  }

  /**
   * Public course detail by slug. Non-published courses are reported as not
   * found so their existence is not leaked.
   */
  async getPublishedCourseBySlug(slug: string): Promise<CatalogCourseDetail> {
    const course = await this.courseRepo.findPublishedBySlug(slug);
    if (!course) {
      throw new AppError(404, COURSE_ERRORS.COURSE_NOT_FOUND, 'Course not found');
    }

    const courseId = course._id.toString();
    const [sections, lessons, instructors] = await Promise.all([
      this.sectionRepo.listByCourse(courseId),
      this.lessonRepo.listByCourse(courseId),
      this.loadInstructors([course]),
    ]);

    return toCatalogCourseDetail(
      course,
      instructors.get(course.ownerId.toString()) ?? UNKNOWN_INSTRUCTOR,
      sections,
      lessons,
    );
  }

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------

  async addSection(params: {
    courseId: string;
    requester: AuthUser;
    input: CreateSectionInput;
  }): Promise<CourseDetail> {
    return this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_EDITABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
      'edited',
      async (course, fence) => {
        const courseId = course._id.toString();
        const order = (await this.sectionRepo.maxOrder(courseId)) + 1;

        const created = await this.sectionRepo.create(
          {
            courseId,
            title: params.input.title,
            description: params.input.description,
            order,
          },
          fence,
        );
        const authorized = await this.courseRepo.beginContentCommit(
          courseId,
          fence,
        );
        if (!authorized) {
          throw this.editInProgressError();
        }
        const committed = await this.sectionRepo.commitCreated(
          created._id.toString(),
          fence,
        );
        if (!committed) {
          throw this.editInProgressError();
        }

        return this.buildDetail(course);
      },
    );
  }

  async updateSection(params: {
    courseId: string;
    sectionId: string;
    requester: AuthUser;
    input: UpdateSectionInput;
  }): Promise<CourseDetail> {
    return this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_EDITABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
      'edited',
      async (course, fence) => {
        const section = await this.requireSection(
          course._id.toString(),
          params.sectionId,
        );

        const update: SectionUpdate = {};
        const unset: string[] = [];

        if (params.input.title !== undefined) {
          update.title = params.input.title;
        }

        if (params.input.description !== undefined) {
          if (params.input.description === '') {
            unset.push('description');
          } else {
            update.description = params.input.description;
          }
        }

        const updated = await this.sectionRepo.updateById(
          section._id.toString(),
          update,
          unset,
          fence,
        );
        if (!updated) {
          throw this.editInProgressError();
        }

        return this.buildDetail(course);
      },
    );
  }

  async deleteSection(params: {
    courseId: string;
    sectionId: string;
    requester: AuthUser;
  }): Promise<CourseDetail> {
    return this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_EDITABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
      'edited',
      async (course, fence) => {
        const section = await this.requireSection(
          course._id.toString(),
          params.sectionId,
        );

        // The fenced section delete is the authorization commit. Lesson
        // cleanup follows only if it succeeds, even if the lease expires
        // during the cascade.
        const deleted = await this.sectionRepo.deleteById(
          section._id.toString(),
          fence,
        );
        if (!deleted) {
          throw this.editInProgressError();
        }

        // Lessons belong to the section; deleting it cascades to them.
        await this.lessonRepo.deleteBySection(section._id.toString());

        return this.buildDetail(course);
      },
    );
  }

  async reorderSections(params: {
    courseId: string;
    requester: AuthUser;
    sectionIds: string[];
  }): Promise<CourseDetail> {
    return this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_EDITABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
      'edited',
      async (course, fence) => {
        const courseId = course._id.toString();
        const sections = await this.sectionRepo.listByCourse(courseId);
        assertSameIdSet(
          sections.map((section) => section._id.toString()),
          params.sectionIds,
        );

        const reordered = await this.sectionRepo.updateOrders(
          courseId,
          params.sectionIds.map((id, index) => ({ id, order: index + 1 })),
          fence,
        );
        if (!reordered) {
          throw this.editInProgressError();
        }

        return this.buildDetail(course);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Lessons
  // -------------------------------------------------------------------------

  async addLesson(params: {
    courseId: string;
    sectionId: string;
    requester: AuthUser;
    input: CreateLessonInput;
  }): Promise<CourseDetail> {
    return this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_EDITABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
      'edited',
      async (course, fence) => {
        const section = await this.requireSection(
          course._id.toString(),
          params.sectionId,
        );

        const payload = await this.resolveCreatePayload(course, params.input);
        const order =
          (await this.lessonRepo.maxOrder(section._id.toString())) + 1;

        const created = await this.lessonRepo.create(
          {
            courseId: course._id.toString(),
            sectionId: section._id.toString(),
            title: params.input.title,
            description: params.input.description,
            type: params.input.type,
            order,
            ...payload,
          },
          fence,
        );
        const authorized = await this.courseRepo.beginContentCommit(
          course._id.toString(),
          fence,
        );
        if (!authorized) {
          throw this.editInProgressError();
        }
        const committed = await this.lessonRepo.commitCreated(
          created._id.toString(),
          fence,
        );
        if (!committed) {
          throw this.editInProgressError();
        }

        return this.buildDetail(course);
      },
    );
  }

  async updateLesson(params: {
    courseId: string;
    sectionId: string;
    lessonId: string;
    requester: AuthUser;
    input: UpdateLessonInput;
  }): Promise<CourseDetail> {
    return this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_EDITABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
      'edited',
      async (course, fence) => {
        const section = await this.requireSection(
          course._id.toString(),
          params.sectionId,
        );
        const lesson = await this.requireLesson(
          course._id.toString(),
          section._id.toString(),
          params.lessonId,
        );

        const update: LessonUpdate = {};
        const unset: string[] = [];

        if (params.input.title !== undefined) {
          update.title = params.input.title;
        }

        if (params.input.description !== undefined) {
          if (params.input.description === '') {
            unset.push('description');
          } else {
            update.description = params.input.description;
          }
        }

        const effectiveType: LessonType = params.input.type ?? lesson.type;

        if (effectiveType === 'quiz') {
          throw new AppError(
            400,
            COURSE_ERRORS.LESSON_TYPE_UNSUPPORTED,
            'Quiz lessons are not supported yet',
          );
        }

        if (
          params.input.type !== undefined &&
          params.input.type !== lesson.type
        ) {
          update.type = params.input.type;
        }

        // Type-specific payloads must match the effective type. This rejects
        // conflicting updates such as sending `videoId` to a text lesson.
        if (params.input.videoId !== undefined && effectiveType !== 'video') {
          throw this.invalidPayload('videoId is only valid for video lessons');
        }
        if (params.input.content !== undefined && effectiveType !== 'text') {
          throw this.invalidPayload('content is only valid for text lessons');
        }
        if (
          (params.input.documentUrl !== undefined ||
            params.input.documentName !== undefined) &&
          effectiveType !== 'document'
        ) {
          throw this.invalidPayload(
            'Document fields are only valid for document lessons',
          );
        }

        if (effectiveType === 'video') {
          if (params.input.videoId !== undefined) {
            update.videoId = await this.resolveLessonVideo(
              course,
              params.input.videoId,
            );
          } else if (lesson.type !== 'video') {
            throw this.missingPayload('A video lesson requires a videoId');
          }
          unset.push('content', 'documentUrl', 'documentName');
        } else if (effectiveType === 'text') {
          if (params.input.content !== undefined) {
            update.content = params.input.content;
          } else if (lesson.type !== 'text') {
            throw this.missingPayload('A text lesson requires content');
          }
          unset.push('videoId', 'documentUrl', 'documentName');
        } else {
          if (params.input.documentUrl !== undefined) {
            update.documentUrl = params.input.documentUrl;
          } else if (lesson.type !== 'document') {
            throw this.missingPayload(
              'A document lesson requires a documentUrl',
            );
          }
          if (params.input.documentName !== undefined) {
            update.documentName = params.input.documentName;
          }
          unset.push('videoId', 'content');
        }

        const updated = await this.lessonRepo.updateById(
          lesson._id.toString(),
          update,
          unset,
          fence,
        );

        if (!updated) {
          throw this.editInProgressError();
        }

        return this.buildDetail(course);
      },
    );
  }

  async deleteLesson(params: {
    courseId: string;
    sectionId: string;
    lessonId: string;
    requester: AuthUser;
  }): Promise<CourseDetail> {
    return this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_EDITABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
      'edited',
      async (course, fence) => {
        const section = await this.requireSection(
          course._id.toString(),
          params.sectionId,
        );
        const lesson = await this.requireLesson(
          course._id.toString(),
          section._id.toString(),
          params.lessonId,
        );

        const deleted = await this.lessonRepo.deleteById(
          lesson._id.toString(),
          fence,
        );
        if (!deleted) {
          throw this.editInProgressError();
        }

        return this.buildDetail(course);
      },
    );
  }

  async reorderLessons(params: {
    courseId: string;
    sectionId: string;
    requester: AuthUser;
    lessonIds: string[];
  }): Promise<CourseDetail> {
    return this.withCourseMutationLock(
      params.courseId,
      params.requester,
      COURSE_EDITABLE_STATUSES,
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
      'edited',
      async (course, fence) => {
        const section = await this.requireSection(
          course._id.toString(),
          params.sectionId,
        );

        const lessons = await this.lessonRepo.listBySection(
          section._id.toString(),
        );
        assertSameIdSet(
          lessons.map((lesson) => lesson._id.toString()),
          params.lessonIds,
        );

        const reordered = await this.lessonRepo.updateOrders(
          section._id.toString(),
          params.lessonIds.map((id, index) => ({ id, order: index + 1 })),
          fence,
        );
        if (!reordered) {
          throw this.editInProgressError();
        }

        return this.buildDetail(course);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async buildDetail(course: CourseDocument): Promise<CourseDetail> {
    const courseId = course._id.toString();
    const [sections, lessons] = await Promise.all([
      this.sectionRepo.listByCourse(courseId),
      this.lessonRepo.listByCourse(courseId),
    ]);

    return toCourseDetail(course, sections, lessons);
  }

  private async requireCourse(courseId: string): Promise<CourseDocument> {
    const course = await this.courseRepo.findById(courseId);

    if (!course) {
      throw new AppError(404, COURSE_ERRORS.COURSE_NOT_FOUND, 'Course not found');
    }

    return course;
  }

  private async requireOwnedCourse(
    courseId: string,
    requester: AuthUser,
  ): Promise<CourseDocument> {
    const course = await this.requireCourse(courseId);

    if (requester.role !== 'admin' && course.ownerId.toString() !== requester.id) {
      throw new AppError(
        403,
        COURSE_ERRORS.COURSE_FORBIDDEN,
        'You do not have access to this course',
      );
    }

    return course;
  }

  /**
   * Serialize a content mutation with submission/review.
   *
   * Ownership and the status rule are checked first for precise errors; the
   * database lease is then claimed atomically. Submission requires the lease to
   * be free, so an edit that started just before submission either completes
   * before the submission or prevents it with COURSE_EDIT_IN_PROGRESS.
   */
  private async withCourseMutationLock<T>(
    courseId: string,
    requester: AuthUser,
    allowedStatuses: readonly CourseStatus[],
    statusErrorCode: CourseErrorCode,
    action: 'edited' | 'deleted',
    operation: (course: CourseDocument, fence: CourseEditFence) => Promise<T>,
  ): Promise<T> {
    const course = await this.requireOwnedCourse(courseId, requester);
    this.assertStatusAllowed(course, allowedStatuses, statusErrorCode, action);

    const locked = await this.acquireContentLock(
      courseId,
      requester,
      allowedStatuses,
      statusErrorCode,
      action,
    );
    const fence = this.requireEditFence(locked);

    try {
      return await operation(locked, fence);
    } finally {
      await this.courseRepo.releaseEditLock(
        locked._id.toString(),
        fence.token,
      );
    }
  }

  private async acquireContentLock(
    courseId: string,
    requester: AuthUser,
    allowedStatuses: readonly CourseStatus[],
    statusErrorCode: CourseErrorCode,
    action: 'edited' | 'deleted',
  ): Promise<CourseDocument> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.requireOwnedCourse(courseId, requester);
      this.assertStatusAllowed(
        current,
        allowedStatuses,
        statusErrorCode,
        action,
      );

      if (!current.editLocked) {
        const locked = await this.claimContentLock(courseId, allowedStatuses);
        if (locked) {
          return locked;
        }
        // Another request acquired the lease between the read and the claim.
        continue;
      }

      if (!this.isEditLockStale(current)) {
        throw this.editInProgressError();
      }

      // Snapshot what existed before recovery. A stale holder that is still
      // running can create rows during the takeover; anything outside this
      // snapshot is abandoned, and rows staged at snapshot time are discarded
      // even if the old holder flips them to committed before cleanup runs.
      const snapshot = await this.captureContentSnapshot(courseId);

      const cleared = await this.courseRepo.clearStaleEditLock(
        courseId,
        allowedStatuses,
        this.editLockCutoff(),
      );
      if (!cleared) {
        // Another request refreshed or released the lease; re-evaluate.
        continue;
      }

      const locked = await this.claimContentLock(
        courseId,
        allowedStatuses,
        snapshot,
      );
      if (locked) {
        return locked;
      }
    }

    throw this.editInProgressError();
  }

  private async claimContentLock(
    courseId: string,
    allowedStatuses: readonly CourseStatus[],
    snapshot?: ContentSnapshot,
  ): Promise<CourseDocument | null> {
    const locked = await this.courseRepo.acquireEditLock(
      courseId,
      allowedStatuses,
    );
    if (!locked) {
      return null;
    }

    try {
      await this.initializeContentFence(locked, snapshot);
    } catch (error) {
      if (locked.editLockToken) {
        await this.courseRepo.releaseEditLock(courseId, locked.editLockToken);
      }
      throw error;
    }

    return locked;
  }

  private async captureContentSnapshot(
    courseId: string,
  ): Promise<ContentSnapshot> {
    const sectionIds = await this.sectionRepo.listIdsByCourse(courseId);
    const lessonIds = await this.lessonRepo.listIdsByCourse(courseId);
    const [stagedSectionIds, stagedLessonIds] = await Promise.all([
      this.sectionRepo.listStagedIdsByCourse(courseId),
      this.lessonRepo.listStagedIdsByCourse(courseId),
    ]);

    return {
      sectionIds,
      stagedSectionIds,
      lessonIds,
      stagedLessonIds,
    };
  }

  /**
   * Move the content collections onto a newly acquired lease. Writes are only
   * allowed after every existing content document has the new token and expiry,
   * and abandoned/recovered creates have been removed.
   */
  private async initializeContentFence(
    course: CourseDocument,
    snapshot?: ContentSnapshot,
  ): Promise<void> {
    const fence = this.requireEditFence(course);
    const courseId = course._id.toString();

    if (snapshot) {
      await this.sectionRepo.removeStaleForTakeover(
        courseId,
        snapshot.sectionIds,
        snapshot.stagedSectionIds,
      );
      await this.lessonRepo.removeStaleForTakeover(
        courseId,
        snapshot.lessonIds,
        snapshot.stagedLessonIds,
      );
    } else {
      await this.sectionRepo.deleteStagedByCourse(courseId);
      await this.lessonRepo.deleteStagedByCourse(courseId);
    }

    await this.sectionRepo.refreshLease(courseId, fence.token, fence.expiresAt);
    await this.lessonRepo.refreshLease(courseId, fence.token, fence.expiresAt);
  }

  private requireEditFence(course: CourseDocument): CourseEditFence {
    if (!course.editLockToken || !course.editLeaseExpiresAt) {
      throw this.editInProgressError();
    }

    return {
      token: course.editLockToken,
      expiresAt: course.editLeaseExpiresAt,
    };
  }

  /**
   * Move an approved course to `published` with a compare-and-set that also
   * requires the content-edit lease to be free. Stale leases are recovered the
   * same way as submission, so a crash cannot block publishing forever.
   */
  private async transitionToPublished(
    course: CourseDocument,
  ): Promise<CourseDocument> {
    const courseId = course._id.toString();
    const fromStatus = course.status;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const updated = await this.courseRepo.transitionStatusIfIdle(
        courseId,
        [fromStatus],
        {
          status: 'published',
          publishedAt: new Date(),
        },
        [],
        this.submissionGuard(course),
      );

      if (updated) {
        return updated;
      }

      const current = await this.requireCourse(courseId);

      if (
        current.status !== fromStatus ||
        this.submissionIdentityChanged(course, current)
      ) {
        throw this.concurrentTransitionError();
      }

      if (!current.editLocked) {
        continue;
      }

      if (!this.isEditLockStale(current)) {
        throw this.editInProgressError();
      }

      const cleared = await this.courseRepo.clearStaleEditLock(
        courseId,
        [fromStatus],
        this.editLockCutoff(),
      );
      if (!cleared) {
        continue;
      }
    }

    throw this.editInProgressError();
  }

  /**
   * Resolve every video referenced by the course. Missing or foreign videos are
   * left out of the map so the readiness rules report VIDEO_NOT_READY.
   */
  private async loadPublishVideoStates(
    lessons: LessonDocument[],
  ): Promise<Map<string, PublishVideoState>> {
    const videoIds = [
      ...new Set(
        lessons
          .filter((lesson) => lesson.type === 'video' && lesson.videoId)
          .map((lesson) => lesson.videoId!.toString()),
      ),
    ];

    const states = new Map<string, PublishVideoState>();
    const videos = await Promise.all(
      videoIds.map((videoId) => this.videoRepo.findById(videoId)),
    );

    for (const video of videos) {
      if (!video) {
        continue;
      }
      states.set(video._id.toString(), {
        ownerId: video.ownerId.toString(),
        processingStatus: video.processingStatus,
        playbackUrl: video.playbackUrl,
      });
    }

    return states;
  }

  /**
   * Load only display-safe instructor fields for catalog rows.
   */
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

  /**
   * Move a draft or rejected course to `pending_review`, but only while no
   * content edit is in flight. A concurrent submission or status change is
   * reported as a conflict rather than retried blindly, which prevents a stale
   * submit request from resubmitting a version the owner has not seen.
   */
  private async transitionToPendingReview(
    course: CourseDocument,
  ): Promise<CourseDocument> {    const courseId = course._id.toString();
    const fromStatus = course.status;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const updated = await this.courseRepo.transitionStatusIfIdle(
        courseId,
        [fromStatus],
        {
          status: 'pending_review',
          submittedAt: this.nextSubmissionTime(course),
        },
        ['reviewedAt', 'reviewedBy', 'rejectionReason'],
        this.submissionGuard(course),
      );

      if (updated) {
        return updated;
      }

      const current = await this.requireCourse(courseId);

      if (current.status !== fromStatus) {
        throw this.concurrentTransitionError();
      }

      if (!current.editLocked) {
        // The lease may simply have been released by the competing edit
        // between the failed transition and this read. Only treat the request
        // as stale if the submission identity changed; otherwise retry the
        // transition so a normal edit/submit race does not turn into a bogus
        // INVALID_STATUS_TRANSITION error.
        if (this.submissionIdentityChanged(course, current)) {
          throw this.concurrentTransitionError();
        }
        continue;
      }

      if (!this.isEditLockStale(current)) {
        throw this.editInProgressError();
      }

      const cleared = await this.courseRepo.clearStaleEditLock(
        courseId,
        [fromStatus],
        this.editLockCutoff(),
      );
      if (!cleared) {
        // Another request changed the lease; re-evaluate on the next pass.
        continue;
      }
    }

    throw this.editInProgressError();
  }

  /**
   * Pin a review decision to the submission the admin actually loaded. Without
   * this, an approve/reject request that read submission S1 could win the CAS
   * after the owner was rejected and resubmitted S2, silently reviewing content
   * the admin never saw.
   */
  private submissionGuard(course: CourseDocument): Record<string, unknown> {
    return course.submittedAt
      ? { submittedAt: course.submittedAt }
      : { submittedAt: { $exists: false } };
  }

  /**
   * Compare the submission a request loaded with the one currently stored.
   * `submittedAt` is strictly increasing per course, so a difference means a
   * newer submission won the race.
   */
  private submissionIdentityChanged(
    loaded: CourseDocument,
    current: CourseDocument,
  ): boolean {
    return loaded.submittedAt?.getTime() !== current.submittedAt?.getTime();
  }

  /**
   * Keep submission timestamps strictly increasing per course. This makes
   * `submittedAt` a reliable submission identity even if two submissions occur
   * within the same clock millisecond.
   */
  private nextSubmissionTime(course: CourseDocument): Date {
    const previous = course.submittedAt?.getTime() ?? 0;
    return new Date(Math.max(Date.now(), previous + 1));
  }

  private isEditLockStale(course: CourseDocument): boolean {
    if (!course.editLocked) {
      return false;
    }

    if (course.editLeaseExpiresAt) {
      return course.editLeaseExpiresAt.getTime() <= Date.now();
    }

    // Legacy leases acquired before `editLeaseExpiresAt` existed.
    if (!course.editLockedAt) {
      return true;
    }
    return Date.now() - course.editLockedAt.getTime() > COURSE_EDIT_LOCK_TTL_MS;
  }

  private editLockCutoff(): Date {
    return new Date(Date.now() - COURSE_EDIT_LOCK_TTL_MS);
  }

  private editInProgressError(): AppError {
    return new AppError(
      409,
      COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS,
      'A content edit is in progress; reload and retry',
    );
  }

  /**
   * Publishing is strictly an owner action; the admin ownership bypass does not
   * apply here (nor to submission).
   */
  private async requireCourseOwner(
    courseId: string,
    requester: AuthUser,
  ): Promise<CourseDocument> {
    const course = await this.requireCourse(courseId);

    if (course.ownerId.toString() !== requester.id) {
      throw new AppError(
        403,
        COURSE_ERRORS.COURSE_FORBIDDEN,
        'Only the course owner can perform this action',
      );
    }

    return course;
  }

  private assertAdmin(requester: AuthUser): void {
    if (requester.role !== 'admin') {
      throw new AppError(403, AUTH_ERRORS.FORBIDDEN, 'Admin access required');
    }
  }

  private assertTransition(from: CourseStatus, to: CourseStatus): void {
    if (!COURSE_STATUS_TRANSITIONS[from].includes(to)) {
      throw new AppError(
        409,
        COURSE_ERRORS.INVALID_STATUS_TRANSITION,
        `A course in "${from}" status cannot be transitioned to "${to}"`,
      );
    }
  }

  private assertStatusAllowed(
    course: CourseDocument,
    allowedStatuses: readonly CourseStatus[],
    errorCode: CourseErrorCode,
    action: 'edited' | 'deleted',
  ): void {
    if (!allowedStatuses.includes(course.status)) {
      throw new AppError(
        409,
        errorCode,
        `A course in "${course.status}" status cannot be ${action}`,
      );
    }
  }

  private concurrentTransitionError(): AppError {
    return new AppError(
      409,
      COURSE_ERRORS.INVALID_STATUS_TRANSITION,
      'The course status changed while processing this request; reload and retry',
    );
  }

  private async requireSection(
    courseId: string,
    sectionId: string,
  ): Promise<SectionDocument> {
    const section = await this.sectionRepo.findByCourseAndId(courseId, sectionId);

    if (!section) {
      throw new AppError(404, COURSE_ERRORS.SECTION_NOT_FOUND, 'Section not found');
    }

    return section;
  }

  private async requireLesson(
    courseId: string,
    sectionId: string,
    lessonId: string,
  ): Promise<LessonDocument> {
    const lesson = await this.lessonRepo.findBySectionAndId(
      courseId,
      sectionId,
      lessonId,
    );

    if (!lesson) {
      throw new AppError(404, COURSE_ERRORS.LESSON_NOT_FOUND, 'Lesson not found');
    }

    return lesson;
  }

  private async resolveCreatePayload(
    course: CourseDocument,
    input: CreateLessonInput,
  ): Promise<LessonPayload> {
    if (input.type === 'video') {
      return { videoId: await this.resolveLessonVideo(course, input.videoId) };
    }

    if (input.type === 'text') {
      return { content: input.content };
    }

    if (input.type === 'document') {
      return { documentUrl: input.documentUrl, documentName: input.documentName };
    }

    throw new AppError(
      400,
      COURSE_ERRORS.LESSON_TYPE_UNSUPPORTED,
      'Quiz lessons are not supported yet',
    );
  }

  /**
   * A lesson may only reference a video owned by the course owner, so a lesson
   * can never expose (or depend on) another teacher's asset. Readiness is not
   * required here: the video system gates playback independently.
   */
  private async resolveLessonVideo(
    course: CourseDocument,
    videoId: string,
  ): Promise<string> {
    const video = await this.videoRepo.findById(videoId);

    if (!video) {
      throw new AppError(
        404,
        COURSE_ERRORS.LESSON_VIDEO_NOT_FOUND,
        'Video not found',
      );
    }

    if (video.ownerId.toString() !== course.ownerId.toString()) {
      throw new AppError(
        403,
        COURSE_ERRORS.LESSON_VIDEO_FORBIDDEN,
        'The video does not belong to the course owner',
      );
    }

    return video._id.toString();
  }

  private missingPayload(message: string): AppError {
    return new AppError(422, COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED, message);
  }

  /**
   * Request-shape error that matches the validation middleware's error code.
   */
  private invalidPayload(message: string): AppError {
    return new AppError(422, 'VALIDATION_ERROR', message);
  }
}

export const courseService = new CourseService();
