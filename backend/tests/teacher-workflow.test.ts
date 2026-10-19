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
 * Strict database safety assertion (mirrors the auth/video/course suites):
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
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  rejectionReason?: string;
  sections: SectionDto[];
}

describe('Teacher Workflow Integration Tests', () => {
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
      name: input.name ?? 'Workflow Test User',
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

  async function registerApprovedTeacher(email: string): Promise<TestSession> {
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

  async function addTextLesson(
    session: TestSession,
    courseId: string,
    sectionId: string,
    title = 'Lesson 1',
  ): Promise<CourseDto> {
    const res = await request(app)
      .post(`/api/teacher/courses/${courseId}/sections/${sectionId}/lessons`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send({ type: 'text', title, content: 'Lesson body' });

    expect(res.status).toBe(201);
    return res.body.data.course as CourseDto;
  }

  function submit(session: TestSession, courseId: string, body?: unknown) {
    return request(app)
      .post(`/api/teacher/courses/${courseId}/submit`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send(body ?? {});
  }

  function approve(session: TestSession, courseId: string, body?: unknown) {
    return request(app)
      .post(`/api/admin/courses/${courseId}/approve`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send(body ?? {});
  }

  function reject(session: TestSession, courseId: string, body: unknown) {
    return request(app)
      .post(`/api/admin/courses/${courseId}/reject`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send(body);
  }

  async function createPendingCourse(
    teacher: TestSession,
  ): Promise<CourseDto> {
    const course = await createCourse(teacher);
    const res = await submit(teacher, course.id);
    expect(res.status).toBe(200);
    return res.body.data.course as CourseDto;
  }

  // ---------------------------------------------------------------------------
  // 1. Submission
  // ---------------------------------------------------------------------------
  it('lets the owner submit a draft course for review', async () => {
    const teacher = await registerApprovedTeacher('submit@test.com');
    const course = await createCourse(teacher);
    expect(course.status).toBe('draft');

    const res = await submit(teacher, course.id);

    expect(res.status).toBe(200);
    const submitted = res.body.data.course as CourseDto;
    expect(submitted.status).toBe('pending_review');
    expect(submitted.submittedAt).toBeDefined();
    expect(submitted.reviewedAt).toBeUndefined();
    expect(submitted.reviewedBy).toBeUndefined();
    expect(submitted.rejectionReason).toBeUndefined();

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('pending_review');
    expect(stored?.submittedAt).toBeInstanceOf(Date);
    expect(stored?.reviewedBy).toBeUndefined();
  });

  it('rejects submission by non-owners, including admins', async () => {
    const owner = await registerApprovedTeacher('submit-owner@test.com');
    const intruder = await registerApprovedTeacher('submit-intruder@test.com');
    const admin = await createAdmin('submit-admin@test.com');
    const course = await createCourse(owner);

    const byTeacher = await submit(intruder, course.id);
    expect(byTeacher.status).toBe(403);
    expect(byTeacher.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);

    const byAdmin = await submit(admin, course.id);
    expect(byAdmin.status).toBe(403);
    expect(byAdmin.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);

    const missing = await submit(
      owner,
      new mongoose.Types.ObjectId().toString(),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);
  });

  it('rejects submitting a course that is already under review or approved', async () => {
    const teacher = await registerApprovedTeacher('resubmit@test.com');
    const admin = await createAdmin('resubmit-admin@test.com');
    const course = await createCourse(teacher);

    expect((await submit(teacher, course.id)).status).toBe(200);

    const twice = await submit(teacher, course.id);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe(
      COURSE_ERRORS.INVALID_STATUS_TRANSITION,
    );

    expect((await approve(admin, course.id)).status).toBe(200);

    const afterApproval = await submit(teacher, course.id);
    expect(afterApproval.status).toBe(409);
    expect(afterApproval.body.error.code).toBe(
      COURSE_ERRORS.INVALID_STATUS_TRANSITION,
    );
  });

  it('ignores client-supplied status and review fields on submission', async () => {
    const teacher = await registerApprovedTeacher('submit-fields@test.com');
    const course = await createCourse(teacher);

    const res = await submit(teacher, course.id, {
      status: 'approved',
      reviewedBy: teacher.userId,
      reviewedAt: new Date().toISOString(),
      rejectionReason: 'self-approved',
    });

    expect(res.status).toBe(200);
    const submitted = res.body.data.course as CourseDto;
    expect(submitted.status).toBe('pending_review');
    expect(submitted.reviewedBy).toBeUndefined();
    expect(submitted.rejectionReason).toBeUndefined();

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('pending_review');
    expect(stored?.reviewedBy).toBeUndefined();
  });

  it('requires a CSRF token for submission', async () => {
    const teacher = await registerApprovedTeacher('submit-csrf@test.com');
    const course = await createCourse(teacher);

    const res = await request(app)
      .post(`/api/teacher/courses/${course.id}/submit`)
      .set('Cookie', teacher.cookies);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_MISSING);
  });

  // ---------------------------------------------------------------------------
  // 2. Admin moderation
  // ---------------------------------------------------------------------------
  it('lists pending submissions for an admin, with filtering and pagination', async () => {
    const teacher = await registerApprovedTeacher('queue@test.com');
    const admin = await createAdmin('queue-admin@test.com');

    const first = await createPendingCourse(teacher);
    const second = await createPendingCourse(teacher);
    const draft = await createCourse(teacher, 'Still a draft');

    const pending = await request(app)
      .get('/api/admin/courses')
      .set('Cookie', admin.cookies);

    expect(pending.status).toBe(200);
    expect(pending.body.meta).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
    });
    const pendingIds = (pending.body.data as CourseDto[]).map((c) => c.id);
    expect(pendingIds).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(pendingIds).not.toContain(draft.id);

    const page = await request(app)
      .get('/api/admin/courses?status=pending_review&page=1&limit=1')
      .set('Cookie', admin.cookies);
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta.total).toBe(2);
    expect(page.body.meta.totalPages).toBe(2);

    const drafts = await request(app)
      .get('/api/admin/courses?status=draft')
      .set('Cookie', admin.cookies);
    expect(drafts.status).toBe(200);
    expect(drafts.body.meta.total).toBe(1);
    expect(drafts.body.data[0].id).toBe(draft.id);

    const invalid = await request(app)
      .get('/api/admin/courses?status=not-a-status')
      .set('Cookie', admin.cookies);
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('restricts moderation endpoints to admins', async () => {
    const teacher = await registerApprovedTeacher('not-admin@test.com');
    const student = await registerUser({
      email: 'student-admin@test.com',
      role: 'student',
    });
    const course = await createPendingCourse(teacher);

    const listAsTeacher = await request(app)
      .get('/api/admin/courses')
      .set('Cookie', teacher.cookies);
    expect(listAsTeacher.status).toBe(403);
    expect(listAsTeacher.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const detailAsTeacher = await request(app)
      .get(`/api/admin/courses/${course.id}`)
      .set('Cookie', teacher.cookies);
    expect(detailAsTeacher.status).toBe(403);

    const approveAsTeacher = await approve(teacher, course.id);
    expect(approveAsTeacher.status).toBe(403);
    expect(approveAsTeacher.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const rejectAsTeacher = await reject(teacher, course.id, {
      reason: 'Trying to self-review',
    });
    expect(rejectAsTeacher.status).toBe(403);

    const listAsStudent = await request(app)
      .get('/api/admin/courses')
      .set('Cookie', student.cookies);
    expect(listAsStudent.status).toBe(403);

    const listUnauthenticated = await request(app).get('/api/admin/courses');
    expect(listUnauthenticated.status).toBe(401);
  });

  it('returns the full course to an admin for review', async () => {
    const teacher = await registerApprovedTeacher('review-detail@test.com');
    const admin = await createAdmin('review-detail-admin@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id, 'Intro');
    const sectionId = withSection.sections[0].id;
    await addTextLesson(teacher, course.id, sectionId, 'Welcome');
    await submit(teacher, course.id);

    const res = await request(app)
      .get(`/api/admin/courses/${course.id}`)
      .set('Cookie', admin.cookies);

    expect(res.status).toBe(200);
    const detail = res.body.data.course as CourseDto;
    expect(detail.ownerId).toBe(teacher.userId);
    expect(detail.status).toBe('pending_review');
    expect(detail.sections).toHaveLength(1);
    expect(detail.sections[0].lessons).toHaveLength(1);
  });

  it('approves a pending submission and records the reviewer', async () => {
    const teacher = await registerApprovedTeacher('approve@test.com');
    const admin = await createAdmin('approve-admin@test.com');
    const course = await createPendingCourse(teacher);

    const res = await approve(admin, course.id, {
      // Server-owned: must be ignored.
      status: 'rejected',
      reviewedBy: teacher.userId,
      rejectionReason: 'ignored',
    });

    expect(res.status).toBe(200);
    const approved = res.body.data.course as CourseDto;
    expect(approved.status).toBe('approved');
    expect(approved.reviewedAt).toBeDefined();
    expect(approved.reviewedBy).toBe(admin.userId);
    expect(approved.rejectionReason).toBeUndefined();
    expect(approved.submittedAt).toBe(course.submittedAt);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('approved');
    expect(stored?.reviewedBy?.toString()).toBe(admin.userId);
    expect(stored?.reviewedAt).toBeInstanceOf(Date);
    expect(stored?.rejectionReason).toBeUndefined();
  });

  it('rejects a pending submission with a reason the owner can read', async () => {
    const teacher = await registerApprovedTeacher('reject@test.com');
    const admin = await createAdmin('reject-admin@test.com');
    const course = await createPendingCourse(teacher);

    const res = await reject(admin, course.id, {
      reason: '  Add a course thumbnail before resubmitting.  ',
    });

    expect(res.status).toBe(200);
    const rejected = res.body.data.course as CourseDto;
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe(
      'Add a course thumbnail before resubmitting.',
    );
    expect(rejected.reviewedAt).toBeDefined();
    expect(rejected.reviewedBy).toBe(admin.userId);

    // The owner sees the reason through the normal course detail endpoint.
    const ownerView = await request(app)
      .get(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.data.course.rejectionReason).toBe(
      'Add a course thumbnail before resubmitting.',
    );

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('rejected');
    expect(stored?.rejectionReason).toBe(
      'Add a course thumbnail before resubmitting.',
    );
  });

  it('validates the rejection reason and leaves the submission untouched', async () => {
    const teacher = await registerApprovedTeacher('reject-reason@test.com');
    const admin = await createAdmin('reject-reason-admin@test.com');
    const course = await createPendingCourse(teacher);

    for (const body of [
      {},
      { reason: '' },
      { reason: '   ' },
      { reason: 'a'.repeat(1001) },
      { reason: 42 },
    ]) {
      const res = await reject(admin, course.id, body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('pending_review');
    expect(stored?.rejectionReason).toBeUndefined();
  });

  it('does not review a draft course', async () => {
    const teacher = await registerApprovedTeacher('review-draft@test.com');
    const admin = await createAdmin('review-draft-admin@test.com');
    const course = await createCourse(teacher);

    const approveDraft = await approve(admin, course.id);
    expect(approveDraft.status).toBe(409);
    expect(approveDraft.body.error.code).toBe(
      COURSE_ERRORS.INVALID_STATUS_TRANSITION,
    );

    const rejectDraft = await reject(admin, course.id, {
      reason: 'Not submitted',
    });
    expect(rejectDraft.status).toBe(409);
    expect(rejectDraft.body.error.code).toBe(
      COURSE_ERRORS.INVALID_STATUS_TRANSITION,
    );
  });

  it('does not review an already-reviewed course', async () => {
    const teacher = await registerApprovedTeacher('review-twice@test.com');
    const admin = await createAdmin('review-twice-admin@test.com');

    const approvedCourse = await createPendingCourse(teacher);
    expect((await approve(admin, approvedCourse.id)).status).toBe(200);

    for (const res of [
      await approve(admin, approvedCourse.id),
      await reject(admin, approvedCourse.id, { reason: 'Too late' }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(
        COURSE_ERRORS.INVALID_STATUS_TRANSITION,
      );
    }

    const rejectedCourse = await createPendingCourse(teacher);
    expect(
      (await reject(admin, rejectedCourse.id, { reason: 'Fix it' })).status,
    ).toBe(200);

    for (const res of [
      await reject(admin, rejectedCourse.id, { reason: 'Again' }),
      await approve(admin, rejectedCourse.id),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(
        COURSE_ERRORS.INVALID_STATUS_TRANSITION,
      );
    }
  });

  it('returns 404 when reviewing a missing course', async () => {
    const admin = await createAdmin('review-missing-admin@test.com');
    const missingId = new mongoose.Types.ObjectId().toString();

    const approveRes = await approve(admin, missingId);
    expect(approveRes.status).toBe(404);
    expect(approveRes.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);

    const rejectRes = await reject(admin, missingId, { reason: 'Missing' });
    expect(rejectRes.status).toBe(404);
    expect(rejectRes.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);
  });

  it('requires a CSRF token for admin review decisions', async () => {
    const teacher = await registerApprovedTeacher('review-csrf@test.com');
    const admin = await createAdmin('review-csrf-admin@test.com');
    const course = await createPendingCourse(teacher);

    const approveRes = await request(app)
      .post(`/api/admin/courses/${course.id}/approve`)
      .set('Cookie', admin.cookies);
    expect(approveRes.status).toBe(403);
    expect(approveRes.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_MISSING);

    const rejectRes = await request(app)
      .post(`/api/admin/courses/${course.id}/reject`)
      .set('Cookie', admin.cookies)
      .send({ reason: 'No token' });
    expect(rejectRes.status).toBe(403);
    expect(rejectRes.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_MISSING);
  });

  // ---------------------------------------------------------------------------
  // 3. Editing, locking and resubmission
  // ---------------------------------------------------------------------------
  it('locks all content mutations while a course is pending review', async () => {
    const teacher = await registerApprovedTeacher('locked@test.com');
    const course = await createCourse(teacher);
    const withSections = await addSection(teacher, course.id, 'Section A');
    const sectionA = withSections.sections[0];
    const withSecond = await addSection(teacher, course.id, 'Section B');
    const sectionB = withSecond.sections[1];
    const withLesson = await addTextLesson(
      teacher,
      course.id,
      sectionA.id,
      'Lesson A',
    );
    const lessonId = withLesson.sections[0].lessons[0].id;

    expect((await submit(teacher, course.id)).status).toBe(200);

    const attempts = [];

    attempts.push(
      await request(app)
        .patch(`/api/teacher/courses/${course.id}`)
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf)
        .send({ title: 'Changed while under review' }),
    );
    attempts.push(
      await request(app)
        .post(`/api/teacher/courses/${course.id}/sections`)
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf)
        .send({ title: 'Locked section' }),
    );
    attempts.push(
      await request(app)
        .patch(
          `/api/teacher/courses/${course.id}/sections/${sectionA.id}`,
        )
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf)
        .send({ title: 'Locked edit' }),
    );
    attempts.push(
      await request(app)
        .delete(`/api/teacher/courses/${course.id}/sections/${sectionA.id}`)
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf),
    );
    attempts.push(
      await request(app)
        .put(`/api/teacher/courses/${course.id}/sections/reorder`)
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf)
        .send({ sectionIds: [sectionB.id, sectionA.id] }),
    );
    attempts.push(
      await request(app)
        .post(
          `/api/teacher/courses/${course.id}/sections/${sectionA.id}/lessons`,
        )
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf)
        .send({ type: 'text', title: 'Locked lesson', content: 'x' }),
    );
    attempts.push(
      await request(app)
        .patch(
          `/api/teacher/courses/${course.id}/sections/${sectionA.id}/lessons/${lessonId}`,
        )
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf)
        .send({ title: 'Locked lesson edit' }),
    );
    attempts.push(
      await request(app)
        .delete(
          `/api/teacher/courses/${course.id}/sections/${sectionA.id}/lessons/${lessonId}`,
        )
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf),
    );
    attempts.push(
      await request(app)
        .put(
          `/api/teacher/courses/${course.id}/sections/${sectionA.id}/lessons/reorder`,
        )
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf)
        .send({ lessonIds: [lessonId] }),
    );

    for (const res of attempts) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_EDITABLE);
    }

    // Nothing changed while the course was locked.
    expect(await SectionModel.countDocuments({ courseId: course.id })).toBe(2);
    expect(await LessonModel.countDocuments({ courseId: course.id })).toBe(1);
    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.title).toBe(course.title);
    expect(stored?.status).toBe('pending_review');
  });

  it('allows editing and resubmitting a rejected course, clearing the old review', async () => {
    const teacher = await registerApprovedTeacher('resubmit-rejected@test.com');
    const admin = await createAdmin('resubmit-rejected-admin@test.com');
    const course = await createPendingCourse(teacher);

    const rejectedRes = await reject(admin, course.id, {
      reason: 'Add more detail',
    });
    expect(rejectedRes.status).toBe(200);
    const rejected = rejectedRes.body.data.course as CourseDto;
    expect(rejected.status).toBe('rejected');

    const edit = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Advanced Algebra, revised' });
    expect(edit.status).toBe(200);
    expect(edit.body.data.course.title).toBe('Advanced Algebra, revised');

    const resubmitted = await submit(teacher, course.id);
    expect(resubmitted.status).toBe(200);
    const pending = resubmitted.body.data.course as CourseDto;
    expect(pending.status).toBe('pending_review');
    expect(pending.rejectionReason).toBeUndefined();
    expect(pending.reviewedAt).toBeUndefined();
    expect(pending.reviewedBy).toBeUndefined();
    expect(pending.submittedAt).toBeDefined();
    expect(
      new Date(pending.submittedAt!).getTime(),
    ).toBeGreaterThanOrEqual(new Date(rejected.submittedAt!).getTime());

    // The revised version can be reviewed and approved normally.
    const approvedRes = await approve(admin, course.id);
    expect(approvedRes.status).toBe(200);
    expect(approvedRes.body.data.course.status).toBe('approved');
  });

  it('keeps an approved course locked for editing', async () => {
    const teacher = await registerApprovedTeacher('approved-locked@test.com');
    const admin = await createAdmin('approved-locked-admin@test.com');
    const course = await createPendingCourse(teacher);
    expect((await approve(admin, course.id)).status).toBe(200);

    const res = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Edited after approval' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_EDITABLE);
  });

  it('ignores server-owned fields on course updates', async () => {
    const teacher = await registerApprovedTeacher('update-fields@test.com');
    const other = await registerApprovedTeacher('update-fields-other@test.com');
    const course = await createCourse(teacher);

    const res = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({
        title: 'Renamed',
        status: 'approved',
        ownerId: other.userId,
        slug: 'attacker-chosen-slug',
        reviewedBy: teacher.userId,
        rejectionReason: 'forged',
      });

    expect(res.status).toBe(200);
    const updated = res.body.data.course as CourseDto;
    expect(updated.title).toBe('Renamed');
    expect(updated.status).toBe('draft');
    expect(updated.ownerId).toBe(teacher.userId);
    expect(updated.slug).toBe(course.slug);
    expect(updated.reviewedBy).toBeUndefined();
    expect(updated.rejectionReason).toBeUndefined();
  });
});
