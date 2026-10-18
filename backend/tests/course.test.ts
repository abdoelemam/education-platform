import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { VideoModel } from '../src/modules/videos/video.model.js';
import { CourseModel } from '../src/modules/courses/course.model.js';
import { SectionModel } from '../src/modules/courses/section.model.js';
import { LessonModel } from '../src/modules/courses/lesson.model.js';
import { COURSE_ERRORS } from '../src/modules/courses/course.constants.js';
import { AUTH_ERRORS } from '../src/modules/auth/auth.constants.js';
import { CSRF_COOKIE_NAME } from '../src/middleware/csrf.js';

const EXPECTED_TEST_DB_NAME = 'education-platform-test';
const ALLOWED_TEST_HOSTS = new Set(['127.0.0.1', 'localhost']);
const TEST_DB_URI = 'mongodb://127.0.0.1:27017/education-platform-test';

/**
 * Strict database safety assertion (mirrors the auth/video suites):
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
  description?: string;
  type: string;
  order: number;
  videoId?: string;
  content?: string;
  documentUrl?: string;
  documentName?: string;
}

interface SectionDto {
  id: string;
  title: string;
  description?: string;
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
  sections: SectionDto[];
}

describe('Course Builder Integration Tests', () => {
  const app = createApp();

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
    await SectionModel.deleteMany({});
    await LessonModel.deleteMany({});
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
      name: input.name ?? 'Course Test User',
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
  ): Promise<TestSession> {
    const session = await registerUser({
      name: 'Approved Teacher',
      email,
      role: 'teacher',
    });

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
    title = 'Advanced Algebra',
  ): Promise<CourseDto> {
    const res = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send({ title, description: 'A complete algebra course' });

    expect(res.status).toBe(201);
    return res.body.data.course as CourseDto;
  }

  async function addSection(
    session: TestSession,
    courseId: string,
    title = 'Section 1',
  ): Promise<CourseDto> {
    const res = await request(app)
      .post(`/api/teacher/courses/${courseId}/sections`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send({ title });

    expect(res.status).toBe(201);
    return res.body.data.course as CourseDto;
  }

  function addLesson(
    session: TestSession,
    courseId: string,
    sectionId: string,
    body: Record<string, unknown>,
  ) {
    return request(app)
      .post(`/api/teacher/courses/${courseId}/sections/${sectionId}/lessons`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send(body);
  }

  async function createVideoRecord(
    ownerId: string,
    title = 'Lesson Video',
  ): Promise<string> {
    const video = await VideoModel.create({
      ownerId,
      title,
      provider: 'test-provider',
      uploadStatus: 'completed',
      processingStatus: 'ready',
      playbackUrl: 'https://cdn.test/video.mp4',
    });

    return video._id.toString();
  }

  // ---------------------------------------------------------------------------
  // 1. Authentication and authorization
  // ---------------------------------------------------------------------------
  it('rejects unauthenticated access', async () => {
    const res = await request(app).get('/api/teacher/courses');
    expect(res.status).toBe(401);
  });

  it('rejects students from the course builder', async () => {
    const student = await registerUser({
      email: 'student@test.com',
      role: 'student',
    });

    const res = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', student.cookies)
      .set('X-CSRF-Token', student.csrf)
      .send({ title: 'Sneaky Course' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);
  });

  it('rejects pending teachers from the course builder', async () => {
    const pending = await registerUser({
      email: 'pending@test.com',
      role: 'teacher',
    });

    const res = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', pending.cookies)
      .set('X-CSRF-Token', pending.csrf)
      .send({ title: 'Not Yet' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);
  });

  it('requires a valid CSRF token for mutations', async () => {
    const teacher = await registerApprovedTeacher('csrf@test.com');

    const res = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', teacher.cookies)
      .send({ title: 'No CSRF' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_MISSING);
  });

  // ---------------------------------------------------------------------------
  // 2. Course lifecycle
  // ---------------------------------------------------------------------------
  it('creates a draft course owned by the requester, ignoring client fields', async () => {
    const teacher = await registerApprovedTeacher('owner@test.com');

    const res = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({
        title: 'Intro to Physics',
        description: 'Mechanics and waves',
        // These must be ignored / rejected as server-owned values.
        status: 'published',
        ownerId: new mongoose.Types.ObjectId().toString(),
        slug: 'attacker-chosen-slug',
      });

    expect(res.status).toBe(201);

    const course = res.body.data.course as CourseDto;
    expect(course.ownerId).toBe(teacher.userId);
    expect(course.status).toBe('draft');
    expect(course.slug).toBe('intro-to-physics');
    expect(course.sections).toEqual([]);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('draft');
    expect(stored?.ownerId.toString()).toBe(teacher.userId);
  });

  it('generates unique slugs for duplicate titles', async () => {
    const teacher = await registerApprovedTeacher('slug@test.com');

    const first = await createCourse(teacher, 'Repeated Title');
    const second = await createCourse(teacher, 'Repeated Title');

    expect(first.slug).toBe('repeated-title');
    expect(second.slug).toBe('repeated-title-2');
    expect(second.slug).not.toBe(first.slug);
  });

  it('lists only the current teacher courses, newest first, with pagination', async () => {
    const teacherA = await registerApprovedTeacher('a@test.com');
    const teacherB = await registerApprovedTeacher('b@test.com');

    await createCourse(teacherA, 'Course One');
    await createCourse(teacherA, 'Course Two');
    await createCourse(teacherA, 'Course Three');
    await createCourse(teacherB, 'Other Teacher Course');

    const res = await request(app)
      .get('/api/teacher/courses?page=1&limit=2')
      .set('Cookie', teacherA.cookies);

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({
      page: 1,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
    expect(res.body.data).toHaveLength(2);
    // Newest first.
    expect(res.body.data[0].title).toBe('Course Three');

    const otherRes = await request(app)
      .get('/api/teacher/courses')
      .set('Cookie', teacherB.cookies);

    expect(otherRes.status).toBe(200);
    expect(otherRes.body.meta.total).toBe(1);
    expect(otherRes.body.data[0].title).toBe('Other Teacher Course');
  });

  it('rejects an invalid list query', async () => {
    const teacher = await registerApprovedTeacher('query@test.com');

    const res = await request(app)
      .get('/api/teacher/courses?limit=9999')
      .set('Cookie', teacher.cookies);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('retrieves the full course structure', async () => {
    const teacher = await registerApprovedTeacher('detail@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id, 'Basics');
    const sectionId = withSection.sections[0].id;

    const lessonRes = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Welcome',
      content: 'Hello students',
    });
    expect(lessonRes.status).toBe(201);

    const res = await request(app)
      .get(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies);

    expect(res.status).toBe(200);
    const detail = res.body.data.course as CourseDto;
    expect(detail.sections).toHaveLength(1);
    expect(detail.sections[0].title).toBe('Basics');
    expect(detail.sections[0].lessons).toHaveLength(1);
    expect(detail.sections[0].lessons[0].title).toBe('Welcome');
    expect(detail.sections[0].lessons[0].type).toBe('text');
  });

  it('returns 404 for a missing course and 422 for an invalid course id', async () => {
    const teacher = await registerApprovedTeacher('missing@test.com');
    const missingId = new mongoose.Types.ObjectId().toString();

    const notFound = await request(app)
      .get(`/api/teacher/courses/${missingId}`)
      .set('Cookie', teacher.cookies);
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);

    const invalid = await request(app)
      .get('/api/teacher/courses/not-an-id')
      .set('Cookie', teacher.cookies);
    expect(invalid.status).toBe(422);
  });

  it('forbids one teacher from reading another teacher course', async () => {
    const owner = await registerApprovedTeacher('owner2@test.com');
    const intruder = await registerApprovedTeacher('intruder@test.com');
    const course = await createCourse(owner);

    const res = await request(app)
      .get(`/api/teacher/courses/${course.id}`)
      .set('Cookie', intruder.cookies);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
  });

  it('updates course metadata and keeps the slug stable', async () => {
    const teacher = await registerApprovedTeacher('update@test.com');
    const course = await createCourse(teacher, 'Original Title');

    const res = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Renamed Title' });

    expect(res.status).toBe(200);
    const updated = res.body.data.course as CourseDto;
    expect(updated.title).toBe('Renamed Title');
    expect(updated.slug).toBe(course.slug);
  });

  it('clears the description when an empty string is sent', async () => {
    const teacher = await registerApprovedTeacher('clear@test.com');
    const course = await createCourse(teacher);
    expect(course.description).toBeDefined();

    const res = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ description: '' });

    expect(res.status).toBe(200);
    expect((res.body.data.course as CourseDto).description).toBeUndefined();
  });

  it('rejects an empty update body', async () => {
    const teacher = await registerApprovedTeacher('empty@test.com');
    const course = await createCourse(teacher);

    const res = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('allows an admin to access and edit any course', async () => {
    const owner = await registerApprovedTeacher('owned@test.com');
    const admin = await createAdmin('admin@test.com');
    const course = await createCourse(owner);

    const read = await request(app)
      .get(`/api/teacher/courses/${course.id}`)
      .set('Cookie', admin.cookies);
    expect(read.status).toBe(200);

    const edit = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ title: 'Admin Renamed' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.course.title).toBe('Admin Renamed');
  });

  it('deletes a course and cascades sections and lessons', async () => {
    const teacher = await registerApprovedTeacher('delete@test.com');
    const other = await registerApprovedTeacher('delete-other@test.com');

    const course = await createCourse(teacher, 'Doomed Course');
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const lessonRes = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Will vanish',
      content: 'content',
    });
    expect(lessonRes.status).toBe(201);

    const survivor = await createCourse(other, 'Survivor Course');
    const survivorSection = await addSection(other, survivor.id);

    const res = await request(app)
      .delete(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);

    expect(res.status).toBe(200);
    expect(await CourseModel.findById(course.id).exec()).toBeNull();
    expect(await SectionModel.countDocuments({ courseId: course.id })).toBe(0);
    expect(await LessonModel.countDocuments({ courseId: course.id })).toBe(0);

    // Another teacher's content is untouched.
    expect(await CourseModel.findById(survivor.id).exec()).not.toBeNull();
    expect(
      await SectionModel.countDocuments({ courseId: survivor.id }),
    ).toBe(1);
    expect(survivorSection.sections).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 3. Sections
  // ---------------------------------------------------------------------------
  it('adds sections with sequential order', async () => {
    const teacher = await registerApprovedTeacher('sections@test.com');
    const course = await createCourse(teacher);

    const first = await addSection(teacher, course.id, 'First');
    expect(first.sections).toHaveLength(1);
    expect(first.sections[0].order).toBe(1);

    const second = await addSection(teacher, course.id, 'Second');
    expect(second.sections.map((s) => s.title)).toEqual(['First', 'Second']);
    expect(second.sections.map((s) => s.order)).toEqual([1, 2]);
  });

  it('edits a section', async () => {
    const teacher = await registerApprovedTeacher('edit-section@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id, 'Old Title');
    const sectionId = withSection.sections[0].id;

    const res = await request(app)
      .patch(`/api/teacher/courses/${course.id}/sections/${sectionId}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'New Title', description: 'Updated' });

    expect(res.status).toBe(200);
    const section = (res.body.data.course as CourseDto).sections[0];
    expect(section.title).toBe('New Title');
    expect(section.description).toBe('Updated');
  });

  it('deletes a section and cascades its lessons', async () => {
    const teacher = await registerApprovedTeacher('del-section@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Lesson',
      content: 'content',
    });

    const res = await request(app)
      .delete(`/api/teacher/courses/${course.id}/sections/${sectionId}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);

    expect(res.status).toBe(200);
    expect((res.body.data.course as CourseDto).sections).toHaveLength(0);
    expect(await SectionModel.countDocuments({ courseId: course.id })).toBe(0);
    expect(await LessonModel.countDocuments({ courseId: course.id })).toBe(0);
  });

  it('reorders sections and persists the new order', async () => {
    const teacher = await registerApprovedTeacher('reorder@test.com');
    const course = await createCourse(teacher);
    await addSection(teacher, course.id, 'A');
    await addSection(teacher, course.id, 'B');
    const withC = await addSection(teacher, course.id, 'C');

    const [a, b, c] = withC.sections;
    const res = await request(app)
      .put(`/api/teacher/courses/${course.id}/sections/reorder`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ sectionIds: [c.id, a.id, b.id] });

    expect(res.status).toBe(200);
    const reordered = (res.body.data.course as CourseDto).sections;
    expect(reordered.map((s) => s.title)).toEqual(['C', 'A', 'B']);
    expect(reordered.map((s) => s.order)).toEqual([1, 2, 3]);

    // Persisted, not just echoed.
    const persisted = await SectionModel.find({ courseId: course.id })
      .sort({ order: 1 })
      .exec();
    expect(persisted.map((s) => s.title)).toEqual(['C', 'A', 'B']);
  });

  it('rejects a reorder list that is not a permutation', async () => {
    const teacher = await registerApprovedTeacher('bad-reorder@test.com');
    const course = await createCourse(teacher);
    await addSection(teacher, course.id, 'A');
    const withB = await addSection(teacher, course.id, 'B');
    const [a, b] = withB.sections;

    const missing = await request(app)
      .put(`/api/teacher/courses/${course.id}/sections/reorder`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ sectionIds: [a.id] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe(COURSE_ERRORS.INVALID_REORDER);

    const duplicated = await request(app)
      .put(`/api/teacher/courses/${course.id}/sections/reorder`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ sectionIds: [a.id, a.id] });
    expect(duplicated.status).toBe(400);
    expect(duplicated.body.error.code).toBe(COURSE_ERRORS.INVALID_REORDER);

    const foreign = await request(app)
      .put(`/api/teacher/courses/${course.id}/sections/reorder`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ sectionIds: [a.id, new mongoose.Types.ObjectId().toString()] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe(COURSE_ERRORS.INVALID_REORDER);

    // Failed reorders never changed the stored structure.
    expect(await SectionModel.countDocuments({ courseId: course.id })).toBe(2);
    expect(b.order).toBe(2);
  });

  it('treats a section id from another course as missing', async () => {
    const teacher = await registerApprovedTeacher('cross-section@test.com');
    const courseA = await createCourse(teacher, 'Course A');
    const courseB = await createCourse(teacher, 'Course B');
    const withSection = await addSection(teacher, courseA.id, 'Belongs to A');
    const sectionId = withSection.sections[0].id;

    const res = await request(app)
      .patch(`/api/teacher/courses/${courseB.id}/sections/${sectionId}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Hijack' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(COURSE_ERRORS.SECTION_NOT_FOUND);
  });

  // ---------------------------------------------------------------------------
  // 4. Lessons
  // ---------------------------------------------------------------------------
  it('adds text lessons with sequential order', async () => {
    const teacher = await registerApprovedTeacher('lessons@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const first = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Lesson One',
      content: 'First content',
    });
    expect(first.status).toBe(201);
    expect(first.body.data.course.sections[0].lessons[0].order).toBe(1);

    const second = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Lesson Two',
      content: 'Second content',
    });
    expect(second.status).toBe(201);
    const lessons = second.body.data.course.sections[0].lessons as LessonDto[];
    expect(lessons.map((l) => l.title)).toEqual(['Lesson One', 'Lesson Two']);
    expect(lessons.map((l) => l.order)).toEqual([1, 2]);
  });

  it('adds a video lesson referencing an owned video', async () => {
    const teacher = await registerApprovedTeacher('video-lesson@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;
    const videoId = await createVideoRecord(teacher.userId);

    const res = await addLesson(teacher, course.id, sectionId, {
      type: 'video',
      title: 'Watch this',
      videoId,
    });

    expect(res.status).toBe(201);
    const lesson = res.body.data.course.sections[0].lessons[0] as LessonDto;
    expect(lesson.type).toBe('video');
    expect(lesson.videoId).toBe(videoId);
  });

  it('rejects a video lesson referencing a missing video', async () => {
    const teacher = await registerApprovedTeacher('missing-video@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const res = await addLesson(teacher, course.id, sectionId, {
      type: 'video',
      title: 'Ghost video',
      videoId: new mongoose.Types.ObjectId().toString(),
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_VIDEO_NOT_FOUND);
  });

  it('rejects a video lesson referencing another teacher video', async () => {
    const owner = await registerApprovedTeacher('video-owner@test.com');
    const other = await registerApprovedTeacher('video-thief@test.com');
    const course = await createCourse(owner);
    const withSection = await addSection(owner, course.id);
    const sectionId = withSection.sections[0].id;
    const foreignVideoId = await createVideoRecord(other.userId);

    const res = await addLesson(owner, course.id, sectionId, {
      type: 'video',
      title: 'Stolen video',
      videoId: foreignVideoId,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_VIDEO_FORBIDDEN);
  });

  it('rejects quiz lessons until the quiz system exists', async () => {
    const teacher = await registerApprovedTeacher('quiz@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const res = await addLesson(teacher, course.id, sectionId, {
      type: 'quiz',
      title: 'Quiz time',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_TYPE_UNSUPPORTED);
  });

  it('supports document lessons and validates the URL', async () => {
    const teacher = await registerApprovedTeacher('document@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const ok = await addLesson(teacher, course.id, sectionId, {
      type: 'document',
      title: 'Handout',
      documentUrl: 'https://example.com/handout.pdf',
      documentName: 'handout.pdf',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.course.sections[0].lessons[0].documentUrl).toBe(
      'https://example.com/handout.pdf',
    );

    const bad = await addLesson(teacher, course.id, sectionId, {
      type: 'document',
      title: 'Bad handout',
      documentUrl: 'not-a-url',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires the type-specific payload on creation', async () => {
    const teacher = await registerApprovedTeacher('payload@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const textWithoutContent = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'No content',
    });
    expect(textWithoutContent.status).toBe(422);

    const videoWithoutId = await addLesson(teacher, course.id, sectionId, {
      type: 'video',
      title: 'No video',
    });
    expect(videoWithoutId.status).toBe(422);
  });

  it('updates a lesson title', async () => {
    const teacher = await registerApprovedTeacher('lesson-update@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const created = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Old',
      content: 'content',
    });
    const lessonId = created.body.data.course.sections[0].lessons[0].id;

    const res = await request(app)
      .patch(
        `/api/teacher/courses/${course.id}/sections/${sectionId}/lessons/${lessonId}`,
      )
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'New' });

    expect(res.status).toBe(200);
    expect(res.body.data.course.sections[0].lessons[0].title).toBe('New');
  });

  it('clears the old payload when a lesson switches type', async () => {
    const teacher = await registerApprovedTeacher('switch@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;
    const videoId = await createVideoRecord(teacher.userId);

    const created = await addLesson(teacher, course.id, sectionId, {
      type: 'video',
      title: 'Was a video',
      videoId,
    });
    const lessonId = created.body.data.course.sections[0].lessons[0].id;

    const res = await request(app)
      .patch(
        `/api/teacher/courses/${course.id}/sections/${sectionId}/lessons/${lessonId}`,
      )
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ type: 'text', content: 'Now it is text' });

    expect(res.status).toBe(200);
    const lesson = res.body.data.course.sections[0].lessons[0] as LessonDto;
    expect(lesson.type).toBe('text');
    expect(lesson.content).toBe('Now it is text');
    expect(lesson.videoId).toBeUndefined();

    const persisted = await LessonModel.findById(lessonId).exec();
    expect(persisted?.videoId).toBeUndefined();
    expect(persisted?.content).toBe('Now it is text');
  });

  it('rejects a type switch that omits the new payload', async () => {
    const teacher = await registerApprovedTeacher('switch-bad@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const created = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Text lesson',
      content: 'content',
    });
    const lessonId = created.body.data.course.sections[0].lessons[0].id;

    const res = await request(app)
      .patch(
        `/api/teacher/courses/${course.id}/sections/${sectionId}/lessons/${lessonId}`,
      )
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ type: 'video' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED);
  });

  it('rejects a payload that does not match the lesson type', async () => {
    const teacher = await registerApprovedTeacher('mismatch@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const created = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Text lesson',
      content: 'content',
    });
    const lessonId = created.body.data.course.sections[0].lessons[0].id;

    const res = await request(app)
      .patch(
        `/api/teacher/courses/${course.id}/sections/${sectionId}/lessons/${lessonId}`,
      )
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ videoId: new mongoose.Types.ObjectId().toString() });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('deletes a lesson', async () => {
    const teacher = await registerApprovedTeacher('del-lesson@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    const created = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Delete me',
      content: 'content',
    });
    const lessonId = created.body.data.course.sections[0].lessons[0].id;

    const res = await request(app)
      .delete(
        `/api/teacher/courses/${course.id}/sections/${sectionId}/lessons/${lessonId}`,
      )
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);

    expect(res.status).toBe(200);
    expect(res.body.data.course.sections[0].lessons).toHaveLength(0);
    expect(await LessonModel.countDocuments({ sectionId })).toBe(0);
  });

  it('reorders lessons within a section', async () => {
    const teacher = await registerApprovedTeacher('lesson-order@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;

    await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'One',
      content: '1',
    });
    await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Two',
      content: '2',
    });
    const third = await addLesson(teacher, course.id, sectionId, {
      type: 'text',
      title: 'Three',
      content: '3',
    });
    const lessons = third.body.data.course.sections[0].lessons as LessonDto[];

    const res = await request(app)
      .put(
        `/api/teacher/courses/${course.id}/sections/${sectionId}/lessons/reorder`,
      )
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ lessonIds: [lessons[2].id, lessons[0].id, lessons[1].id] });

    expect(res.status).toBe(200);
    const reordered = res.body.data.course.sections[0].lessons as LessonDto[];
    expect(reordered.map((l) => l.title)).toEqual(['Three', 'One', 'Two']);
    expect(reordered.map((l) => l.order)).toEqual([1, 2, 3]);
  });

  it('returns 404 when adding a lesson to a missing section', async () => {
    const teacher = await registerApprovedTeacher('missing-section@test.com');
    const course = await createCourse(teacher);

    const res = await addLesson(
      teacher,
      course.id,
      new mongoose.Types.ObjectId().toString(),
      { type: 'text', title: 'Orphan', content: 'content' },
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(COURSE_ERRORS.SECTION_NOT_FOUND);
  });

  it('forbids another teacher from modifying sections and lessons', async () => {
    const owner = await registerApprovedTeacher('struct-owner@test.com');
    const intruder = await registerApprovedTeacher('struct-intruder@test.com');
    const course = await createCourse(owner);
    const withSection = await addSection(owner, course.id);
    const sectionId = withSection.sections[0].id;
    const created = await addLesson(owner, course.id, sectionId, {
      type: 'text',
      title: 'Owned lesson',
      content: 'content',
    });
    const lessonId = created.body.data.course.sections[0].lessons[0].id;

    const editSection = await request(app)
      .patch(`/api/teacher/courses/${course.id}/sections/${sectionId}`)
      .set('Cookie', intruder.cookies)
      .set('X-CSRF-Token', intruder.csrf)
      .send({ title: 'Hijacked' });
    expect(editSection.status).toBe(403);
    expect(editSection.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);

    const deleteLesson = await request(app)
      .delete(
        `/api/teacher/courses/${course.id}/sections/${sectionId}/lessons/${lessonId}`,
      )
      .set('Cookie', intruder.cookies)
      .set('X-CSRF-Token', intruder.csrf);
    expect(deleteLesson.status).toBe(403);
    expect(deleteLesson.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);

    // The lesson survived.
    expect(await LessonModel.findById(lessonId).exec()).not.toBeNull();
  });

  it('persists ordering in the database, not just in the response', async () => {
    const teacher = await registerApprovedTeacher('persist@test.com');
    const course = await createCourse(teacher);
    await addSection(teacher, course.id, 'First');
    const second = await addSection(teacher, course.id, 'Second');
    const [first, secondSection] = second.sections;

    await request(app)
      .put(`/api/teacher/courses/${course.id}/sections/reorder`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ sectionIds: [secondSection.id, first.id] });

    const stored = await SectionModel.find({ courseId: course.id })
      .sort({ order: 1 })
      .exec();
    expect(stored.map((s) => s.title)).toEqual(['Second', 'First']);
    expect(stored.map((s) => s.order)).toEqual([1, 2]);
  });
});
