import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { VideoModel } from '../src/modules/videos/video.model.js';
import { CourseModel } from '../src/modules/courses/course.model.js';
import { CategoryModel } from '../src/modules/categories/category.model.js';
import { SectionModel } from '../src/modules/courses/section.model.js';
import { LessonModel } from '../src/modules/courses/lesson.model.js';
import {
  COURSE_PUBLISH_ISSUES,
  COURSE_ERRORS,
} from '../src/modules/courses/course.constants.js';
import { AUTH_ERRORS } from '../src/modules/auth/auth.constants.js';
import { CSRF_COOKIE_NAME } from '../src/middleware/csrf.js';

const EXPECTED_TEST_DB_NAME = 'education-platform-test';
const ALLOWED_TEST_HOSTS = new Set(['127.0.0.1', 'localhost']);
const TEST_DB_URI = 'mongodb://127.0.0.1:27017/education-platform-test';

/**
 * Strict database safety assertion (mirrors the other integration suites):
 * tests must never connect to, write to, or delete from a non-test database.
 */
function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL DATABASE SAFETY VIOLATION: Tests must never execute when NODE_ENV is "production".',
    );
  }

  const parsedUri = new URL(TEST_DB_URI);

  if (parsedUri.protocol !== 'mongodb:') {
    throw new Error(
      `FATAL DATABASE SAFETY VIOLATION: Protocol must be "mongodb:". Received: ${parsedUri.protocol}`,
    );
  }

  if (!ALLOWED_TEST_HOSTS.has(parsedUri.hostname)) {
    throw new Error(
      `FATAL DATABASE SAFETY VIOLATION: Test database host must be local loopback. Received: ${parsedUri.hostname}`,
    );
  }

  const dbNameFromUri = parsedUri.pathname.replace(/^\//, '');
  if (dbNameFromUri !== EXPECTED_TEST_DB_NAME) {
    throw new Error(
      `FATAL DATABASE SAFETY VIOLATION: Database name in URI must strictly equal "${EXPECTED_TEST_DB_NAME}". Received: "${dbNameFromUri}"`,
    );
  }

  if (mongoose.connection.readyState === 1) {
    if (mongoose.connection.name !== EXPECTED_TEST_DB_NAME) {
      throw new Error(
        `FATAL DATABASE SAFETY VIOLATION: Live Mongoose connection database name "${mongoose.connection.name}" does not match "${EXPECTED_TEST_DB_NAME}".`,
      );
    }

    if (
      mongoose.connection.host &&
      !ALLOWED_TEST_HOSTS.has(mongoose.connection.host)
    ) {
      throw new Error(
        `FATAL DATABASE SAFETY VIOLATION: Live Mongoose connection host "${mongoose.connection.host}" is not in allowed loopback hosts.`,
      );
    }
  }
}

function getCookieValue(cookies: string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    const [cookieName, ...cookieValParts] = pair.split('=');
    if (cookieName.trim() === name) {
      return cookieValParts.join('=');
    }
  }
  return undefined;
}

interface TestSession {
  cookies: string[];
  csrf: string;
  userId: string;
}

interface LessonDto {
  id: string;
  title: string;
  type: string;
  order: number;
}

interface SectionDto {
  id: string;
  title: string;
  order: number;
  lessons: LessonDto[];
}

interface CourseDto {
  id: string;
  ownerId: string;
  title: string;
  slug: string;
  description?: string;
  status: string;
  thumbnailUrl?: string;
  level?: string;
  language?: string;
  learningOutcomes?: string[];
  requirements?: string[];
  priceMinor?: number;
  currency?: string;
  publishedAt?: string;
  sections: SectionDto[];
}

interface CatalogCourseDto {
  id: string;
  title: string;
  slug: string;
  description?: string;
  thumbnailUrl?: string;
  level?: string;
  language?: string;
  priceMinor: number;
  currency?: string;
  isFree: boolean;
  publishedAt: string;
  instructor: { name: string; avatar?: string };
  learningOutcomes?: string[];
  requirements?: string[];
  curriculum?: Array<{
    id: string;
    title: string;
    order: number;
    lessonCount: number;
    lessons: Array<Record<string, unknown>>;
  }>;
  totalSections?: number;
  totalLessons?: number;
}

