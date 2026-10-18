import { randomBytes } from 'node:crypto';
import { AppError } from '../../errors/index.js';
import type { AuthUser } from '../users/user.types.js';
import {
  videoRepository,
  type VideoRepository,
} from '../videos/video.repository.js';
import {
  COURSE_ERRORS,
  COURSE_SLUG_MAX,
  COURSE_SLUG_MAX_ATTEMPTS,
} from './course.constants.js';
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
import { toCourseDetail, toPublicCourse } from './course.mapper.js';
import type {
  CourseDetail,
  CourseDocument,
  LessonDocument,
  LessonType,
  PublicCourse,
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

export interface PaginatedCourses {
  items: PublicCourse[];
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
      items: items.map(toPublicCourse),
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
    const course = await this.requireOwnedCourse(params.courseId, params.requester);

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

    const updated = await this.courseRepo.updateById(
      course._id.toString(),
      update,
      unset,
    );

    if (!updated) {
      throw new AppError(404, COURSE_ERRORS.COURSE_NOT_FOUND, 'Course not found');
    }

    return this.buildDetail(updated);
  }

  async deleteCourse(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<void> {
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
    const courseId = course._id.toString();

    // Cascade to content. Videos are independent assets that may be reused by
    // other lessons, so they are never deleted here.
    await this.lessonRepo.deleteByCourse(courseId);
    await this.sectionRepo.deleteByCourse(courseId);
    await this.courseRepo.deleteById(courseId);
  }

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------

  async addSection(params: {
    courseId: string;
    requester: AuthUser;
    input: CreateSectionInput;
  }): Promise<CourseDetail> {
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
    const courseId = course._id.toString();

    const order = (await this.sectionRepo.maxOrder(courseId)) + 1;

    await this.sectionRepo.create({
      courseId,
      title: params.input.title,
      description: params.input.description,
      order,
    });

    return this.buildDetail(course);
  }

  async updateSection(params: {
    courseId: string;
    sectionId: string;
    requester: AuthUser;
    input: UpdateSectionInput;
  }): Promise<CourseDetail> {
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
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

    await this.sectionRepo.updateById(section._id.toString(), update, unset);

    return this.buildDetail(course);
  }

  async deleteSection(params: {
    courseId: string;
    sectionId: string;
    requester: AuthUser;
  }): Promise<CourseDetail> {
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
    const section = await this.requireSection(
      course._id.toString(),
      params.sectionId,
    );

    // Lessons belong to the section; deleting it cascades to them.
    await this.lessonRepo.deleteBySection(section._id.toString());
    await this.sectionRepo.deleteById(section._id.toString());

    return this.buildDetail(course);
  }

  async reorderSections(params: {
    courseId: string;
    requester: AuthUser;
    sectionIds: string[];
  }): Promise<CourseDetail> {
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
    const courseId = course._id.toString();

    const sections = await this.sectionRepo.listByCourse(courseId);
    assertSameIdSet(
      sections.map((section) => section._id.toString()),
      params.sectionIds,
    );

    await this.sectionRepo.updateOrders(
      courseId,
      params.sectionIds.map((id, index) => ({ id, order: index + 1 })),
    );

    return this.buildDetail(course);
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
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
    const section = await this.requireSection(
      course._id.toString(),
      params.sectionId,
    );

    const payload = await this.resolveCreatePayload(course, params.input);
    const order = (await this.lessonRepo.maxOrder(section._id.toString())) + 1;

    await this.lessonRepo.create({
      courseId: course._id.toString(),
      sectionId: section._id.toString(),
      title: params.input.title,
      description: params.input.description,
      type: params.input.type,
      order,
      ...payload,
    });

    return this.buildDetail(course);
  }

  async updateLesson(params: {
    courseId: string;
    sectionId: string;
    lessonId: string;
    requester: AuthUser;
    input: UpdateLessonInput;
  }): Promise<CourseDetail> {
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
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

    if (params.input.type !== undefined && params.input.type !== lesson.type) {
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
        update.videoId = await this.resolveLessonVideo(course, params.input.videoId);
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
        throw this.missingPayload('A document lesson requires a documentUrl');
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
    );

    if (!updated) {
      throw new AppError(
        404,
        COURSE_ERRORS.LESSON_NOT_FOUND,
        'Lesson not found',
      );
    }

    return this.buildDetail(course);
  }

  async deleteLesson(params: {
    courseId: string;
    sectionId: string;
    lessonId: string;
    requester: AuthUser;
  }): Promise<CourseDetail> {
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
    const section = await this.requireSection(
      course._id.toString(),
      params.sectionId,
    );
    const lesson = await this.requireLesson(
      course._id.toString(),
      section._id.toString(),
      params.lessonId,
    );

    await this.lessonRepo.deleteById(lesson._id.toString());

    return this.buildDetail(course);
  }

  async reorderLessons(params: {
    courseId: string;
    sectionId: string;
    requester: AuthUser;
    lessonIds: string[];
  }): Promise<CourseDetail> {
    const course = await this.requireOwnedCourse(params.courseId, params.requester);
    const section = await this.requireSection(
      course._id.toString(),
      params.sectionId,
    );

    const lessons = await this.lessonRepo.listBySection(section._id.toString());
    assertSameIdSet(
      lessons.map((lesson) => lesson._id.toString()),
      params.lessonIds,
    );

    await this.lessonRepo.updateOrders(
      section._id.toString(),
      params.lessonIds.map((id, index) => ({ id, order: index + 1 })),
    );

    return this.buildDetail(course);
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

  private async requireOwnedCourse(
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
