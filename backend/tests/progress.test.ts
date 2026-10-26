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
import { LessonProgressModel } from '../src/modules/progress/progress.model.js';
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

describe('Progress Integration Tests', () => {
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
    await LessonProgressModel.deleteMany({});
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function uniqueEmail(prefix: string): string {
    return `${prefix}-${new Types.ObjectId().toString()}@example.com`;
  }

  async function registerUser(input: {
    name?: string;
    email: string;
    role?: 'student' | 'teacher';
  }): Promise<TestSession> {
    const res = await request(app).post('/api/auth/register').send({
      name: input.name ?? 'Progress Test User',
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
    email = uniqueEmail('progress-student'),
  ): Promise<TestSession> {
    return registerUser({ name: 'Progress Student', email });
  }

  async function registerApprovedTeacher(
    email = uniqueEmail('progress-teacher'),
  ): Promise<TestSession> {
    const session = await registerUser({
      name: 'Progress Teacher',
      email,
      role: 'teacher',
    });

    await UserModel.updateOne(
      { _id: session.userId },
      { teacherStatus: 'approved' },
    ).exec();

    return session;
  }

  async function createAdmin(email = uniqueEmail('progress-admin')): Promise<TestSession> {
    const passwordHash = await bcrypt.hash('Password123!', 4);

    await UserModel.create({
      name: 'Progress Admin',
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
    status?: CourseStatus;
    priceMinor?: number;
  }): Promise<CourseDocument> {
    courseSequence += 1;
    const status = input.status ?? 'published';

    return CourseModel.create({
      ownerId: new Types.ObjectId(input.ownerId),
      title: input.title ?? `Progress Course ${courseSequence}`,
      slug: `progress-${courseSequence}-${new Types.ObjectId().toString()}`,
      description: 'A Progress test course.',
      status,
      publishedAt: status === 'published' ? new Date() : undefined,
      priceMinor: input.priceMinor ?? 0,
      currency: 'USD',
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
      title: input.title ?? 'Progress Section',
      order: input.order ?? 1,
      committed: input.committed ?? true,
    });
  }

  async function seedLesson(input: {
    courseId: string;
    sectionId: string;
    title?: string;
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
      title: input.title ?? 'Progress Lesson',
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
      title: 'Progress Video',
      provider: 'test-provider',
      providerAssetId: `asset-${new Types.ObjectId().toString()}`,
      uploadStatus: 'completed',
      processingStatus: 'ready',
      durationSeconds: 100,
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

  async function seedVideoCourse(overrides: {
    video?: Record<string, unknown>;
    enrollmentStatus?: 'active' | 'completed' | 'cancelled' | 'expired';
    courseStatus?: CourseStatus;
    priceMinor?: number;
  } = {}): Promise<{
    teacher: TestSession;
    student: TestSession;
    course: CourseDocument;
    section: SectionDocument;
    video: VideoDocument;
    lesson: LessonDocument;
  }> {
    const teacher = await registerApprovedTeacher();
    const student = await registerStudent();
    const course = await seedCourse({
      ownerId: teacher.userId,
      status: overrides.courseStatus,
      priceMinor: overrides.priceMinor,
    });
    const section = await seedSection({ courseId: course._id.toString() });
    const video = await seedVideo(teacher.userId, overrides.video);
    const lesson = await seedLesson({
      courseId: course._id.toString(),
      sectionId: section._id.toString(),
      title: 'Progress Video Lesson',
      type: 'video',
      videoId: video._id.toString(),
    });

    if (overrides.enrollmentStatus !== undefined) {
      await seedEnrollment(
        student.userId,
        course._id.toString(),
        overrides.enrollmentStatus,
      );
    } else {
      await seedEnrollment(student.userId, course._id.toString());
    }

    return { teacher, student, course, section, video, lesson };
  }

  async function seedTextCourse(lessonCount = 1): Promise<{
    teacher: TestSession;
    student: TestSession;
    course: CourseDocument;
    section: SectionDocument;
    lessons: LessonDocument[];
  }> {
    const teacher = await registerApprovedTeacher();
    const student = await registerStudent();
    const course = await seedCourse({ ownerId: teacher.userId });
    const section = await seedSection({ courseId: course._id.toString() });
    const lessons: LessonDocument[] = [];

    for (let index = 0; index < lessonCount; index += 1) {
      lessons.push(
        await seedLesson({
          courseId: course._id.toString(),
          sectionId: section._id.toString(),
          title: `Progress Text Lesson ${index + 1}`,
          content: `Text lesson body ${index + 1}`,
          order: index + 1,
        }),
      );
    }

    await seedEnrollment(student.userId, course._id.toString());

    return { teacher, student, course, section, lessons };
  }

  function putProgress(
    session: TestSession | null,
    courseId: string,
    lessonId: string,
    body: Record<string, unknown> = {},
  ) {
    let req = request(app).put(
      `/api/courses/${courseId}/lessons/${lessonId}/progress`,
    );

    if (session) {
      req = req
        .set('Cookie', session.cookies)
        .set('X-CSRF-Token', session.csrf);
    }

    return req.send(body);
  }

  function getCourseProgress(
    session: TestSession | null,
    courseId: string,
  ) {
    const req = request(app).get(`/api/courses/${courseId}/progress`);
    return session ? req.set('Cookie', session.cookies) : req;
  }

  function getLessonProgress(
    session: TestSession | null,
    courseId: string,
    lessonId: string,
  ) {
    const req = request(app).get(
      `/api/courses/${courseId}/lessons/${lessonId}/progress`,
    );
    return session ? req.set('Cookie', session.cookies) : req;
  }

  function myCourses(session: TestSession) {
    return request(app)
      .get('/api/my-courses')
      .set('Cookie', session.cookies);
  }

  // ---------------------------------------------------------------------------
  // Authentication and authorization
  // ---------------------------------------------------------------------------
  describe('authentication and authorization', () => {
    it('requires authentication on every progress endpoint', async () => {
      const { course, lesson } = await seedVideoCourse();

      const put = await putProgress(
        null,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 10 },
      );
      expect(put.status).toBe(401);
      expect(put.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);

      const courseRead = await getCourseProgress(
        null,
        course._id.toString(),
      );
      expect(courseRead.status).toBe(401);
      expect(courseRead.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);

      const lessonRead = await getLessonProgress(
        null,
        course._id.toString(),
        lesson._id.toString(),
      );
      expect(lessonRead.status).toBe(401);
      expect(lessonRead.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);
    });

    it('rejects teachers and admins because progress is student-owned', async () => {
      const { teacher, course, lesson } = await seedVideoCourse();
      const admin = await createAdmin();

      for (const session of [teacher, admin]) {
        const put = await putProgress(
          session,
          course._id.toString(),
          lesson._id.toString(),
          { watchedSeconds: 90 },
        );
        expect(put.status).toBe(403);
        expect(put.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

        const courseRead = await getCourseProgress(
          session,
          course._id.toString(),
        );
        expect(courseRead.status).toBe(403);
        expect(courseRead.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);
      }

      expect(await LessonProgressModel.countDocuments({})).toBe(0);
    });

    it('denies a student without an enrollment', async () => {
      const { student, course, lesson } = await seedVideoCourse({
        enrollmentStatus: undefined,
      });

      // Remove the default enrollment seeded by the helper.
      await EnrollmentModel.deleteMany({
        studentId: new Types.ObjectId(student.userId),
      });

      const put = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 90 },
      );
      expect(put.status).toBe(403);
      expect(put.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);

      const read = await getCourseProgress(student, course._id.toString());
      expect(read.status).toBe(403);
      expect(read.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
    });

    it.each(['cancelled', 'expired'] as const)(
      'denies a %s enrollment',
      async (status) => {
        const { student, course, lesson } = await seedVideoCourse({
          enrollmentStatus: status,
        });

        const put = await putProgress(
          student,
          course._id.toString(),
          lesson._id.toString(),
          { watchedSeconds: 90 },
        );
        expect(put.status).toBe(403);
        expect(put.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);

        const read = await getLessonProgress(
          student,
          course._id.toString(),
          lesson._id.toString(),
        );
        expect(read.status).toBe(403);
        expect(read.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
      },
    );

    it('allows a completed enrollment to read and update progress', async () => {
      const { student, course, lesson } = await seedVideoCourse({
        enrollmentStatus: 'completed',
      });

      const put = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 50 },
      );
      expect(put.status).toBe(200);

      const read = await getCourseProgress(student, course._id.toString());
      expect(read.status).toBe(200);
    });

    it('does not let a free published course bypass enrollment', async () => {
      const { student, course, lesson } = await seedVideoCourse({
        priceMinor: 0,
      });
      await EnrollmentModel.deleteMany({});

      const put = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 90 },
      );
      expect(put.status).toBe(403);
      expect(put.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
    });

    it('reports an unpublished course as not found', async () => {
      const { student, course, lesson } = await seedVideoCourse({
        courseStatus: 'draft',
      });

      const put = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 90 },
      );
      expect(put.status).toBe(404);
      expect(put.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);

      const read = await getCourseProgress(student, course._id.toString());
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);
    });

    it('reports an unknown course as not found', async () => {
      const student = await registerStudent();

      const read = await getCourseProgress(
        student,
        new Types.ObjectId().toString(),
      );
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);
    });

    it('requires a valid CSRF token for progress writes', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const res = await request(app)
        .put(`/api/courses/${course._id.toString()}/lessons/${lesson._id.toString()}/progress`)
        .set('Cookie', student.cookies)
        .send({ watchedSeconds: 90 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_MISSING);
    });
  });

  // ---------------------------------------------------------------------------
  // Lesson resolution and committed content
  // ---------------------------------------------------------------------------
  describe('lesson resolution', () => {
    it('validates course and lesson ids', async () => {
      const student = await registerStudent();

      const courseRead = await getCourseProgress(student, 'not-an-id');
      expect(courseRead.status).toBe(422);
      expect(courseRead.body.error.code).toBe('VALIDATION_ERROR');

      const lessonRead = await getLessonProgress(
        student,
        'not-an-id',
        'also-not-an-id',
      );
      expect(lessonRead.status).toBe(422);
      expect(lessonRead.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 for an unknown lesson id in an accessible course', async () => {
      const { student, course } = await seedVideoCourse();

      const res = await putProgress(
        student,
        course._id.toString(),
        new Types.ObjectId().toString(),
        { watchedSeconds: 10 },
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_NOT_FOUND);
    });

    it('returns 404 for a lesson id from another course', async () => {
      const teacher = await registerApprovedTeacher();
      const student = await registerStudent();
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

      const res = await putProgress(
        student,
        courseA._id.toString(),
        lessonB._id.toString(),
        { completed: true },
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_NOT_FOUND);
    });

    it('hides a staged lesson', async () => {
      const { student, course, section } = await seedTextCourse();

      const staged = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        content: 'Not committed.',
        order: 2,
        committed: false,
      });

      const put = await putProgress(
        student,
        course._id.toString(),
        staged._id.toString(),
        { completed: true },
      );
      expect(put.status).toBe(404);
      expect(put.body.error.code).toBe(COURSE_ERRORS.LESSON_NOT_FOUND);

      const read = await getLessonProgress(
        student,
        course._id.toString(),
        staged._id.toString(),
      );
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe(COURSE_ERRORS.LESSON_NOT_FOUND);
    });

    it('hides a committed lesson whose section is staged', async () => {
      const teacher = await registerApprovedTeacher();
      const student = await registerStudent();
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

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { completed: true },
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.SECTION_NOT_FOUND);
    });

    it('rejects quiz progress until the Quiz System exists', async () => {
      const teacher = await registerApprovedTeacher();
      const student = await registerStudent();
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const quiz = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'quiz',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const put = await putProgress(
        student,
        course._id.toString(),
        quiz._id.toString(),
        { completed: true },
      );
      expect(put.status).toBe(409);
      expect(put.body.error.code).toBe(COURSE_ERRORS.LESSON_TYPE_UNSUPPORTED);

      const read = await getLessonProgress(
        student,
        course._id.toString(),
        quiz._id.toString(),
      );
      expect(read.status).toBe(409);
      expect(read.body.error.code).toBe(COURSE_ERRORS.LESSON_TYPE_UNSUPPORTED);
    });
  });

  // ---------------------------------------------------------------------------
  // Request validation
  // ---------------------------------------------------------------------------
  describe('request validation', () => {
    it('rejects client-owned completion and duration fields', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const duration = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 10, durationSeconds: 100 },
      );
      expect(duration.status).toBe(422);
      expect(duration.body.error.code).toBe('VALIDATION_ERROR');

      const ended = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 10, ended: true },
      );
      expect(ended.status).toBe(422);
      expect(ended.body.error.code).toBe('VALIDATION_ERROR');

      const score = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 10, score: 100 },
      );
      expect(score.status).toBe(422);
      expect(score.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects malformed playback values', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const cases: Array<Record<string, unknown>> = [
        { watchedSeconds: -1 },
        { positionSeconds: -1 },
        { watchedSeconds: Number.NaN },
        { watchedSeconds: Number.POSITIVE_INFINITY },
        { watchedSeconds: 604801 },
        { watchedSeconds: '10' },
      ];

      for (const body of cases) {
        const res = await putProgress(
          student,
          course._id.toString(),
          lesson._id.toString(),
          body,
        );
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Video progress and completion
  // ---------------------------------------------------------------------------
  describe('video progress', () => {
    it('records watched time and resume position below the threshold', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 50, positionSeconds: 42 },
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        lessonId: lesson._id.toString(),
        sectionId: lesson.sectionId.toString(),
        lessonType: 'video',
        watchedSeconds: 50,
        durationSeconds: 100,
        lastPositionSeconds: 42,
        completed: false,
      });
      expect(res.body.data.completedAt).toBeUndefined();
    });

    it('completes a video at exactly 90% of the authoritative duration', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const below = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 89.9 },
      );
      expect(below.body.data.completed).toBe(false);

      const atThreshold = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 90 },
      );
      expect(atThreshold.body.data.completed).toBe(true);
      expect(atThreshold.body.data.completedAt).toBeTypeOf('string');
    });

    it('ignores a client completed flag for a video', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 10, completed: true },
      );

      expect(res.status).toBe(200);
      expect(res.body.data.completed).toBe(false);
    });

    it('clamps watched time and position to the authoritative duration', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 5000, positionSeconds: 5000 },
      );

      expect(res.status).toBe(200);
      expect(res.body.data.watchedSeconds).toBe(100);
      expect(res.body.data.lastPositionSeconds).toBe(100);
      expect(res.body.data.completed).toBe(true);
    });

    it('keeps watched time monotonic while updating the resume position', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 50, positionSeconds: 50 },
      );

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 20, positionSeconds: 20 },
      );

      expect(res.body.data.watchedSeconds).toBe(50);
      expect(res.body.data.lastPositionSeconds).toBe(20);
    });

    it('preserves the resume position across watched-only and position-only updates', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 30, positionSeconds: 27 },
      );

      const watchedOnly = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 40 },
      );
      expect(watchedOnly.body.data.watchedSeconds).toBe(40);
      expect(watchedOnly.body.data.lastPositionSeconds).toBe(27);

      const positionOnly = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { positionSeconds: 12 },
      );
      expect(positionOnly.body.data.watchedSeconds).toBe(40);
      expect(positionOnly.body.data.lastPositionSeconds).toBe(12);
    });

    it('preserves sticky completion and the original completion timestamp', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const first = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 90 },
      );
      expect(first.body.data.completed).toBe(true);
      const completedAt = first.body.data.completedAt as string;
      expect(completedAt).toBeTypeOf('string');

      const second = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 95 },
      );

      expect(second.body.data.completed).toBe(true);
      expect(second.body.data.completedAt).toBe(completedAt);
    });

    it('returns the resume position from the lesson progress endpoint', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 30, positionSeconds: 27 },
      );

      const res = await getLessonProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data.lastPositionSeconds).toBe(27);
      expect(res.body.data.watchedSeconds).toBe(30);
    });

    it('returns an empty resume view before any progress exists', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const res = await getLessonProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        lessonId: lesson._id.toString(),
        watchedSeconds: 0,
        lastPositionSeconds: 0,
        completed: false,
      });
    });

    it('rejects a video that is not ready', async () => {
      const { student, course, lesson } = await seedVideoCourse({
        video: { processingStatus: 'processing', playbackUrl: undefined },
      });

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 90 },
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(VIDEO_ERRORS.VIDEO_NOT_READY);
    });

    it('rejects a missing video reference', async () => {
      const { student, course, section } = await seedVideoCourse();
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'video',
        videoId: new Types.ObjectId().toString(),
        order: 2,
      });

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 90 },
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_VIDEO_NOT_FOUND);
    });

    it('rejects a video owned by another teacher', async () => {
      const owner = await registerApprovedTeacher();
      const other = await registerApprovedTeacher();
      const student = await registerStudent();
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

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 90 },
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_VIDEO_NOT_FOUND);
    });

    it('rejects a ready video without an authoritative duration', async () => {
      const { student, course, lesson } = await seedVideoCourse({
        video: { durationSeconds: undefined },
      });

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 90 },
      );

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED);
    });

    it('creates only one progress row under concurrent updates', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          putProgress(
            student,
            course._id.toString(),
            lesson._id.toString(),
            { watchedSeconds: 10 + index, positionSeconds: index },
          ),
        ),
      );

      for (const res of responses) {
        expect(res.status).toBe(200);
      }

      expect(
        await LessonProgressModel.countDocuments({
          studentId: new Types.ObjectId(student.userId),
          lessonId: new Types.ObjectId(lesson._id.toString()),
        }),
      ).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Text and document completion
  // ---------------------------------------------------------------------------
  describe('text and document completion', () => {
    it('marks a text lesson complete through an explicit action', async () => {
      const { student, course, lessons } = await seedTextCourse();
      const lesson = lessons[0]!;

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { completed: true },
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        lessonId: lesson._id.toString(),
        lessonType: 'text',
        completed: true,
      });
      expect(res.body.data.completedAt).toBeTypeOf('string');
    });

    it('marks a document lesson complete through an explicit action', async () => {
      const teacher = await registerApprovedTeacher();
      const student = await registerStudent();
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      const lesson = await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'document',
        documentUrl: 'https://files.example.com/handout.pdf',
        documentName: 'handout.pdf',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { completed: true },
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        lessonId: lesson._id.toString(),
        lessonType: 'document',
        completed: true,
      });
    });

    it('does not create a progress row for a text lesson without completion', async () => {
      const { student, course, lessons } = await seedTextCourse();
      const lesson = lessons[0]!;

      const res = await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        {},
      );

      expect(res.status).toBe(200);
      expect(res.body.data.completed).toBe(false);
      expect(await LessonProgressModel.countDocuments({})).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Course summary
  // ---------------------------------------------------------------------------
  describe('course summary', () => {
    it('calculates completion over committed eligible lessons', async () => {
      const { student, course, lessons } = await seedTextCourse(3);

      await putProgress(
        student,
        course._id.toString(),
        lessons[0]!._id.toString(),
        { completed: true },
      );

      const partial = await getCourseProgress(student, course._id.toString());
      expect(partial.status).toBe(200);
      expect(partial.body.data).toMatchObject({
        courseId: course._id.toString(),
        completedLessons: 1,
        totalLessons: 3,
        percent: 33,
      });

      await putProgress(
        student,
        course._id.toString(),
        lessons[1]!._id.toString(),
        { completed: true },
      );
      await putProgress(
        student,
        course._id.toString(),
        lessons[2]!._id.toString(),
        { completed: true },
      );

      const complete = await getCourseProgress(student, course._id.toString());
      expect(complete.body.data).toMatchObject({
        completedLessons: 3,
        totalLessons: 3,
        percent: 100,
      });
    });

    it('excludes quiz lessons from the denominator', async () => {
      const { student, course, lessons, section } = await seedTextCourse(2);

      await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'quiz',
        order: 3,
      });

      for (const lesson of lessons) {
        await putProgress(
          student,
          course._id.toString(),
          lesson._id.toString(),
          { completed: true },
        );
      }

      const res = await getCourseProgress(student, course._id.toString());
      expect(res.body.data).toMatchObject({
        completedLessons: 2,
        totalLessons: 2,
        percent: 100,
      });
    });

    it('excludes staged lessons and lessons in staged sections', async () => {
      const teacher = await registerApprovedTeacher();
      const student = await registerStudent();
      const course = await seedCourse({ ownerId: teacher.userId });
      const visibleSection = await seedSection({
        courseId: course._id.toString(),
        order: 1,
      });
      const stagedSection = await seedSection({
        courseId: course._id.toString(),
        order: 2,
        committed: false,
      });

      const visible = await seedLesson({
        courseId: course._id.toString(),
        sectionId: visibleSection._id.toString(),
        content: 'Visible.',
      });
      await seedLesson({
        courseId: course._id.toString(),
        sectionId: visibleSection._id.toString(),
        content: 'Staged lesson.',
        order: 2,
        committed: false,
      });
      await seedLesson({
        courseId: course._id.toString(),
        sectionId: stagedSection._id.toString(),
        content: 'Hidden with its section.',
      });
      await seedEnrollment(student.userId, course._id.toString());

      await putProgress(
        student,
        course._id.toString(),
        visible._id.toString(),
        { completed: true },
      );

      const res = await getCourseProgress(student, course._id.toString());
      expect(res.body.data).toMatchObject({
        completedLessons: 1,
        totalLessons: 1,
        percent: 100,
      });
      expect(res.body.data.lessons).toHaveLength(1);
    });

    it('handles a course with zero eligible lessons safely', async () => {
      const teacher = await registerApprovedTeacher();
      const student = await registerStudent();
      const course = await seedCourse({ ownerId: teacher.userId });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getCourseProgress(student, course._id.toString());

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        courseId: course._id.toString(),
        completedLessons: 0,
        totalLessons: 0,
        percent: 0,
        currentLessonId: null,
        lessons: [],
      });

      const enrollment = await EnrollmentModel.findOne({
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(course._id.toString()),
      });
      expect(enrollment?.status).toBe('active');
    });

    it('reports the most recently updated lesson as the current lesson', async () => {
      const { student, course, lesson } = await seedVideoCourse();

      await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { watchedSeconds: 10, positionSeconds: 10 },
      );

      const res = await getCourseProgress(student, course._id.toString());
      expect(res.body.data.currentLessonId).toBe(lesson._id.toString());
    });

    it('returns lessons in curriculum order across sections', async () => {
      const teacher = await registerApprovedTeacher();
      const student = await registerStudent();
      const course = await seedCourse({ ownerId: teacher.userId });
      const firstSection = await seedSection({
        courseId: course._id.toString(),
        title: 'First Section',
        order: 1,
      });
      const secondSection = await seedSection({
        courseId: course._id.toString(),
        title: 'Second Section',
        order: 2,
      });

      // Insert out of order and give each section its own order sequence. A
      // global sort by lesson `order` would interleave the two sections.
      const firstSectionLessonTwo = await seedLesson({
        courseId: course._id.toString(),
        sectionId: firstSection._id.toString(),
        title: 'First Section Lesson 2',
        content: 'Second lesson in the first section.',
        order: 2,
      });
      const secondSectionLessonOne = await seedLesson({
        courseId: course._id.toString(),
        sectionId: secondSection._id.toString(),
        title: 'Second Section Lesson 1',
        content: 'First lesson in the second section.',
        order: 1,
      });
      const firstSectionLessonOne = await seedLesson({
        courseId: course._id.toString(),
        sectionId: firstSection._id.toString(),
        title: 'First Section Lesson 1',
        content: 'First lesson in the first section.',
        order: 1,
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getCourseProgress(student, course._id.toString());

      expect(res.status).toBe(200);
      expect(
        res.body.data.lessons.map(
          (lesson: { lessonId: string }) => lesson.lessonId,
        ),
      ).toEqual([
        firstSectionLessonOne._id.toString(),
        firstSectionLessonTwo._id.toString(),
        secondSectionLessonOne._id.toString(),
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Enrollment completion
  // ---------------------------------------------------------------------------
  describe('enrollment completion', () => {
    it('marks the enrollment complete when every eligible lesson is complete', async () => {
      const { student, course, lessons } = await seedTextCourse(2);

      for (const lesson of lessons) {
        await putProgress(
          student,
          course._id.toString(),
          lesson._id.toString(),
          { completed: true },
        );
      }

      const enrollment = await EnrollmentModel.findOne({
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(course._id.toString()),
      });

      expect(enrollment?.status).toBe('completed');
      expect(enrollment?.completedAt).toBeInstanceOf(Date);
    });

    it('does not complete the enrollment on partial progress', async () => {
      const { student, course, lessons } = await seedTextCourse(2);

      await putProgress(
        student,
        course._id.toString(),
        lessons[0]!._id.toString(),
        { completed: true },
      );

      const enrollment = await EnrollmentModel.findOne({
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(course._id.toString()),
      });

      expect(enrollment?.status).toBe('active');
      expect(enrollment?.completedAt).toBeUndefined();
    });

    it('preserves the first enrollment completion timestamp on repeat', async () => {
      const { student, course, lessons } = await seedTextCourse(1);
      const lesson = lessons[0]!;

      await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { completed: true },
      );

      const first = await EnrollmentModel.findOne({
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(course._id.toString()),
      });
      const firstCompletedAt = first?.completedAt?.toISOString();

      await putProgress(
        student,
        course._id.toString(),
        lesson._id.toString(),
        { completed: true },
      );

      const second = await EnrollmentModel.findOne({
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(course._id.toString()),
      });

      expect(second?.status).toBe('completed');
      expect(second?.completedAt?.toISOString()).toBe(firstCompletedAt);
    });

    it('does not complete a course whose only lessons are quizzes', async () => {
      const teacher = await registerApprovedTeacher();
      const student = await registerStudent();
      const course = await seedCourse({ ownerId: teacher.userId });
      const section = await seedSection({ courseId: course._id.toString() });
      await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'quiz',
      });
      await seedEnrollment(student.userId, course._id.toString());

      const res = await getCourseProgress(student, course._id.toString());
      expect(res.body.data.totalLessons).toBe(0);

      const enrollment = await EnrollmentModel.findOne({
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(course._id.toString()),
      });
      expect(enrollment?.status).toBe('active');
    });
  });

  // ---------------------------------------------------------------------------
  // My courses integration
  // ---------------------------------------------------------------------------
  describe('my courses integration', () => {
    it('returns a computed progress summary for each enrolled course', async () => {
      const { student, course, lessons } = await seedTextCourse(2);

      await putProgress(
        student,
        course._id.toString(),
        lessons[0]!._id.toString(),
        { completed: true },
      );

      const res = await myCourses(student);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].course.id).toBe(course._id.toString());
      expect(res.body.data[0].progress).toEqual({
        completedLessons: 1,
        totalLessons: 2,
        percent: 50,
      });
    });

    it('reports zero progress before any lesson is completed', async () => {
      const { student, course } = await seedVideoCourse();
      await LessonProgressModel.deleteMany({});

      const res = await myCourses(student);

      expect(res.status).toBe(200);
      expect(res.body.data[0].course.id).toBe(course._id.toString());
      expect(res.body.data[0].progress).toEqual({
        completedLessons: 0,
        totalLessons: 1,
        percent: 0,
      });
    });

    it('separates curriculum totals from progress-eligible totals', async () => {
      const { student, course, lessons, section } = await seedTextCourse(1);

      await seedLesson({
        courseId: course._id.toString(),
        sectionId: section._id.toString(),
        type: 'quiz',
        order: 2,
      });
      await putProgress(
        student,
        course._id.toString(),
        lessons[0]!._id.toString(),
        { completed: true },
      );

      const res = await myCourses(student);

      expect(res.status).toBe(200);
      expect(res.body.data[0].course.totalLessons).toBe(2);
      expect(res.body.data[0].progress).toEqual({
        completedLessons: 1,
        totalLessons: 1,
        percent: 100,
      });
    });
  });
});
