import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { VideoModel } from '../src/modules/videos/video.model.js';
import { CourseModel } from '../src/modules/courses/course.model.js';
import { CategoryModel } from '../src/modules/categories/category.model.js';
import { CategoryLockModel } from '../src/modules/categories/category-lock.model.js';
import { SectionModel } from '../src/modules/courses/section.model.js';
import { LessonModel } from '../src/modules/courses/lesson.model.js';
import {
  COURSE_EDITABLE_STATUSES,
  COURSE_EDIT_LOCK_TTL_MS,
  COURSE_ERRORS,
} from '../src/modules/courses/course.constants.js';
import { CourseRepository } from '../src/modules/courses/course.repository.js';
import { CourseService } from '../src/modules/courses/course.service.js';
import {
  toManagedCourse,
  toPublicCourse,
} from '../src/modules/courses/course.mapper.js';
import {
  sectionRepository,
  SectionRepository,
} from '../src/modules/courses/section.repository.js';
import { lessonRepository } from '../src/modules/courses/lesson.repository.js';
import { videoRepository } from '../src/modules/videos/video.repository.js';
import type { AuthUser } from '../src/modules/users/user.types.js';
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
    await CategoryLockModel.deleteMany({});
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
    await CategoryLockModel.deleteMany({});
    await SectionModel.deleteMany({});
    await LessonModel.deleteMany({});

    const category = await CategoryModel.create({
      name: 'Workflow Category',
      slug: 'workflow-category',
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
      .send({
        title,
        description: 'A complete algebra course',
        categoryId: defaultCategoryId,
      });

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

  function deferred() {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });

    return { promise, resolve, reject };
  }

  /**
   * Acquire a lease the way the service does: claim the course lock, then move
   * every existing content document onto the same token/expiry.
   */
  async function acquireTestFence(courseId: string) {
    const repo = new CourseRepository();
    const locked = await repo.acquireEditLock(
      courseId,
      COURSE_EDITABLE_STATUSES,
    );
    expect(locked).not.toBeNull();

    const token = locked!.editLockToken!;
    const expiresAt = locked!.editLeaseExpiresAt!;
    await sectionRepository.refreshLease(courseId, token, expiresAt);
    await lessonRepository.refreshLease(courseId, token, expiresAt);

    return {
      repo,
      locked: locked!,
      fence: { token, expiresAt },
    };
  }

  /**
   * Simulate wall-clock expiry for both the course lease and the denormalized
   * content fences. New writes use MongoDB time, so they fail immediately.
   */
  async function expireTestFence(courseId: string): Promise<void> {
    const past = new Date(Date.now() - 1000);
    await CourseModel.updateOne(
      { _id: courseId },
      {
        $set: {
          editLockedAt: new Date(
            Date.now() - COURSE_EDIT_LOCK_TTL_MS - 1000,
          ),
          editLeaseExpiresAt: past,
        },
      },
    ).exec();
    await SectionModel.updateMany(
      { courseId },
      { $set: { editLeaseExpiresAt: past } },
    ).exec();
    await LessonModel.updateMany(
      { courseId },
      { $set: { editLeaseExpiresAt: past } },
    ).exec();
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
      editLocked: true,
      editLockedAt: new Date().toISOString(),
    });

    expect(res.status).toBe(200);
    const submitted = res.body.data.course as CourseDto;
    expect(submitted.status).toBe('pending_review');
    expect(submitted.reviewedBy).toBeUndefined();
    expect(submitted.rejectionReason).toBeUndefined();
    expect(submitted).not.toHaveProperty('editLocked');
    expect(submitted).not.toHaveProperty('editLockedAt');
    expect(submitted).not.toHaveProperty('editLockToken');

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
        submittedAt: new Date(0).toISOString(),
        reviewedBy: teacher.userId,
        reviewedAt: new Date(0).toISOString(),
        rejectionReason: 'forged',
        editLocked: true,
        editLockedAt: new Date().toISOString(),
        editLockToken: 'forged-token',
        editLeaseExpiresAt: new Date(0).toISOString(),
      });

    expect(res.status).toBe(200);
    const updated = res.body.data.course as CourseDto;
    expect(updated.title).toBe('Renamed');
    expect(updated.status).toBe('draft');
    expect(updated.ownerId).toBe(teacher.userId);
    expect(updated.slug).toBe(course.slug);
    expect(updated.submittedAt).toBeUndefined();
    expect(updated.reviewedAt).toBeUndefined();
    expect(updated.reviewedBy).toBeUndefined();
    expect(updated.rejectionReason).toBeUndefined();
    expect(updated).not.toHaveProperty('editLocked');
    expect(updated).not.toHaveProperty('editLockedAt');
    expect(updated).not.toHaveProperty('editLockToken');
    expect(updated).not.toHaveProperty('editLeaseExpiresAt');
  });

  // ---------------------------------------------------------------------------
  // 4. Edit/submission races and deletion policy
  // ---------------------------------------------------------------------------
  it('blocks submission while a content edit lease is held, then allows retry', async () => {
    const teacher = await registerApprovedTeacher('lease-submit@test.com');
    const course = await createCourse(teacher);
    const repo = new CourseRepository();

    const locked = await repo.acquireEditLock(
      course.id,
      COURSE_EDITABLE_STATUSES,
    );
    expect(locked).not.toBeNull();
    expect(locked?.editLocked).toBe(true);

    const blocked = await submit(teacher, course.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe(
      COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS,
    );
    expect((await CourseModel.findById(course.id).exec())?.status).toBe('draft');

    await repo.releaseEditLock(course.id, locked!.editLockToken!);

    const retried = await submit(teacher, course.id);
    expect(retried.status).toBe(200);
    const submitted = retried.body.data.course as CourseDto;
    expect(submitted.status).toBe('pending_review');
    expect(submitted).not.toHaveProperty('editLocked');
    expect(submitted).not.toHaveProperty('editLockedAt');
  });

  it('retries submission when the competing edit releases before the retry read', async () => {
    const teacher = await registerApprovedTeacher('lease-submit-release@test.com');
    const course = await createCourse(teacher);
    const repo = new CourseRepository();

    const locked = await repo.acquireEditLock(
      course.id,
      COURSE_EDITABLE_STATUSES,
    );
    expect(locked?.editLockToken).toBeDefined();

    let findCalls = 0;
    class ReleasingCourseRepository extends CourseRepository {
      override async findById(
        ...args: Parameters<CourseRepository['findById']>
      ) {
        findCalls += 1;

        // The first read loads the course while the other edit holds the lease.
        // By the second read that edit has finished and released the lease
        // without changing the course status or submission identity.
        if (findCalls === 2) {
          await this.releaseEditLock(args[0], locked!.editLockToken!);
        }

        return super.findById(...args);
      }
    }

    const service = new CourseService(
      new ReleasingCourseRepository(),
      sectionRepository,
      lessonRepository,
      videoRepository,
    );
    const owner: AuthUser = {
      id: teacher.userId,
      email: 'lease-submit-release@test.com',
      role: 'teacher',
      teacherStatus: 'approved',
      isActive: true,
    };

    const submitted = await service.submitCourse({
      courseId: course.id,
      requester: owner,
    });

    expect(submitted.status).toBe('pending_review');
    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('pending_review');
    expect(stored?.editLocked).toBe(false);
  });

  it('serializes content edits with the per-course lease', async () => {
    const teacher = await registerApprovedTeacher('lease-edit@test.com');
    const course = await createCourse(teacher, 'Original Title');
    const repo = new CourseRepository();

    const locked = await repo.acquireEditLock(
      course.id,
      COURSE_EDITABLE_STATUSES,
    );

    const blocked = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Concurrent edit' });

    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe(
      COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS,
    );
    expect((await CourseModel.findById(course.id).exec())?.title).toBe(
      'Original Title',
    );

    await repo.releaseEditLock(course.id, locked!.editLockToken!);

    const allowed = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Sequential edit' });

    expect(allowed.status).toBe(200);
    expect(allowed.body.data.course.title).toBe('Sequential edit');
  });

  it('recovers an abandoned edit lease before submitting', async () => {
    const teacher = await registerApprovedTeacher('lease-stale@test.com');
    const course = await createCourse(teacher);

    await CourseModel.updateOne(
      { _id: course.id },
      {
        $set: {
          editLocked: true,
          editLockedAt: new Date(
            Date.now() - COURSE_EDIT_LOCK_TTL_MS - 1000,
          ),
        },
      },
    ).exec();

    const res = await submit(teacher, course.id);
    expect(res.status).toBe(200);
    expect(res.body.data.course.status).toBe('pending_review');

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.editLocked).toBe(false);
    expect(stored?.editLockedAt).toBeUndefined();
    expect(stored?.editLockToken).toBeUndefined();
  });

  it('does not let a stale holder release a newer edit lease', async () => {
    const teacher = await registerApprovedTeacher('lease-token@test.com');
    const course = await createCourse(teacher);
    const repo = new CourseRepository();

    const staleLock = await repo.acquireEditLock(
      course.id,
      COURSE_EDITABLE_STATUSES,
    );
    expect(staleLock?.editLockToken).toBeDefined();

    await CourseModel.updateOne(
      { _id: course.id },
      {
        $set: {
          editLockedAt: new Date(
            Date.now() - COURSE_EDIT_LOCK_TTL_MS - 1000,
          ),
          editLeaseExpiresAt: new Date(Date.now() - 1000),
        },
      },
    ).exec();

    expect(
      await repo.clearStaleEditLock(
        course.id,
        COURSE_EDITABLE_STATUSES,
        new Date(Date.now() - COURSE_EDIT_LOCK_TTL_MS),
      ),
    ).toBe(true);

    const freshLock = await repo.acquireEditLock(
      course.id,
      COURSE_EDITABLE_STATUSES,
    );
    expect(freshLock?.editLockToken).toBeDefined();
    expect(freshLock?.editLockToken).not.toBe(staleLock?.editLockToken);

    // The old, recovered request must not be able to release the new holder.
    await repo.releaseEditLock(course.id, staleLock!.editLockToken!);
    const stillLocked = await CourseModel.findById(course.id).exec();
    expect(stillLocked?.editLocked).toBe(true);
    expect(stillLocked?.editLockToken).toBe(freshLock?.editLockToken);

    await repo.releaseEditLock(course.id, freshLock!.editLockToken!);
    const unlocked = await CourseModel.findById(course.id).exec();
    expect(unlocked?.editLocked).toBe(false);
    expect(unlocked?.editLockToken).toBeUndefined();
  });

  it('rejects a stalled stale course update after another holder takes over', async () => {
    const teacher = await registerApprovedTeacher('stale-write-course@test.com');
    const course = await createCourse(teacher, 'Before the race');

    const reachedWrite = deferred();
    const finishWrite = deferred();
    class StallingCourseRepository extends CourseRepository {
      override async updateById(
        ...args: Parameters<CourseRepository['updateById']>
      ) {
        reachedWrite.resolve();
        await finishWrite.promise;
        return super.updateById(...args);
      }
    }

    const service = new CourseService(
      new StallingCourseRepository(),
      sectionRepository,
      lessonRepository,
      videoRepository,
    );
    const owner: AuthUser = {
      id: teacher.userId,
      email: 'stale-write-course@test.com',
      role: 'teacher',
      teacherStatus: 'approved',
      isActive: true,
    };

    const staleWrite = service.updateCourse({
      courseId: course.id,
      requester: owner,
      input: { title: 'Stale title' },
    });
    const staleResult = staleWrite.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    // The request has acquired the lease and is stalled at the write boundary.
    await reachedWrite.promise;
    await expireTestFence(course.id);

    const freshWrite = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Fresh title' });
    expect(freshWrite.status).toBe(200);
    expect(freshWrite.body.data.course.title).toBe('Fresh title');

    finishWrite.resolve();
    const settled = await staleResult;
    expect(settled.error).toMatchObject({
      statusCode: 409,
      code: COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS,
    });

    expect((await CourseModel.findById(course.id).exec())?.title).toBe(
      'Fresh title',
    );
  });

  it('rejects a stalled edit after submission recovers its lease', async () => {
    const teacher = await registerApprovedTeacher('stale-write-submit@test.com');
    const course = await createCourse(teacher, 'Submitted before stale write');

    const reachedWrite = deferred();
    const finishWrite = deferred();
    class StallingCourseRepository extends CourseRepository {
      override async updateById(
        ...args: Parameters<CourseRepository['updateById']>
      ) {
        reachedWrite.resolve();
        await finishWrite.promise;
        return super.updateById(...args);
      }
    }

    const service = new CourseService(
      new StallingCourseRepository(),
      sectionRepository,
      lessonRepository,
      videoRepository,
    );
    const owner: AuthUser = {
      id: teacher.userId,
      email: 'stale-write-submit@test.com',
      role: 'teacher',
      teacherStatus: 'approved',
      isActive: true,
    };

    const staleWrite = service.updateCourse({
      courseId: course.id,
      requester: owner,
      input: { title: 'Stale after submission' },
    });
    const staleResult = staleWrite.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    await reachedWrite.promise;
    await expireTestFence(course.id);

    const submitted = await submit(teacher, course.id);
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.course.status).toBe('pending_review');

    finishWrite.resolve();
    const settled = await staleResult;
    expect(settled.error).toMatchObject({
      statusCode: 409,
      code: COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS,
    });

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('pending_review');
    expect(stored?.title).toBe('Submitted before stale write');
  });

  it('rejects a stalled stale section update after another holder takes over', async () => {
    const teacher = await registerApprovedTeacher('stale-write-section@test.com');
    const course = await createCourse(teacher, 'Content race');
    const withSection = await addSection(teacher, course.id, 'Original section');
    const sectionId = withSection.sections[0].id;

    const reachedWrite = deferred();
    const finishWrite = deferred();
    class StallingSectionRepository extends SectionRepository {
      override async updateById(
        ...args: Parameters<SectionRepository['updateById']>
      ) {
        reachedWrite.resolve();
        await finishWrite.promise;
        return super.updateById(...args);
      }
    }

    const service = new CourseService(
      new CourseRepository(),
      new StallingSectionRepository(),
      lessonRepository,
      videoRepository,
    );
    const owner: AuthUser = {
      id: teacher.userId,
      email: 'stale-write-section@test.com',
      role: 'teacher',
      teacherStatus: 'approved',
      isActive: true,
    };

    const staleWrite = service.updateSection({
      courseId: course.id,
      sectionId,
      requester: owner,
      input: { title: 'Stale section title' },
    });
    const staleResult = staleWrite.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    await reachedWrite.promise;
    await expireTestFence(course.id);

    const freshWrite = await request(app)
      .patch(`/api/teacher/courses/${course.id}/sections/${sectionId}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Fresh section title' });
    expect(freshWrite.status).toBe(200);

    finishWrite.resolve();
    const settled = await staleResult;
    expect(settled.error).toMatchObject({
      statusCode: 409,
      code: COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS,
    });

    const stored = await SectionModel.findById(sectionId).exec();
    expect(stored?.title).toBe('Fresh section title');
  });

  it('rejects a stalled stale section create after lease recovery', async () => {
    const teacher = await registerApprovedTeacher('stale-create-section@test.com');
    const course = await createCourse(teacher, 'Create race');

    const reachedCreate = deferred();
    const finishCreate = deferred();
    class StallingSectionRepository extends SectionRepository {
      override async create(
        ...args: Parameters<SectionRepository['create']>
      ) {
        reachedCreate.resolve();
        await finishCreate.promise;
        return super.create(...args);
      }
    }

    const service = new CourseService(
      new CourseRepository(),
      new StallingSectionRepository(),
      lessonRepository,
      videoRepository,
    );
    const owner: AuthUser = {
      id: teacher.userId,
      email: 'stale-create-section@test.com',
      role: 'teacher',
      teacherStatus: 'approved',
      isActive: true,
    };

    const staleCreate = service.addSection({
      courseId: course.id,
      requester: owner,
      input: { title: 'Stale section' },
    });
    const staleResult = staleCreate.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    await reachedCreate.promise;
    await expireTestFence(course.id);

    const freshCreate = await request(app)
      .post(`/api/teacher/courses/${course.id}/sections`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Fresh section' });
    expect(freshCreate.status).toBe(201);

    finishCreate.resolve();
    const settled = await staleResult;
    expect(settled.error).toMatchObject({
      statusCode: 409,
      code: COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS,
    });

    const visible = await sectionRepository.listByCourse(course.id);
    expect(visible.map((section) => section.title)).toEqual(['Fresh section']);
    expect(
      await SectionModel.countDocuments({
        courseId: course.id,
        committed: false,
      }),
    ).toBeGreaterThan(0);
  });

  it('fences every course, section, and lesson write after lease recovery', async () => {
    const teacher = await registerApprovedTeacher('fence-matrix@test.com');
    let course = await createCourse(teacher, 'Fence matrix');
    course = await addSection(teacher, course.id, 'Section A');
    course = await addSection(teacher, course.id, 'Section B');
    const sectionA = course.sections[0];
    const sectionB = course.sections[1];
    course = await addTextLesson(
      teacher,
      course.id,
      sectionA.id,
      'Lesson A',
    );
    course = await addTextLesson(
      teacher,
      course.id,
      sectionA.id,
      'Lesson B',
    );
    const lessons = course.sections[0].lessons;
    const lessonA = lessons[0];
    const lessonB = lessons[1];

    const original = await acquireTestFence(course.id);
    const staleFence = original.fence;

    // Stage creates before takeover; these become the old holder's "finish
    // after recovery" attempts.
    const stalePreTakeoverSection = await sectionRepository.create(
      {
        courseId: course.id,
        title: 'Staged before takeover',
        order: 98,
      },
      staleFence,
    );
    const stalePreTakeoverLesson = await lessonRepository.create(
      {
        courseId: course.id,
        sectionId: sectionA.id,
        title: 'Staged lesson before takeover',
        type: 'text',
        content: 'Stale body',
        order: 98,
      },
      staleFence,
    );

    await expireTestFence(course.id);

    // Expiry alone is enough to reject a write, before any takeover.
    expect(
      await original.repo.updateById(
        course.id,
        { title: 'Expired course title' },
        [],
        staleFence,
      ),
    ).toBeNull();
    expect(
      await sectionRepository.updateById(
        sectionA.id,
        { title: 'Expired section title' },
        [],
        staleFence,
      ),
    ).toBeNull();
    expect(
      await lessonRepository.updateById(
        lessonA.id,
        { title: 'Expired lesson title' },
        [],
        staleFence,
      ),
    ).toBeNull();

    // Let the real service perform stale recovery and take over. Its snapshot
    // cleanup must remove rows that were staged before the takeover.
    const takeover = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Fence matrix' });
    expect(takeover.status).toBe(200);
    expect(
      await SectionModel.findById(stalePreTakeoverSection._id).exec(),
    ).toBeNull();
    expect(
      await LessonModel.findById(stalePreTakeoverLesson._id).exec(),
    ).toBeNull();

    const fresh = await acquireTestFence(course.id);
    expect(fresh.fence.token).not.toBe(staleFence.token);

    // Old holders cannot update, delete, reorder, or commit creates.
    expect(
      await fresh.repo.updateById(
        course.id,
        { title: 'Stale course title' },
        [],
        staleFence,
      ),
    ).toBeNull();
    expect(await fresh.repo.deleteById(course.id, staleFence)).toBe(false);

    expect(
      await sectionRepository.updateById(
        sectionA.id,
        { title: 'Stale section title' },
        [],
        staleFence,
      ),
    ).toBeNull();
    expect(await sectionRepository.deleteById(sectionA.id, staleFence)).toBe(
      false,
    );
    expect(
      await sectionRepository.updateOrders(
        course.id,
        [{ id: sectionA.id, order: 2 }],
        staleFence,
      ),
    ).toBe(false);

    // A staged row created before takeover was refreshed onto the new token,
    // so the old holder cannot commit it.
    expect(
      await sectionRepository.commitCreated(
        stalePreTakeoverSection._id.toString(),
        staleFence,
      ),
    ).toBeNull();
    expect(
      await lessonRepository.commitCreated(
        stalePreTakeoverLesson._id.toString(),
        staleFence,
      ),
    ).toBeNull();

    // A create that starts after takeover cannot pass the course-level
    // authorization point, even though it can still insert an invisible
    // staged row with its old token/expiry.
    const staleSection = await sectionRepository.create(
      {
        courseId: course.id,
        title: 'Stale staged section',
        order: 99,
      },
      staleFence,
    );
    expect(await fresh.repo.beginContentCommit(course.id, staleFence)).toBe(
      false,
    );
    expect(
      (await sectionRepository.listByCourse(course.id)).some(
        (section) => section._id.toString() === staleSection._id.toString(),
      ),
    ).toBe(false);

    expect(
      await lessonRepository.updateById(
        lessonA.id,
        { title: 'Stale lesson title' },
        [],
        staleFence,
      ),
    ).toBeNull();
    expect(await lessonRepository.deleteById(lessonA.id, staleFence)).toBe(
      false,
    );
    expect(
      await lessonRepository.updateOrders(
        sectionA.id,
        [{ id: lessonA.id, order: 2 }],
        staleFence,
      ),
    ).toBe(false);

    const staleLesson = await lessonRepository.create(
      {
        courseId: course.id,
        sectionId: sectionA.id,
        title: 'Stale staged lesson',
        type: 'text',
        content: 'Stale body',
        order: 99,
      },
      staleFence,
    );
    expect(await fresh.repo.beginContentCommit(course.id, staleFence)).toBe(
      false,
    );
    expect(
      (await lessonRepository.listBySection(sectionA.id)).some(
        (lesson) => lesson._id.toString() === staleLesson._id.toString(),
      ),
    ).toBe(false);

    // Nothing visible changed while the old holder was attempting to finish.
    expect((await CourseModel.findById(course.id).exec())?.title).toBe(
      'Fence matrix',
    );
    expect((await SectionModel.findById(sectionA.id).exec())?.title).toBe(
      'Section A',
    );
    expect((await LessonModel.findById(lessonA.id).exec())?.title).toBe(
      'Lesson A',
    );

    // A live fence can perform the same writes.
    expect(
      await fresh.repo.updateById(
        course.id,
        { title: 'Fresh course title' },
        [],
        fresh.fence,
      ),
    ).not.toBeNull();
    expect(
      await sectionRepository.updateById(
        sectionA.id,
        { title: 'Fresh section title' },
        [],
        fresh.fence,
      ),
    ).not.toBeNull();
    expect(
      await lessonRepository.updateById(
        lessonA.id,
        { title: 'Fresh lesson title' },
        [],
        fresh.fence,
      ),
    ).not.toBeNull();
    expect(
      await sectionRepository.updateOrders(
        course.id,
        [
          { id: sectionB.id, order: 1 },
          { id: sectionA.id, order: 2 },
        ],
        fresh.fence,
      ),
    ).toBe(true);
    expect(
      await lessonRepository.updateOrders(
        sectionA.id,
        [
          { id: lessonB.id, order: 1 },
          { id: lessonA.id, order: 2 },
        ],
        fresh.fence,
      ),
    ).toBe(true);

    const freshSection = await sectionRepository.create(
      {
        courseId: course.id,
        title: 'Fresh section',
        order: 3,
      },
      fresh.fence,
    );
    expect(
      await sectionRepository.commitCreated(
        freshSection._id.toString(),
        fresh.fence,
      ),
    ).not.toBeNull();

    const freshLesson = await lessonRepository.create(
      {
        courseId: course.id,
        sectionId: sectionA.id,
        title: 'Fresh lesson',
        type: 'text',
        content: 'Fresh body',
        order: 3,
      },
      fresh.fence,
    );
    expect(
      await lessonRepository.commitCreated(
        freshLesson._id.toString(),
        fresh.fence,
      ),
    ).not.toBeNull();

    expect(await fresh.repo.deleteById(course.id, fresh.fence)).toBe(true);
  });

  it('serializes concurrent submissions', async () => {
    const teacher = await registerApprovedTeacher('concurrent-submit@test.com');
    const course = await createCourse(teacher);

    const [first, second] = await Promise.all([
      submit(teacher, course.id),
      submit(teacher, course.id),
    ]);

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.error.code).toBe(
      COURSE_ERRORS.INVALID_STATUS_TRANSITION,
    );

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('pending_review');
    expect(stored?.submittedAt).toBeInstanceOf(Date);
  });

  it('allows only one of concurrent approve/reject decisions', async () => {
    const teacher = await registerApprovedTeacher('concurrent-review@test.com');
    const admin = await createAdmin('concurrent-review-admin@test.com');
    const course = await createPendingCourse(teacher);

    const [approveRes, rejectRes] = await Promise.all([
      approve(admin, course.id),
      reject(admin, course.id, { reason: 'Concurrent rejection' }),
    ]);

    expect(
      [approveRes.status, rejectRes.status].sort((a, b) => a - b),
    ).toEqual([200, 409]);
    const loser = approveRes.status === 409 ? approveRes : rejectRes;
    expect(loser.body.error.code).toBe(
      COURSE_ERRORS.INVALID_STATUS_TRANSITION,
    );

    const stored = await CourseModel.findById(course.id).exec();
    expect(['approved', 'rejected']).toContain(stored?.status);
    expect(stored?.reviewedBy?.toString()).toBe(admin.userId);
    expect(stored?.reviewedAt).toBeInstanceOf(Date);

    if (approveRes.status === 200) {
      expect(stored?.status).toBe('approved');
      expect(stored?.rejectionReason).toBeUndefined();
    } else {
      expect(stored?.status).toBe('rejected');
      expect(stored?.rejectionReason).toBe('Concurrent rejection');
    }
  });

  it('allows only one of concurrent approvals', async () => {
    const teacher = await registerApprovedTeacher('double-approve@test.com');
    const admin = await createAdmin('double-approve-admin@test.com');
    const course = await createPendingCourse(teacher);

    const [first, second] = await Promise.all([
      approve(admin, course.id),
      approve(admin, course.id),
    ]);

    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('approved');
    expect(stored?.reviewedBy?.toString()).toBe(admin.userId);
  });

  it('does not apply a stale review decision to a newer submission', async () => {
    const teacher = await registerApprovedTeacher('stale-review@test.com');
    const admin = await createAdmin('stale-review-admin@test.com');
    const course = await createPendingCourse(teacher);

    const staleSubmission = await CourseModel.findById(course.id).exec();
    expect(staleSubmission?.submittedAt).toBeInstanceOf(Date);

    expect(
      (await reject(admin, course.id, { reason: 'Fix the first submission' }))
        .status,
    ).toBe(200);

    const edit = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Revised for the second submission' });
    expect(edit.status).toBe(200);

    // Ensure the resubmission has a distinct timestamp from the first one.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const resubmitted = await submit(teacher, course.id);
    expect(resubmitted.status).toBe(200);
    const newSubmittedAt = resubmitted.body.data.course.submittedAt as string;
    expect(newSubmittedAt).not.toBe(staleSubmission?.submittedAt?.toISOString());

    // Simulate an admin request that read submission S1 but reaches the
    // service after the owner rejected/edited/resubmitted as S2.
    const staleRepo = new CourseRepository();
    staleRepo.findById = async () => staleSubmission;
    const service = new CourseService(
      staleRepo,
      sectionRepository,
      lessonRepository,
      videoRepository,
    );
    const adminUser: AuthUser = {
      id: admin.userId,
      email: 'stale-review-admin@test.com',
      role: 'admin',
      teacherStatus: 'none',
      isActive: true,
    };

    await expect(
      service.approveCourse({ courseId: course.id, requester: adminUser }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: COURSE_ERRORS.INVALID_STATUS_TRANSITION,
    });

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('pending_review');
    expect(stored?.reviewedBy).toBeUndefined();
    expect(stored?.submittedAt?.toISOString()).toBe(newSubmittedAt);
  });

  it('does not apply a stale submission request to a newer review cycle', async () => {
    const teacher = await registerApprovedTeacher('stale-submit@test.com');
    const admin = await createAdmin('stale-submit-admin@test.com');
    const course = await createCourse(teacher);

    expect((await submit(teacher, course.id)).status).toBe(200);
    expect(
      (await reject(admin, course.id, { reason: 'First pass' })).status,
    ).toBe(200);

    const staleRejected = await CourseModel.findById(course.id).exec();
    expect(staleRejected?.status).toBe('rejected');
    expect(staleRejected?.submittedAt).toBeInstanceOf(Date);

    const resubmitted = await submit(teacher, course.id);
    expect(resubmitted.status).toBe(200);
    const secondSubmittedAt = resubmitted.body.data.course
      .submittedAt as string;
    expect(secondSubmittedAt).not.toBe(
      staleRejected?.submittedAt?.toISOString(),
    );

    expect(
      (await reject(admin, course.id, { reason: 'Second pass' })).status,
    ).toBe(200);

    // Simulate a submit request that read the first rejection but reaches the
    // service after the owner has already resubmitted and been rejected again.
    // Only the first read is stale; the retry re-read sees the current
    // submission like the real repository would.
    const staleRepo = new CourseRepository();
    const liveFindById = CourseRepository.prototype.findById.bind(staleRepo);
    let findCalls = 0;
    staleRepo.findById = async (id: string) => {
      findCalls += 1;
      return findCalls === 1 ? staleRejected : liveFindById(id);
    };
    const service = new CourseService(
      staleRepo,
      sectionRepository,
      lessonRepository,
      videoRepository,
    );
    const ownerUser: AuthUser = {
      id: teacher.userId,
      email: 'stale-submit@test.com',
      role: 'teacher',
      teacherStatus: 'approved',
      isActive: true,
    };

    await expect(
      service.submitCourse({ courseId: course.id, requester: ownerUser }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: COURSE_ERRORS.INVALID_STATUS_TRANSITION,
    });

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('rejected');
    expect(stored?.submittedAt?.toISOString()).toBe(secondSubmittedAt);
    expect(stored?.rejectionReason).toBe('Second pass');
  });

  it('does not delete a course under review or after approval', async () => {
    const teacher = await registerApprovedTeacher('delete-pending@test.com');
    const admin = await createAdmin('delete-pending-admin@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;
    await addTextLesson(teacher, course.id, sectionId);
    expect((await submit(teacher, course.id)).status).toBe(200);

    const ownerDelete = await request(app)
      .delete(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);
    expect(ownerDelete.status).toBe(409);
    expect(ownerDelete.body.error.code).toBe(
      COURSE_ERRORS.COURSE_NOT_DELETABLE,
    );

    const adminDelete = await request(app)
      .delete(`/api/teacher/courses/${course.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf);
    expect(adminDelete.status).toBe(409);
    expect(adminDelete.body.error.code).toBe(
      COURSE_ERRORS.COURSE_NOT_DELETABLE,
    );

    expect((await approve(admin, course.id)).status).toBe(200);

    const approvedDelete = await request(app)
      .delete(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);
    expect(approvedDelete.status).toBe(409);
    expect(approvedDelete.body.error.code).toBe(
      COURSE_ERRORS.COURSE_NOT_DELETABLE,
    );

    // The reviewed course and its content survive every attempt.
    expect(await CourseModel.findById(course.id).exec()).not.toBeNull();
    expect(await SectionModel.countDocuments({ courseId: course.id })).toBe(1);
    expect(await LessonModel.countDocuments({ courseId: course.id })).toBe(1);
  });

  it('deletes a rejected course and cascades its content', async () => {
    const teacher = await registerApprovedTeacher('delete-rejected@test.com');
    const admin = await createAdmin('delete-rejected-admin@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;
    await addTextLesson(teacher, course.id, sectionId);
    expect((await submit(teacher, course.id)).status).toBe(200);
    expect(
      (await reject(admin, course.id, { reason: 'Start over' })).status,
    ).toBe(200);

    const res = await request(app)
      .delete(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);

    expect(res.status).toBe(200);
    expect(await CourseModel.findById(course.id).exec()).toBeNull();
    expect(await SectionModel.countDocuments({ courseId: course.id })).toBe(0);
    expect(await LessonModel.countDocuments({ courseId: course.id })).toBe(0);
  });

  it('does not cascade content when the fenced course delete loses its lease', async () => {
    const teacher = await registerApprovedTeacher('delete-fenced-failure@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;
    await addTextLesson(teacher, course.id, sectionId);

    let failNextDelete = true;
    class FailingCourseRepository extends CourseRepository {
      override async deleteById(
        ...args: Parameters<CourseRepository['deleteById']>
      ) {
        if (failNextDelete) {
          failNextDelete = false;
          return false;
        }
        return super.deleteById(...args);
      }
    }

    const service = new CourseService(
      new FailingCourseRepository(),
      sectionRepository,
      lessonRepository,
      videoRepository,
    );
    const owner: AuthUser = {
      id: teacher.userId,
      email: 'delete-fenced-failure@test.com',
      role: 'teacher',
      teacherStatus: 'approved',
      isActive: true,
    };

    await expect(
      service.deleteCourse({ courseId: course.id, requester: owner }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS,
    });

    // The failed fenced authorization must not start the cascade, and the
    // lease must be released so a retry can perform the deletion.
    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.editLocked).toBe(false);
    expect(await SectionModel.countDocuments({ courseId: course.id })).toBe(1);
    expect(await LessonModel.countDocuments({ courseId: course.id })).toBe(1);

    await service.deleteCourse({ courseId: course.id, requester: owner });
    expect(await CourseModel.findById(course.id).exec()).toBeNull();
    expect(await SectionModel.countDocuments({ courseId: course.id })).toBe(0);
    expect(await LessonModel.countDocuments({ courseId: course.id })).toBe(0);
  });

  it('keeps a course consistent when deletion and submission race', async () => {
    const teacher = await registerApprovedTeacher('delete-submit-race@test.com');
    const course = await createCourse(teacher);
    const withSection = await addSection(teacher, course.id);
    const sectionId = withSection.sections[0].id;
    await addTextLesson(teacher, course.id, sectionId);

    const [deleted, submitted] = await Promise.all([
      request(app)
        .delete(`/api/teacher/courses/${course.id}`)
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf),
      submit(teacher, course.id),
    ]);

    const stored = await CourseModel.findById(course.id).exec();
    const sectionCount = await SectionModel.countDocuments({
      courseId: course.id,
    });
    const lessonCount = await LessonModel.countDocuments({
      courseId: course.id,
    });

    if (stored) {
      // Submission won: the course is under review and the content is intact.
      expect(stored.status).toBe('pending_review');
      expect(deleted.status).toBe(409);
      expect(deleted.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_DELETABLE);
      expect(submitted.status).toBe(200);
      expect(sectionCount).toBe(1);
      expect(lessonCount).toBe(1);
    } else {
      // Deletion won: the course and all of its content are gone.
      expect(deleted.status).toBe(200);
      expect([404, 409]).toContain(submitted.status);
      expect(sectionCount).toBe(0);
      expect(lessonCount).toBe(0);
    }
  });

  it('does not delete while a content edit is in progress', async () => {
    const teacher = await registerApprovedTeacher('delete-locked@test.com');
    const course = await createCourse(teacher);
    const repo = new CourseRepository();

    const locked = await repo.acquireEditLock(
      course.id,
      COURSE_EDITABLE_STATUSES,
    );

    const blocked = await request(app)
      .delete(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe(
      COURSE_ERRORS.COURSE_EDIT_IN_PROGRESS,
    );
    expect(await CourseModel.findById(course.id).exec()).not.toBeNull();

    await repo.releaseEditLock(course.id, locked!.editLockToken!);

    const allowed = await request(app)
      .delete(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);
    expect(allowed.status).toBe(200);
    expect(await CourseModel.findById(course.id).exec()).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 5. Review metadata exposure and mutation authorization
  // ---------------------------------------------------------------------------
  it('ignores client-supplied review metadata on rejection', async () => {
    const teacher = await registerApprovedTeacher('reject-fields@test.com');
    const admin = await createAdmin('reject-fields-admin@test.com');
    const course = await createPendingCourse(teacher);

    const res = await reject(admin, course.id, {
      reason: '  Add a thumbnail before resubmitting.  ',
      status: 'approved',
      reviewedBy: teacher.userId,
      reviewedAt: new Date(0).toISOString(),
      submittedAt: new Date(0).toISOString(),
      rejectionReason: 'forged',
    });

    expect(res.status).toBe(200);
    const rejected = res.body.data.course as CourseDto;
    expect(rejected.status).toBe('rejected');
    expect(rejected.reviewedBy).toBe(admin.userId);
    expect(rejected.reviewedAt).not.toBe(new Date(0).toISOString());
    expect(rejected.submittedAt).toBe(course.submittedAt);
    expect(rejected.rejectionReason).toBe(
      'Add a thumbnail before resubmitting.',
    );

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('rejected');
    expect(stored?.reviewedBy?.toString()).toBe(admin.userId);
    expect(stored?.rejectionReason).toBe(
      'Add a thumbnail before resubmitting.',
    );
    expect(stored?.submittedAt?.toISOString()).toBe(course.submittedAt);
  });

  it('keeps review metadata out of the audience-neutral mapper', async () => {
    const teacher = await registerApprovedTeacher('mapper@test.com');
    const admin = await createAdmin('mapper-admin@test.com');
    const course = await createPendingCourse(teacher);
    expect(
      (await reject(admin, course.id, { reason: 'Fix it' })).status,
    ).toBe(200);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored).not.toBeNull();

    const publicDto = toPublicCourse(stored!);
    for (const key of [
      'submittedAt',
      'reviewedAt',
      'reviewedBy',
      'rejectionReason',
      'editLocked',
      'editLockedAt',
      'editLockToken',
    ]) {
      expect(publicDto).not.toHaveProperty(key);
    }

    const managedDto = toManagedCourse(stored!);
    expect(managedDto.submittedAt).toBeDefined();
    expect(managedDto.reviewedAt).toBeDefined();
    expect(managedDto.reviewedBy).toBe(admin.userId);
    expect(managedDto.rejectionReason).toBe('Fix it');
    expect(managedDto).not.toHaveProperty('editLocked');
    expect(managedDto).not.toHaveProperty('editLockedAt');
    expect(managedDto).not.toHaveProperty('editLockToken');
  });

  it('forbids another teacher from mutating course metadata or deleting it', async () => {
    const owner = await registerApprovedTeacher('mutate-owner@test.com');
    const intruder = await registerApprovedTeacher('mutate-intruder@test.com');
    const course = await createCourse(owner, 'Owner Course');
    const withSection = await addSection(owner, course.id);
    const sectionId = withSection.sections[0].id;
    await addTextLesson(owner, course.id, sectionId);

    const patch = await request(app)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', intruder.cookies)
      .set('X-CSRF-Token', intruder.csrf)
      .send({ title: 'Hijacked' });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);

    const remove = await request(app)
      .delete(`/api/teacher/courses/${course.id}`)
      .set('Cookie', intruder.cookies)
      .set('X-CSRF-Token', intruder.csrf);
    expect(remove.status).toBe(403);
    expect(remove.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);

    const addNewSection = await request(app)
      .post(`/api/teacher/courses/${course.id}/sections`)
      .set('Cookie', intruder.cookies)
      .set('X-CSRF-Token', intruder.csrf)
      .send({ title: 'Hijacked section' });
    expect(addNewSection.status).toBe(403);
    expect(addNewSection.body.error.code).toBe(
      COURSE_ERRORS.COURSE_FORBIDDEN,
    );

    const addNewLesson = await request(app)
      .post(`/api/teacher/courses/${course.id}/sections/${sectionId}/lessons`)
      .set('Cookie', intruder.cookies)
      .set('X-CSRF-Token', intruder.csrf)
      .send({ type: 'text', title: 'Hijacked lesson', content: 'x' });
    expect(addNewLesson.status).toBe(403);
    expect(addNewLesson.body.error.code).toBe(
      COURSE_ERRORS.COURSE_FORBIDDEN,
    );

    expect((await CourseModel.findById(course.id).exec())?.title).toBe(
      'Owner Course',
    );
    expect(await SectionModel.countDocuments({ courseId: course.id })).toBe(1);
    expect(await LessonModel.countDocuments({ courseId: course.id })).toBe(1);
  });

  it('rejects students and pending teachers from workflow mutations', async () => {
    const pendingTeacher = await registerUser({
      email: 'pending-mutations@test.com',
      role: 'teacher',
    });
    const student = await registerUser({
      email: 'student-mutations@test.com',
      role: 'student',
    });
    const courseId = new mongoose.Types.ObjectId().toString();

    for (const session of [pendingTeacher, student]) {
      const patch = await request(app)
        .patch(`/api/teacher/courses/${courseId}`)
        .set('Cookie', session.cookies)
        .set('X-CSRF-Token', session.csrf)
        .send({ title: 'Not allowed' });
      expect(patch.status).toBe(403);
      expect(patch.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

      const addSectionRes = await request(app)
        .post(`/api/teacher/courses/${courseId}/sections`)
        .set('Cookie', session.cookies)
        .set('X-CSRF-Token', session.csrf)
        .send({ title: 'Not allowed' });
      expect(addSectionRes.status).toBe(403);
      expect(addSectionRes.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

      const submitRes = await submit(session, courseId);
      expect(submitRes.status).toBe(403);
      expect(submitRes.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);
    }
  });
});
