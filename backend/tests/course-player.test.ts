import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { CourseModel } from '../src/modules/courses/course.model.js';
import { SectionModel } from '../src/modules/courses/section.model.js';
import { LessonModel } from '../src/modules/courses/lesson.model.js';
import { EnrollmentModel } from '../src/modules/enrollments/enrollment.model.js';
import { VideoModel } from '../src/modules/videos/video.model.js';
import { COURSE_ERRORS } from '../src/modules/courses/course.constants.js';
import { VIDEO_ERRORS } from '../src/modules/videos/video.constants.js';
import { AUTH_ERRORS } from '../src/modules/auth/auth.constants.js';
import { CSRF_COOKIE_NAME } from '../src/middleware/csrf.js';
import type {
  CourseDocument,
  CourseStatus,
  LessonDocument,
  LessonType,
  SectionDocument,
} from '../src/modules/courses/course.types.js';
import type { VideoDocument } from '../src/modules/videos/video.types.js';

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

describe('Course Player Integration Tests', () => {
  const app = createApp();
  let courseSequence = 0;

  beforeAll(async () => {
    assertSafeTestDatabase();

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }

    assertSafeTestDatabase();
  });

  afterAll(async () => {
    assertSafeTestDatabase();
    await clearCollections();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    assertSafeTestDatabase();
    await clearCollections();
  });

  async function clearCollections(): Promise<void> {
    await UserModel.deleteMany({});
    await RefreshTokenModel.deleteMany({});
    await CourseModel.deleteMany({});
    await SectionModel.deleteMany({});
    await LessonModel.deleteMany({});
    await EnrollmentModel.deleteMany({});
    await VideoModel.deleteMany({});
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  async function registerUser(input: {
    name?: string;
    email: string;
    role?: 'student' | 'teacher';
  }): Promise<TestSession> {
    const res = await request(app).post('/api/auth/register').send({
      name: input.name ?? 'Course Player Test User',
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

  async function registerStudent(
    email: string,
    name = 'Course Player Student',
  ): Promise<TestSession> {
    return registerUser({ name, email });
  }

  async function registerTeacher(
    email: string,
    name = 'Course Player Teacher',
  ): Promise<TestSession> {
    return registerUser({ name, email, role: 'teacher' });
  }

  async function registerApprovedTeacher(
    email: string,
    name = 'Course Player Teacher',
  ): Promise<TestSession> {
    const session = await registerTeacher(email, name);
    await UserModel.updateOne(
      { _id: session.userId },
      { teacherStatus: 'approved' },
    ).exec();
    return session;
  }

  async function setTeacherStatus(
    userId: string,
    teacherStatus: 'none' | 'pending' | 'approved' | 'rejected',
  ): Promise<void> {
    await UserModel.updateOne({ _id: userId }, { teacherStatus }).exec();
  }

  async function createAdmin(email: string): Promise<TestSession> {
    const passwordHash = await bcrypt.hash('Password123!', 4);

    await UserModel.create({
      name: 'Course Player Admin',
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

  async function seedCourse(input: {
    ownerId: string;
    title?: string;
    slug?: string;
    status?: CourseStatus;
    priceMinor?: number;
    currency?: string;
  }): Promise<CourseDocument> {
    courseSequence += 1;
    const status = input.status ?? 'published';

    return CourseModel.create({
      ownerId: new Types.ObjectId(input.ownerId),
      title: input.title ?? `Course Player Course ${courseSequence}`,
      slug:
        input.slug ??
        `course-player-${courseSequence}-${new Types.ObjectId().toString()}`,
      description: 'A Course Player test course.',
      status,
      publishedAt: status === 'published' ? new Date() : undefined,
      priceMinor: input.priceMinor ?? 0,
      currency: input.currency ?? 'USD',
    });
  }

  async function seedSection(input: {
    courseId: string;
    title?: string;
    order?: number;
    committed?: boolean;
  }): Promise<SectionDocument> {
    return SectionModel.create({
      courseId: new Types.ObjectId(input.courseId),
      title: input.title ?? 'Course Player Section',
      order: input.order ?? 1,
      committed: input.committed ?? true,
    });
  }

  async function seedLesson(input: {
    courseId: string;
    sectionId: string;
    title?: string;
    description?: string;
    type?: LessonType;
    order?: number;
    content?: string;
    documentUrl?: string;
    documentName?: string;
    videoId?: string;
    committed?: boolean;
  }): Promise<LessonDocument> {
    return LessonModel.create({
      courseId: new Types.ObjectId(input.courseId),
      sectionId: new Types.ObjectId(input.sectionId),
      title: input.title ?? 'Course Player Lesson',
      description: input.description,
      type: input.type ?? 'text',
      order: input.order ?? 1,
      content: input.content,
      documentUrl: input.documentUrl,
      documentName: input.documentName,
      videoId: input.videoId ? new Types.ObjectId(input.videoId) : undefined,
      committed: input.committed ?? true,
    });
  }

  async function seedVideo(
    ownerId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<VideoDocument> {
    return VideoModel.create({
      ownerId: new Types.ObjectId(ownerId),
      title: 'Course Player Video',
      provider: 'test-provider',
      providerAssetId: `asset-${new Types.ObjectId().toString()}`,
      uploadStatus: 'completed',
      processingStatus: 'ready',
      durationSeconds: 321,
      thumbnailUrl: 'https://cdn.test/thumb.jpg',
      playbackUrl: 'https://cdn.test/video.mp4',
      ...overrides,
    });
  }

  async function seedEnrollment(
    studentId: string,
    courseId: string,
    status: 'active' | 'completed' | 'cancelled' | 'expired' = 'active',
  ): Promise<void> {
    await EnrollmentModel.create({
      studentId: new Types.ObjectId(studentId),
      courseId: new Types.ObjectId(courseId),
      status,
      enrolledAt: new Date(),
      completedAt: status === 'completed' ? new Date() : undefined,
      source: 'free',
    });
  }

  function getLesson(
    session: TestSession | null,
    courseId: string,
    lessonId: string,
  ) {
    const req = request(app).get(
      `/api/courses/${courseId}/lessons/${lessonId}`,
    );

    return session ? req.set('Cookie', session.cookies) : req;
  }

  /**
   * Seed a published course with one section and one text lesson, plus an
   * actively enrolled student. Most tests start from this fixture.
   */
  async function seedPublishedTextCourse(): Promise<{
    teacher: TestSession;
    student: TestSession;
    course: CourseDocument;
    section: SectionDocument;
    lesson: LessonDocument;
  }> {
    const teacher = await registerApprovedTeacher(
      `player-teacher-${new Types.ObjectId().toString()}@example.com`,
    );
    const student = await registerStudent(
      `player-student-${new Types.ObjectId().toString()}@example.com`,
    );
    const course = await seedCourse({ ownerId: teacher.userId });
    const section = await seedSection({ courseId: course._id.toString() });
    const lesson = await seedLesson({
      courseId: course._id.toString(),
      sectionId: section._id.toString(),
      title: 'Protected Text Lesson',
      description: 'A protected lesson description.',
      content: 'Protected lesson body.',
    });
    await seedEnrollment(student.userId, course._id.toString());

    return { teacher, student, course, section, lesson };
  }

  // ---------------------------------------------------------------------------
  // Student access
  // ---------------------------------------------------------------------------
  describe('student access', () => {
    it('allows an actively enrolled student to read a text lesson', async () => {
      const { student, course, section, lesson } =
        await seedPublishedTextCourse();

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const view = res.body.data;
      expect(view.course).toEqual({
        id: course._id.toString(),
        title: course.title,
        slug: course.slug,
      });
      expect(view.section).toEqual({
        id: section._id.toString(),
        title: section.title,
        order: section.order,
      });
      expect(view.lesson).toEqual({
        id: lesson._id.toString(),
        title: 'Protected Text Lesson',
        description: 'A protected lesson description.',
        type: 'text',
        order: 1,
        text: { content: 'Protected lesson body.' },
      });
      expect(view.navigation).toEqual({ previous: null, next: null });

      expect(Object.keys(view.lesson).sort()).toEqual(
        ['description', 'id', 'order', 'text', 'title', 'type'].sort(),
      );
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('ownerId');
      expect(serialized).not.toContain('editToken');
      expect(serialized).not.toContain('editLeaseExpiresAt');
      expect(serialized).not.toContain('committed');
      expect(serialized).not.toContain('videoId');
    });

    it('allows a student with a completed enrollment to revisit a lesson', async () => {
      const teacher = await registerApprovedTeacher('completed.teacher@example.com');
      const student = await registerStudent('completed.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        content: 'Completed course content.',
      });
      await seedEnrollment(student.userId, course._id.toString(), 'completed');

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.lesson.text.content).toBe('Completed course content.');
    });

    it('denies a published course to a student without an enrollment', async () => {
      const teacher = await registerApprovedTeacher('unenrolled.teacher@example.com');
      const student = await registerStudent('unenrolled.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        content: 'Enrollment required.',
      });

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
    });

    it('does not let a free published course bypass enrollment', async () => {
      const teacher = await registerApprovedTeacher('free.teacher@example.com');
      const student = await registerStudent('free.student@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        priceMinor: 0,
      });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        content: 'Free but still protected.',
      });

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
    });

    it.each(['cancelled', 'expired'] as const)(
      'denies a %s enrollment',
      async (status) => {
        const teacher = await registerApprovedTeacher(
          `${status}.teacher@example.com`,
        );
        const student = await registerStudent(`${status}.student@example.com`);
        const course = await seedCourse({ ownerId: teacher.userId });
        const section = await seedSection({ courseId: course._id.toString() });
        const lesson = await seedLesson({
          courseId: course._id.toString(),
          sectionId: section._id.toString(),
          content: 'Revoked access.',
        });
        await seedEnrollment(student.userId, course._id.toString(), status);

        const res = await getLesson(
          student,
          course._id.toString(),
          lesson._id.toString(),
        );

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
      },
    );

    it('requires authentication', async () => {
      const { course, lesson } = await seedPublishedTextCourse();

      const res = await getLesson(
        null,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);
    });

    it('reports an unpublished course as not found to students', async () => {
      const teacher = await registerApprovedTeacher('draft.teacher@example.com');
      const student = await registerStudent('draft.student@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        status: 'draft',
      });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        content: 'Draft content.',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);
    });
  });

  // ---------------------------------------------------------------------------
  // Lesson resolution and staged content
  // ---------------------------------------------------------------------------
  describe('lesson resolution', () => {
    it('returns 404 for an unknown lesson id in an accessible course', async () => {
      const { student, course } = await seedPublishedTextCourse();

      const res = await getLesson(
        student,
        course._id.toString(),
        new Types.ObjectId().toString(),
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_NOT_FOUND);
    });

    it('returns 404 for a lesson id from another course', async () => {
      const teacher = await registerApprovedTeacher('cross.teacher@example.com');
      const student = await registerStudent('cross.student@example.com');
      const courseA = await seedCourse({ ownerId: teacher.userId });
      const courseB = await seedCourse({ ownerId: teacher.userId });
      const sectionA = await seedSection({ courseId: courseA._id.toString() });
      const sectionB = await seedSection({ courseId: courseB._id.toString() });
      await seedLesson({
        courseId: courseA._id.toString(),
        sectionId: sectionA._id.toString(),
        content: 'Course A content.',
      });
      const lessonB = await seedLesson({
        courseId: courseB._id.toString(),
        sectionId: sectionB._id.toString(),
        content: 'Course B content.',
      });
      await seedEnrollment(student.userId, courseA._id.toString());

      const res = await getLesson(
        student,
        courseA._id.toString(),
        lessonB._id.toString(),
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_NOT_FOUND);
    });

    it('returns 422 for malformed course or lesson ids', async () => {
      const { student } = await seedPublishedTextCourse();

      const res = await request(app)
        .get('/api/courses/not-an-object-id/lessons/also-not-an-object-id')
        .set('Cookie', student.cookies);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('hides a staged lesson', async () => {
      const { student, course, section } = await seedPublishedTextCourse();
      const staged = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        title: 'Staged Lesson',
        content: 'Not committed.',
        order: 2,
        committed: false,
      });

      const res = await getLesson(
        student,
        course._id.toString(),
        staged._id.toString(),
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_NOT_FOUND);
    });

    it('hides a committed lesson whose section is staged', async () => {
      const teacher = await registerApprovedTeacher('staged.section.teacher@example.com');
      const student = await registerStudent('staged.section.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({
        courseId: course._id.toString(),
        committed: false,
      });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        content: 'Hidden with its section.',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.SECTION_NOT_FOUND);
    });
  });

  // ---------------------------------------------------------------------------
  // Lesson types
  // ---------------------------------------------------------------------------
  describe('lesson content types', () => {
    it('returns a document lesson resource reference', async () => {
      const teacher = await registerApprovedTeacher('document.teacher@example.com');
      const student = await registerStudent('document.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        title: 'Document Lesson',
        type: 'document',
        documentUrl: 'https://files.example.com/handout.pdf',
        documentName: 'handout.pdf',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.lesson).toEqual({
        id: lesson._id.toString(),
        title: 'Document Lesson',
        type: 'document',
        order: 1,
        document: {
          url: 'https://files.example.com/handout.pdf',
          name: 'handout.pdf',
        },
      });

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('documentUrl');
      expect(serialized).not.toContain('videoId');
    });

    it('returns a video playback reference without provider metadata', async () => {
      const teacher = await registerApprovedTeacher('video.teacher@example.com');
      const student = await registerStudent('video.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const video = await seedVideo(teacher.userId);
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        title: 'Video Lesson',
        type: 'video',
        videoId: video._id.toString(),
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.lesson.video).toEqual({
        playbackUrl: 'https://cdn.test/video.mp4',
        durationSeconds: 321,
        thumbnailUrl: 'https://cdn.test/thumb.jpg',
      });

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('test-provider');
      expect(serialized).not.toContain('providerAssetId');
      expect(serialized).not.toContain(video._id.toString());
      expect(serialized).not.toContain('processingStatus');
      expect(serialized).not.toContain('uploadStatus');
      expect(serialized).not.toContain('failureReason');
    });

    it('returns 409 VIDEO_NOT_READY for a video that is not ready', async () => {
      const teacher = await registerApprovedTeacher('notready.teacher@example.com');
      const student = await registerStudent('notready.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const video = await seedVideo(teacher.userId, {
        processingStatus: 'processing',
        playbackUrl: undefined,
      });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'video',
        videoId: video._id.toString(),
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(VIDEO_ERRORS.VIDEO_NOT_READY);
    });

    it('returns 404 LESSON_VIDEO_NOT_FOUND for a missing video', async () => {
      const teacher = await registerApprovedTeacher('missing.video.teacher@example.com');
      const student = await registerStudent('missing.video.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'video',
        videoId: new Types.ObjectId().toString(),
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_VIDEO_NOT_FOUND);
    });

    it('returns 404 LESSON_VIDEO_NOT_FOUND for a video owned by another teacher', async () => {
      const owner = await registerApprovedTeacher('foreign.video.owner@example.com');
      const other = await registerApprovedTeacher('foreign.video.other@example.com');
      const student = await registerStudent('foreign.video.student@example.com');
      const course = await seedCourse({ ownerId: owner.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const foreignVideo = await seedVideo(other.userId);
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'video',
        videoId: foreignVideo._id.toString(),
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_VIDEO_NOT_FOUND);
    });

    it('rejects a quiz lesson until the Quiz System exists', async () => {
      const teacher = await registerApprovedTeacher('quiz.teacher@example.com');
      const student = await registerStudent('quiz.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'quiz',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_TYPE_UNSUPPORTED);
    });

    it('rejects a text lesson without stored content', async () => {
      const teacher = await registerApprovedTeacher('empty.text.teacher@example.com');
      const student = await registerStudent('empty.text.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'text',
        content: '',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED);
    });

    it('rejects a document lesson without a stored URL', async () => {
      const teacher = await registerApprovedTeacher('empty.doc.teacher@example.com');
      const student = await registerStudent('empty.doc.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'document',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED);
    });

    it('rejects a document lesson with a non-HTTP stored URL', async () => {
      const teacher = await registerApprovedTeacher(
        'invalid.doc.teacher@example.com',
      );
      const student = await registerStudent('invalid.doc.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'document',
        documentUrl: 'javascript:alert(1)',
        documentName: 'unsafe',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED);
      expect(JSON.stringify(res.body)).not.toContain('javascript:');
    });

    it('rejects a video lesson without a stored video reference', async () => {
      const teacher = await registerApprovedTeacher('empty.video.teacher@example.com');
      const student = await registerStudent('empty.video.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'video',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED);
    });
  });

  // ---------------------------------------------------------------------------
  // Teacher and admin access
  // ---------------------------------------------------------------------------
  describe('teacher and admin access', () => {
    it('allows an approved owner teacher to preview a draft course', async () => {
      const teacher = await registerApprovedTeacher('owner.preview@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        status: 'draft',
      });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        content: 'Draft preview content.',
      });

      const res = await getLesson(
        teacher,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.lesson.text.content).toBe('Draft preview content.');
    });

    it('denies a non-owner teacher', async () => {
      const owner = await registerApprovedTeacher('owner.teacher@example.com');
      const other = await registerApprovedTeacher('other.teacher@example.com');
      const course = await seedCourse({ ownerId: owner.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        content: 'Owner-only content.',
      });

      const res = await getLesson(
        other,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
    });

    it('denies a non-owner teacher before resolving a lesson id', async () => {
      const owner = await registerApprovedTeacher('owner.probe@example.com');
      const other = await registerApprovedTeacher('other.probe@example.com');
      const course = await seedCourse({ ownerId: owner.userId });

      const res = await getLesson(
        other,
        course._id.toString(),
        new Types.ObjectId().toString(),
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
    });

    it('denies a pending teacher who owns the course', async () => {
      const teacher = await registerTeacher('pending.owner@example.com');
      await setTeacherStatus(teacher.userId, 'pending');
      const course = await seedCourse({
        ownerId: teacher.userId,
        status: 'draft',
      });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        content: 'Pending teacher preview.',
      });

      const res = await getLesson(
        teacher,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);
    });

    it('allows an admin to preview an unpublished course', async () => {
      const teacher = await registerApprovedTeacher('admin.preview.teacher@example.com');
      const admin = await createAdmin('admin.preview@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        status: 'pending_review',
      });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'document',
        documentUrl: 'https://files.example.com/review.pdf',
        documentName: 'review.pdf',
      });

      const res = await getLesson(
        admin,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.lesson.document.url).toBe(
        'https://files.example.com/review.pdf',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Previous/next navigation
  // ---------------------------------------------------------------------------
  describe('previous and next navigation', () => {
    async function seedThreeLessonCourse(): Promise<{
      student: TestSession;
      course: CourseDocument;
      lessons: LessonDocument[];
    }> {
      const teacher = await registerApprovedTeacher(
        `nav.teacher.${new Types.ObjectId().toString()}@example.com`,
      );
      const student = await registerStudent(
        `nav.student.${new Types.ObjectId().toString()}@example.com`,
      );
      const course = await seedCourse({ ownerId: teacher.userId });
      const sectionOne = await seedSection({
        courseId: course._id.toString(),
        title: 'Section One',
        order: 1,
      });
      const sectionTwo = await seedSection({
        courseId: course._id.toString(),
        title: 'Section Two',
        order: 2,
      });

      const lessonOne = await seedLesson({
        courseId: course._id.toString(),
        sectionId: sectionOne._id.toString(),
        title: 'Lesson One',
        content: 'One',
        order: 1,
      });
      const lessonTwo = await seedLesson({
        courseId: course._id.toString(),
        sectionId: sectionOne._id.toString(),
        title: 'Lesson Two',
        content: 'Two',
        order: 2,
      });
      const lessonThree = await seedLesson({
        courseId: course._id.toString(),
        sectionId: sectionTwo._id.toString(),
        title: 'Lesson Three',
        content: 'Three',
        order: 1,
      });
      await seedEnrollment(student.userId, course._id.toString());

      return {
        student,
        course,
        lessons: [lessonOne, lessonTwo, lessonThree],
      };
    }

    it('returns no previous lesson at the beginning of the course', async () => {
      const { student, course, lessons } = await seedThreeLessonCourse();
      const first = lessons[0]!;

      const res = await getLesson(
        student,
        course._id.toString(),
        first._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.navigation.previous).toBeNull();
      expect(res.body.data.navigation.next).toMatchObject({
        lessonId: lessons[1]!._id.toString(),
        title: 'Lesson Two',
        type: 'text',
      });
    });

    it('returns previous and next across a section boundary in the middle', async () => {
      const { student, course, lessons } = await seedThreeLessonCourse();
      const second = lessons[1]!;

      const res = await getLesson(
        student,
        course._id.toString(),
        second._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.navigation.previous).toMatchObject({
        lessonId: lessons[0]!._id.toString(),
        title: 'Lesson One',
      });
      expect(res.body.data.navigation.next).toMatchObject({
        lessonId: lessons[2]!._id.toString(),
        title: 'Lesson Three',
        sectionId: lessons[2]!.sectionId.toString(),
      });
    });

    it('returns no next lesson at the end of the course', async () => {
      const { student, course, lessons } = await seedThreeLessonCourse();
      const last = lessons[2]!;

      const res = await getLesson(
        student,
        course._id.toString(),
        last._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.navigation.previous).toMatchObject({
        lessonId: lessons[1]!._id.toString(),
        title: 'Lesson Two',
      });
      expect(res.body.data.navigation.next).toBeNull();
    });

    it('orders navigation by section order even when sections were created out of order', async () => {
      const teacher = await registerApprovedTeacher('section.order.teacher@example.com');
      const student = await registerStudent('section.order.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });

      // Create the later section first so insertion order differs from order.
      const sectionTwo = await seedSection({
        courseId: course._id.toString(),
        title: 'Later Section',
        order: 2,
      });
      const sectionOne = await seedSection({
        courseId: course._id.toString(),
        title: 'Earlier Section',
        order: 1,
      });

      const laterLesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: sectionTwo._id.toString(),
        title: 'Later Lesson',
        content: 'Later',
        order: 1,
      });
      const earlierLesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: sectionOne._id.toString(),
        title: 'Earlier Lesson',
        content: 'Earlier',
        order: 1,
      });
      await seedEnrollment(student.userId, course._id.toString());

      const earlier = await getLesson(
        student,
        course._id.toString(),
        earlierLesson._id.toString(),
      );
      expect(earlier.status).toBe(200);
      expect(earlier.body.data.navigation.previous).toBeNull();
      expect(earlier.body.data.navigation.next.lessonId).toBe(
        laterLesson._id.toString(),
      );

      const later = await getLesson(
        student,
        course._id.toString(),
        laterLesson._id.toString(),
      );
      expect(later.status).toBe(200);
      expect(later.body.data.navigation.previous.lessonId).toBe(
        earlierLesson._id.toString(),
      );
      expect(later.body.data.navigation.next).toBeNull();
    });

    it('excludes staged lessons from navigation', async () => {
      const teacher = await registerApprovedTeacher('staged.nav.teacher@example.com');
      const student = await registerStudent('staged.nav.student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });

      const first = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        title: 'First',
        content: 'First',
        order: 1,
      });
      await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        title: 'Staged',
        content: 'Staged',
        order: 2,
        committed: false,
      });
      const third = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        title: 'Third',
        content: 'Third',
        order: 3,
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getLesson(
        student,
        course._id.toString(),
        first._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.navigation.next.lessonId).toBe(
        third._id.toString(),
      );
      expect(res.body.data.navigation.next.title).toBe('Third');
    });

    it('excludes a staged section from previous and next navigation', async () => {
      const teacher = await registerApprovedTeacher(
        'staged.section.nav.teacher@example.com',
      );
      const student = await registerStudent(
        'staged.section.nav.student@example.com',
      );
      const course = await seedCourse({ ownerId: teacher.userId });

      const sectionOne = await seedSection({
        courseId: course._id.toString(),
        title: 'Visible One',
        order: 1,
      });
      const stagedSection = await seedSection({
        courseId: course._id.toString(),
        title: 'Staged Section',
        order: 2,
        committed: false,
      });
      const sectionThree = await seedSection({
        courseId: course._id.toString(),
        title: 'Visible Three',
        order: 3,
      });

      const first = await seedLesson({
        courseId: course._id.toString(),
        sectionId: sectionOne._id.toString(),
        title: 'First Visible',
        content: 'First',
        order: 1,
      });
      // A committed lesson inside a staged section must stay out of
      // navigation because its section is not visible.
      await seedLesson({
        courseId: course._id.toString(),
        sectionId: stagedSection._id.toString(),
        title: 'Hidden Lesson',
        content: 'Hidden',
        order: 1,
      });
      const third = await seedLesson({
        courseId: course._id.toString(),
        sectionId: sectionThree._id.toString(),
        title: 'Third Visible',
        content: 'Third',
        order: 1,
      });
      await seedEnrollment(student.userId, course._id.toString());

      const firstRes = await getLesson(
        student,
        course._id.toString(),
        first._id.toString(),
      );

      expect(firstRes.status).toBe(200);
      expect(firstRes.body.data.navigation.previous).toBeNull();
      expect(firstRes.body.data.navigation.next).toMatchObject({
        lessonId: third._id.toString(),
        sectionId: sectionThree._id.toString(),
        title: 'Third Visible',
        type: 'text',
      });
      expect(JSON.stringify(firstRes.body)).not.toContain('Hidden Lesson');

      const thirdRes = await getLesson(
        student,
        course._id.toString(),
        third._id.toString(),
      );

      expect(thirdRes.status).toBe(200);
      expect(thirdRes.body.data.navigation.previous).toMatchObject({
        lessonId: first._id.toString(),
        sectionId: sectionOne._id.toString(),
        title: 'First Visible',
      });
      expect(thirdRes.body.data.navigation.next).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Regression: the public catalog stays anonymous and content-free
  // ---------------------------------------------------------------------------
  describe('public catalog regression', () => {
    it('keeps the public catalog anonymous and free of protected content', async () => {
      const teacher = await registerApprovedTeacher('catalog.teacher@example.com');
      const video = await seedVideo(teacher.userId);
      const course = await seedCourse({
        ownerId: teacher.userId,
        title: 'Public Player Course',
        slug: 'public-player-course',
      });
      const section = await seedSection({ courseId: course._id.toString() });

      await LessonModel.create([
        {
          courseId: course._id,
          sectionId: section._id,
          title: 'Public Text',
          type: 'text',
          content: 'secret text body',
          order: 1,
        },
        {
          courseId: course._id,
          sectionId: section._id,
          title: 'Public Document',
          type: 'document',
          documentUrl: 'https://files.example.com/secret.pdf',
          documentName: 'secret.pdf',
          order: 2,
        },
        {
          courseId: course._id,
          sectionId: section._id,
          title: 'Public Video',
          type: 'video',
          videoId: video._id,
          order: 3,
        },
      ]);

      const res = await request(app).get('/api/courses/public-player-course');

      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('secret text body');
      expect(serialized).not.toContain('files.example.com');
      expect(serialized).not.toContain('cdn.test/video.mp4');
      expect(serialized).not.toContain(video._id.toString());
      expect(serialized).not.toContain('ownerId');
    });
  });
});