const PUBLISH_METADATA = {
  description: 'A complete course ready for publication.',
  thumbnailUrl: 'https://cdn.example.com/course-thumbnail.png',
  level: 'beginner',
  language: 'en',
  learningOutcomes: ['Understand the basics', 'Apply the concepts'],
  requirements: ['No prior experience required'],
  priceMinor: 1999,
  currency: 'USD',
};

describe('Course Publishing Integration Tests', () => {
  const app = createApp();
  let defaultCategoryId: string;

  beforeAll(async () => {
    assertSafeTestDatabase();

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }

    assertSafeTestDatabase();
  });

  afterAll(async () => {
    assertSafeTestDatabase();
    await UserModel.deleteMany({});
    await RefreshTokenModel.deleteMany({});
    await VideoModel.deleteMany({});
    await CourseModel.deleteMany({});
    await CategoryModel.deleteMany({});
    await SectionModel.deleteMany({});
    await LessonModel.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    assertSafeTestDatabase();
    await UserModel.deleteMany({});
    await RefreshTokenModel.deleteMany({});
    await VideoModel.deleteMany({});
    await CourseModel.deleteMany({});
    await CategoryModel.deleteMany({});
    await SectionModel.deleteMany({});
    await LessonModel.deleteMany({});

    const category = await CategoryModel.create({
      name: 'Publishing Category',
      slug: 'publishing-category',
      isActive: true,
    });
    defaultCategoryId = category._id.toString();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  async function registerUser(input: {
    name?: string;
    email: string;
    role?: 'student' | 'teacher';
  }): Promise<TestSession> {
    const res = await request(app).post('/api/auth/register').send({
      name: input.name ?? 'Publishing Test User',
      email: input.email,
      password: 'Password123!',
      role: input.role,
    });

    expect(res.status).toBe(201);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME);
    expect(csrf).toBeDefined();

    return {
      cookies,
      csrf: csrf!,
      userId: res.body.data.user.id as string,
    };
  }

  async function registerApprovedTeacher(
    email: string,
    name = 'Approved Teacher',
  ): Promise<TestSession> {
    const session = await registerUser({ name, email, role: 'teacher' });

    await UserModel.updateOne(
      { _id: session.userId },
      { teacherStatus: 'approved' },
    ).exec();

    return session;
  }

  async function createAdmin(email: string): Promise<TestSession> {
    const passwordHash = await bcrypt.hash('Password123!', 4);

    await UserModel.create({
      name: 'Platform Admin',
      email,
      passwordHash,
      role: 'admin',
      teacherStatus: 'none',
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'Password123!' });

    expect(res.status).toBe(200);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME);
    expect(csrf).toBeDefined();

    return { cookies, csrf: csrf!, userId: res.body.data.user.id as string };
  }

  async function createCourse(
    session: TestSession,
    title = 'Publishable Course',
    description: string | null = PUBLISH_METADATA.description,
  ): Promise<CourseDto> {
    const body: Record<string, unknown> = { title };
    if (description !== null) {
      body.description = description;
    }

    const res = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send(body);

    expect(res.status).toBe(201);
    return res.body.data.course as CourseDto;
  }

  async function patchCourse(
    session: TestSession,
    courseId: string,
    body: Record<string, unknown>,
  ) {
    return request(app)
      .patch(`/api/teacher/courses/${courseId}`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send(body);
  }

  async function addSection(
    session: TestSession,
    courseId: string,
    title = 'Section 1',
  ): Promise<SectionDto> {
    const res = await request(app)
      .post(`/api/teacher/courses/${courseId}/sections`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send({ title });

    expect(res.status).toBe(201);
    return res.body.data.course.sections[0] as SectionDto;
  }

  async function addTextLesson(
    session: TestSession,
    courseId: string,
    sectionId: string,
    content = 'Course lesson content',
  ) {
    return request(app)
      .post(`/api/teacher/courses/${courseId}/sections/${sectionId}/lessons`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send({ type: 'text', title: 'Lesson 1', content });
  }

  async function createVideo(
    ownerId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const video = await VideoModel.create({
      ownerId,
      title: 'Lesson Video',
      provider: 'test-provider',
      uploadStatus: 'completed',
      processingStatus: 'ready',
      durationSeconds: 321,
      playbackUrl: 'https://cdn.test/video.mp4',
      ...overrides,
    });

    return video._id.toString();
  }

  async function submitForReview(
    session: TestSession,
    courseId: string,
  ): Promise<CourseDto> {
    const res = await request(app)
      .post(`/api/teacher/courses/${courseId}/submit`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf);

    expect(res.status).toBe(200);
    expect(res.body.data.course.status).toBe('pending_review');
    return res.body.data.course as CourseDto;
  }

  async function approveCourse(
    admin: TestSession,
    courseId: string,
  ): Promise<CourseDto> {
    const res = await request(app)
      .post(`/api/admin/courses/${courseId}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf);

    expect(res.status).toBe(200);
    expect(res.body.data.course.status).toBe('approved');
    return res.body.data.course as CourseDto;
  }

  async function publish(
    session: TestSession,
    courseId: string,
  ) {
    return request(app)
      .post(`/api/teacher/courses/${courseId}/publish`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf);
  }

  /**
   * Build an approved course. Options let a test omit metadata/sections/lessons
   * or attach a specific lesson type while keeping the review flow realistic.
   */
  async function makeApprovedCourse(
    teacher: TestSession,
    admin: TestSession,
    options: {
      title?: string;
      metadata?: boolean;
      sections?: boolean;
      lessons?: boolean;
      lesson?: 'text' | 'video';
      videoId?: string;
    } = {},
  ): Promise<CourseDto> {
    const course = await createCourse(
      teacher,
      options.title ?? 'Publishable Course',
      options.metadata === false
        ? null
        : (options.description ?? PUBLISH_METADATA.description),
    );

    if (options.metadata !== false) {
      const patch = await patchCourse(teacher, course.id, {
        ...PUBLISH_METADATA,
        categoryId: defaultCategoryId,
      });
      expect(patch.status).toBe(200);
    } else {
      // Approval requires a valid category even when the rest of the metadata
      // is intentionally missing for a completeness test.
      const patch = await patchCourse(teacher, course.id, {
        categoryId: defaultCategoryId,
      });
      expect(patch.status).toBe(200);
    }

    if (options.sections !== false) {
      const section = await addSection(teacher, course.id);
      if (options.lessons !== false) {
        if (options.lesson === 'video') {
          expect(options.videoId).toBeDefined();
          const lessonRes = await request(app)
            .post(
              `/api/teacher/courses/${course.id}/sections/${section.id}/lessons`,
            )
            .set('Cookie', teacher.cookies)
            .set('X-CSRF-Token', teacher.csrf)
            .send({
              type: 'video',
              title: 'Video Lesson',
              videoId: options.videoId,
            });
          expect(lessonRes.status).toBe(201);
        } else {
          const lessonRes = await addTextLesson(
            teacher,
            course.id,
            section.id,
          );
          expect(lessonRes.status).toBe(201);
        }
      }
    }

    await submitForReview(teacher, course.id);
    return approveCourse(admin, course.id);
  }

  /**
   * Create a course directly in an arbitrary state for read/catalog tests.
   */
  async function seedCourse(input: {
    ownerId: string;
    title: string;
    slug: string;
    status: string;
    publishedAt?: Date;
    priceMinor?: number;
    currency?: string;
  }) {
    return CourseModel.create({
      ownerId: input.ownerId,
      title: input.title,
      slug: input.slug,
      description: `${input.title} description`,
      status: input.status,
      thumbnailUrl: PUBLISH_METADATA.thumbnailUrl,
      level: 'beginner',
      language: 'en',
      learningOutcomes: ['Learn something'],
      requirements: [],
      priceMinor: input.priceMinor ?? 0,
      currency: input.currency ?? 'USD',
      publishedAt: input.publishedAt,
    });
  }

  // ---------------------------------------------------------------------------
  // Publishing: authorization and lifecycle
  // ---------------------------------------------------------------------------
  it('publishes an approved course owned by the requester', async () => {
    const teacher = await registerApprovedTeacher('owner@test.com');
    const admin = await createAdmin('admin@test.com');
    const course = await makeApprovedCourse(teacher, admin);

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(200);
    expect(res.body.data.course.status).toBe('published');
    expect(res.body.data.course.publishedAt).toBeTruthy();
    expect(res.body.data.course.priceMinor).toBe(PUBLISH_METADATA.priceMinor);
    expect(res.body.data.course.currency).toBe('USD');
    expect(res.body.data.course.sections).toHaveLength(1);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('published');
    expect(stored?.publishedAt).toBeInstanceOf(Date);
  });

  it('requires authentication and an approved teacher', async () => {
    const teacher = await registerApprovedTeacher('authz@test.com');
    const admin = await createAdmin('authz-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin);

    const anonymous = await request(app)
      .post(`/api/teacher/courses/${course.id}/publish`);
    expect(anonymous.status).toBe(401);

    const student = await registerUser({
      email: 'student@test.com',
      role: 'student',
    });
    const studentRes = await publish(student, course.id);
    expect(studentRes.status).toBe(403);
    expect(studentRes.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const pending = await registerUser({
      email: 'pending@test.com',
      role: 'teacher',
    });
    const pendingRes = await publish(pending, course.id);
    expect(pendingRes.status).toBe(403);
    expect(pendingRes.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);
  });

  it('forbids publishing a course owned by another teacher', async () => {
    const owner = await registerApprovedTeacher('real-owner@test.com');
    const other = await registerApprovedTeacher('other@test.com');
    const admin = await createAdmin('other-admin@test.com');
    const course = await makeApprovedCourse(owner, admin);

    const res = await publish(other, course.id);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
  });

  it('forbids an admin from publishing on the teacher behalf', async () => {
    const teacher = await registerApprovedTeacher('teacher@test.com');
    const admin = await createAdmin('moderator@test.com');
    const course = await makeApprovedCourse(teacher, admin);

    const res = await publish(admin, course.id);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
  });

  it('rejects publishing from every non-approved lifecycle state', async () => {
    const teacher = await registerApprovedTeacher('states@test.com');

    for (const status of [
      'draft',
      'pending_review',
      'rejected',
      'published',
      'archived',
    ]) {
      const course = await seedCourse({
        ownerId: teacher.userId,
        title: `State ${status}`,
        slug: `state-${status}`,
        status,
      });

      const res = await publish(teacher, course._id.toString());
      expect(res.status, status).toBe(409);
      expect(res.body.error.code, status).toBe(
        COURSE_ERRORS.INVALID_STATUS_TRANSITION,
      );
    }
  });

  it('does not accept client-owned status or publication fields', async () => {
    const teacher = await registerApprovedTeacher('tamper@test.com');
    const course = await createCourse(teacher);

    const res = await patchCourse(teacher, course.id, {
      title: 'Renamed',
      status: 'published',
      publishedAt: '2020-01-01T00:00:00.000Z',
      reviewedBy: new mongoose.Types.ObjectId().toString(),
    });

    expect(res.status).toBe(200);
    expect(res.body.data.course.status).toBe('draft');
    expect(res.body.data.course.publishedAt).toBeUndefined();

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('draft');
    expect(stored?.publishedAt).toBeUndefined();
  });

  it('rejects a second publish attempt', async () => {
    const teacher = await registerApprovedTeacher('twice@test.com');
    const admin = await createAdmin('twice-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin);

    const first = await publish(teacher, course.id);
    expect(first.status).toBe(200);

    const second = await publish(teacher, course.id);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(
      COURSE_ERRORS.INVALID_STATUS_TRANSITION,
    );
  });

  it('freezes a published course against content edits and deletion', async () => {
    const teacher = await registerApprovedTeacher('frozen@test.com');
    const admin = await createAdmin('frozen-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin);
    const published = await publish(teacher, course.id);
    expect(published.status).toBe(200);

    const edit = await patchCourse(teacher, course.id, {
      title: 'Changed after publishing',
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_EDITABLE);

    const section = await request(app)
      .post(`/api/teacher/courses/${course.id}/sections`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Late section' });
    expect(section.status).toBe(409);
    expect(section.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_EDITABLE);

    const remove = await request(app)
      .delete(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);
    expect(remove.status).toBe(409);
    expect(remove.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_DELETABLE);
  });

  // ---------------------------------------------------------------------------
  // Metadata validation
  // ---------------------------------------------------------------------------
  it('validates publishing metadata fields', async () => {
    const teacher = await registerApprovedTeacher('metadata@test.com');
    const course = await createCourse(teacher);

    const invalidBodies: Array<Record<string, unknown>> = [
      { thumbnailUrl: 'ftp://example.com/thumb.png' },
      { level: 'expert' },
      { language: 'english' },
      { priceMinor: 100 },
      { currency: 'USD' },
      { priceMinor: -1, currency: 'USD' },
      { priceMinor: 10.5, currency: 'USD' },
      { priceMinor: 100, currency: 'US' },
      { priceMinor: 100, currency: 'ZZZ' },
      { learningOutcomes: [''] },
    ];

    for (const body of invalidBodies) {
      const res = await patchCourse(teacher, course.id, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code, JSON.stringify(body)).toBe('VALIDATION_ERROR');
    }
  });

  it('normalizes currency and supports clearing optional metadata', async () => {
    const teacher = await registerApprovedTeacher('clear@test.com');
    const course = await createCourse(teacher);

    const setRes = await patchCourse(teacher, course.id, {
      priceMinor: 500,
      currency: 'usd',
      learningOutcomes: ['One outcome'],
      requirements: [],
      thumbnailUrl: null,
    });
    expect(setRes.status).toBe(200);
    expect(setRes.body.data.course.currency).toBe('USD');
    expect(setRes.body.data.course.priceMinor).toBe(500);
    expect(setRes.body.data.course.requirements).toEqual([]);
    expect(setRes.body.data.course.thumbnailUrl).toBeUndefined();

    const clearRes = await patchCourse(teacher, course.id, {
      priceMinor: null,
      currency: null,
    });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.data.course.priceMinor).toBeUndefined();
    expect(clearRes.body.data.course.currency).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Completeness
  // ---------------------------------------------------------------------------
  it('reports every missing publishing requirement at once', async () => {
    const teacher = await registerApprovedTeacher('incomplete@test.com');
    const admin = await createAdmin('incomplete-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin, {
      metadata: false,
      sections: false,
    });

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_PUBLISHABLE);
    expect(res.body.error.details.reasons).toEqual(
      expect.arrayContaining([
        COURSE_PUBLISH_ISSUES.DESCRIPTION_REQUIRED,
        COURSE_PUBLISH_ISSUES.THUMBNAIL_REQUIRED,
        COURSE_PUBLISH_ISSUES.LEVEL_REQUIRED,
        COURSE_PUBLISH_ISSUES.LANGUAGE_REQUIRED,
        COURSE_PUBLISH_ISSUES.LEARNING_OUTCOMES_REQUIRED,
        COURSE_PUBLISH_ISSUES.PRICE_REQUIRED,
        COURSE_PUBLISH_ISSUES.CURRENCY_REQUIRED,
        COURSE_PUBLISH_ISSUES.SECTIONS_REQUIRED,
      ]),
    );
    expect(res.body.error.details.reasons).not.toContain(
      COURSE_PUBLISH_ISSUES.CATEGORY_REQUIRED,
    );

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('approved');
    expect(stored?.publishedAt).toBeUndefined();
  });

  it('requires at least one committed section', async () => {
    const teacher = await registerApprovedTeacher('nosections@test.com');
    const admin = await createAdmin('nosections-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin, { sections: false });

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons).toContain(
      COURSE_PUBLISH_ISSUES.SECTIONS_REQUIRED,
    );
  });

  it('requires every committed section to contain a committed lesson', async () => {
    const teacher = await registerApprovedTeacher('emptysection@test.com');
    const admin = await createAdmin('emptysection-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin, { lessons: false });

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons).toContain(
      COURSE_PUBLISH_ISSUES.SECTION_WITHOUT_LESSONS,
    );
  });

  it('ignores staged content when checking completeness', async () => {
    const teacher = await registerApprovedTeacher('staged@test.com');
    const admin = await createAdmin('staged-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin, { lessons: false });

    const section = await SectionModel.findOne({ courseId: course.id }).exec();
    expect(section).not.toBeNull();

    await LessonModel.create({
      courseId: course.id,
      sectionId: section!._id,
      title: 'Staged lesson',
      type: 'text',
      content: 'Not committed yet',
      order: 1,
      committed: false,
    });

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons).toContain(
      COURSE_PUBLISH_ISSUES.SECTION_WITHOUT_LESSONS,
    );
  });

  it('rejects a text lesson without content in stored data', async () => {
    const teacher = await registerApprovedTeacher('text@test.com');
    const admin = await createAdmin('text-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin, { lessons: false });

    const section = await SectionModel.findOne({ courseId: course.id }).exec();
    await LessonModel.create({
      courseId: course.id,
      sectionId: section!._id,
      title: 'Empty text lesson',
      type: 'text',
      content: '',
      order: 1,
    });

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons).toContain(
      COURSE_PUBLISH_ISSUES.LESSON_PAYLOAD_INVALID,
    );
  });

  it('rejects a document lesson with an invalid URL in stored data', async () => {
    const teacher = await registerApprovedTeacher('document@test.com');
    const admin = await createAdmin('document-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin, { lessons: false });

    const section = await SectionModel.findOne({ courseId: course.id }).exec();
    await LessonModel.create({
      courseId: course.id,
      sectionId: section!._id,
      title: 'Invalid document lesson',
      type: 'document',
      documentUrl: 'ftp://files.example.com/handout.pdf',
      order: 1,
    });

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons).toContain(
      COURSE_PUBLISH_ISSUES.LESSON_PAYLOAD_INVALID,
    );
  });

  it('publishes a course whose video is owned and ready', async () => {
    const teacher = await registerApprovedTeacher('videoready@test.com');
    const admin = await createAdmin('videoready-admin@test.com');
    const videoId = await createVideo(teacher.userId);
    const course = await makeApprovedCourse(teacher, admin, {
      lesson: 'video',
      videoId,
    });

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(200);
    expect(res.body.data.course.status).toBe('published');
  });

  it('rejects a missing, foreign or unprocessed video', async () => {
    const teacher = await registerApprovedTeacher('videobad@test.com');
    const other = await registerApprovedTeacher('videoowner@test.com');
    const admin = await createAdmin('videobad-admin@test.com');

    const cases: Array<{
      label: string;
      videoId: string;
    }> = [
      {
        label: 'missing',
        videoId: new Types.ObjectId().toString(),
      },
      {
        label: 'foreign',
        videoId: await createVideo(other.userId),
      },
      {
        label: 'not ready',
        videoId: await createVideo(teacher.userId, {
          processingStatus: 'processing',
          playbackUrl: undefined,
        }),
      },
      {
        label: 'no duration',
        videoId: await createVideo(teacher.userId, {
          durationSeconds: undefined,
        }),
      },
    ];

    for (const testCase of cases) {
      // These lessons are inserted directly because the Course Builder refuses
      // to link a missing or foreign video. Publishing still has to defend
      // against stored/legacy rows.
      const course = await makeApprovedCourse(teacher, admin, {
        title: `Video ${testCase.label}`,
        lessons: false,
      });

      const section = await SectionModel.findOne({
        courseId: course.id,
      }).exec();

      await LessonModel.create({
        courseId: course.id,
        sectionId: section!._id,
        title: 'Video lesson',
        type: 'video',
        videoId: testCase.videoId,
        order: 1,
      });

      const res = await publish(teacher, course.id);
      expect(res.status, testCase.label).toBe(422);
      expect(res.body.error.details.reasons, testCase.label).toContain(
        COURSE_PUBLISH_ISSUES.VIDEO_NOT_READY,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Concurrency and edit lease
  // ---------------------------------------------------------------------------
  it('allows only one of two concurrent publish requests to win', async () => {
    const teacher = await registerApprovedTeacher('race@test.com');
    const admin = await createAdmin('race-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin);

    const [first, second] = await Promise.all([
      publish(teacher, course.id),
      publish(teacher, course.id),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('published');
  });

  it('refuses to publish while a content edit lease is active', async () => {
    const teacher = await registerApprovedTeacher('lease@test.com');
    const admin = await createAdmin('lease-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin);

    await CourseModel.updateOne(
      { _id: course.id },
      {
        editLocked: true,
        editLockToken: 'active-lease',
        editLockedAt: new Date(),
        editLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    ).exec();

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('approved');
  });

  it('recovers an abandoned edit lease before publishing', async () => {
    const teacher = await registerApprovedTeacher('stalelease@test.com');
    const admin = await createAdmin('stalelease-admin@test.com');
    const course = await makeApprovedCourse(teacher, admin);

    await CourseModel.updateOne(
      { _id: course.id },
      {
        editLocked: true,
        editLockToken: 'stale-lease',
        editLockedAt: new Date(Date.now() - 10 * 60 * 1000),
        editLeaseExpiresAt: new Date(Date.now() - 60_000),
      },
    ).exec();

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(200);
    expect(res.body.data.course.status).toBe('published');

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.editLocked).toBe(false);
  });

  it('requires approval before a course can be published', async () => {
    const teacher = await registerApprovedTeacher('order@test.com');
    const admin = await createAdmin('order-admin@test.com');
    const course = await createCourse(teacher);
    await patchCourse(teacher, course.id, {
      ...PUBLISH_METADATA,
      categoryId: defaultCategoryId,
    });
    const section = await addSection(teacher, course.id);
    await addTextLesson(teacher, course.id, section.id);
    await submitForReview(teacher, course.id);

    const early = await publish(teacher, course.id);
    expect(early.status).toBe(409);

    await approveCourse(admin, course.id);
    const afterApproval = await publish(teacher, course.id);
    expect(afterApproval.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // Public catalog
  // ---------------------------------------------------------------------------
  it('lists published courses only, newest publication first, with pagination', async () => {
    const teacher = await registerApprovedTeacher('catalog@test.com');
    const now = Date.now();

    await seedCourse({
      ownerId: teacher.userId,
      title: 'Older Published',
      slug: 'older-published',
      status: 'published',
      publishedAt: new Date(now - 60_000),
    });
    await seedCourse({
      ownerId: teacher.userId,
      title: 'Newer Published',
      slug: 'newer-published',
      status: 'published',
      publishedAt: new Date(now),
    });
    for (const status of [
      'draft',
      'pending_review',
      'approved',
      'rejected',
      'archived',
    ]) {
      await seedCourse({
        ownerId: teacher.userId,
        title: `${status} course`,
        slug: `${status}-course`,
        status,
      });
    }

    const firstPage = await request(app).get('/api/courses?page=1&limit=1');

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.meta).toEqual({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
    expect(firstPage.body.data).toHaveLength(1);
    expect(firstPage.body.data[0].title).toBe('Newer Published');

    const secondPage = await request(app).get('/api/courses?page=2&limit=1');
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data[0].title).toBe('Older Published');
  });

  it('returns a safe public course detail with instructor summary', async () => {
    const teacher = await registerApprovedTeacher(
      'detail@test.com',
      'Visible Instructor',
    );
    await UserModel.updateOne(
      { _id: teacher.userId },
      { avatar: 'https://cdn.example.com/avatar.png' },
    ).exec();

    const videoId = await createVideo(teacher.userId);
    const course = await seedCourse({
      ownerId: teacher.userId,
      title: 'Public Course',
      slug: 'public-course',
      status: 'published',
      publishedAt: new Date(),
      priceMinor: 2500,
      currency: 'EUR',
    });

    const section = await SectionModel.create({
      courseId: course._id,
      title: 'Public Section',
      order: 1,
    });

    await LessonModel.create([
      {
        courseId: course._id,
        sectionId: section._id,
        title: 'Protected text',
        type: 'text',
        content: 'secret lesson body',
        order: 1,
      },
      {
        courseId: course._id,
        sectionId: section._id,
        title: 'Protected video',
        type: 'video',
        videoId,
        order: 2,
      },
      {
        courseId: course._id,
        sectionId: section._id,
        title: 'Protected document',
        type: 'document',
        documentUrl: 'https://files.example.com/secret.pdf',
        documentName: 'secret.pdf',
        order: 3,
      },
    ]);

    const res = await request(app).get('/api/courses/public-course');

    expect(res.status).toBe(200);
    const detail = res.body.data.course as CatalogCourseDto;

    expect(detail.title).toBe('Public Course');
    expect(detail.priceMinor).toBe(2500);
    expect(detail.currency).toBe('EUR');
    expect(detail.isFree).toBe(false);
    expect(detail.instructor).toEqual({
      name: 'Visible Instructor',
      avatar: 'https://cdn.example.com/avatar.png',
    });
    expect(detail.curriculum).toHaveLength(1);
    expect(detail.curriculum?.[0].lessonCount).toBe(3);
    expect(detail.totalSections).toBe(1);
    expect(detail.totalLessons).toBe(3);
    expect(detail.learningOutcomes).toEqual(['Learn something']);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('secret lesson body');
    expect(serialized).not.toContain('secret.pdf');
    expect(serialized).not.toContain('files.example.com');
    expect(serialized).not.toContain('cdn.test/video.mp4');
    expect(serialized).not.toContain(videoId);
    expect(serialized).not.toContain('ownerId');
    expect(serialized).not.toContain('reviewedAt');
    expect(serialized).not.toContain('rejectionReason');
    expect(serialized).not.toContain('editLocked');

    for (const lesson of detail.curriculum?.[0].lessons ?? []) {
      expect(Object.keys(lesson).sort()).toEqual(
        ['id', 'order', 'title', 'type'].sort(),
      );
    }
  });

  it('marks a free published course as free', async () => {
    const teacher = await registerApprovedTeacher('free@test.com');
    const course = await seedCourse({
      ownerId: teacher.userId,
      title: 'Free Course',
      slug: 'free-course',
      status: 'published',
      publishedAt: new Date(),
      priceMinor: 0,
    });

    const res = await request(app).get(`/api/courses/${course.slug}`);

    expect(res.status).toBe(200);
    expect(res.body.data.course.isFree).toBe(true);
    expect(res.body.data.course.priceMinor).toBe(0);
    expect(res.body.data.course.requirements).toEqual([]);
  });

  it('returns 404 for non-published or unknown slugs', async () => {
    const teacher = await registerApprovedTeacher('hidden@test.com');
    await seedCourse({
      ownerId: teacher.userId,
      title: 'Draft Course',
      slug: 'draft-course',
      status: 'draft',
    });

    const draft = await request(app).get('/api/courses/draft-course');
    expect(draft.status).toBe(404);
    expect(draft.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);

    const unknown = await request(app).get('/api/courses/does-not-exist');
    expect(unknown.status).toBe(404);
  });

  it('rejects invalid catalog pagination and slugs', async () => {
    const badPage = await request(app).get('/api/courses?limit=9999');
    expect(badPage.status).toBe(422);
    expect(badPage.body.error.code).toBe('VALIDATION_ERROR');

    const badSlug = await request(app).get('/api/courses/Not_A_Slug');
    expect(badSlug.status).toBe(422);
    expect(badSlug.body.error.code).toBe('VALIDATION_ERROR');
  });
});
