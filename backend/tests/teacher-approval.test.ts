import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { CourseModel } from '../src/modules/courses/course.model.js';
import { CategoryModel } from '../src/modules/categories/category.model.js';
import { SectionModel } from '../src/modules/courses/section.model.js';
import { LessonModel } from '../src/modules/courses/lesson.model.js';
import { AUTH_ERRORS } from '../src/modules/auth/auth.constants.js';
import { TEACHER_APPROVAL_ERRORS } from '../src/modules/teacher-approvals/teacher-approval.constants.js';
import { userRepository } from '../src/modules/users/user.repository.js';
import { CSRF_COOKIE_NAME } from '../src/middleware/csrf.js';

const EXPECTED_TEST_DB_NAME = 'education-platform-test';
const ALLOWED_TEST_HOSTS = new Set(['127.0.0.1', 'localhost']);
const TEST_DB_URI = 'mongodb://127.0.0.1:27017/education-platform-test';

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL DATABASE SAFETY VIOLATION: Tests must never execute when NODE_ENV is "production".',
    );
  }

  const parsedUri = new URL(TEST_DB_URI);
  const dbName = parsedUri.pathname.replace(/^\//, '');

  if (
    parsedUri.protocol !== 'mongodb:' ||
    !ALLOWED_TEST_HOSTS.has(parsedUri.hostname) ||
    dbName !== EXPECTED_TEST_DB_NAME
  ) {
    throw new Error(
      'FATAL DATABASE SAFETY VIOLATION: Teacher approval tests must use the local test database only.',
    );
  }

  if (
    mongoose.connection.readyState === 1 &&
    (mongoose.connection.name !== EXPECTED_TEST_DB_NAME ||
      (mongoose.connection.host &&
        !ALLOWED_TEST_HOSTS.has(mongoose.connection.host)))
  ) {
    throw new Error(
      'FATAL DATABASE SAFETY VIOLATION: Live Mongoose connection is not the local test database.',
    );
  }
}

function getCookieValue(cookies: string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const [pair] = cookie.split(';');
    const [cookieName, ...cookieValue] = pair.split('=');
    if (cookieName.trim() === name) {
      return cookieValue.join('=');
    }
  }
  return undefined;
}

interface TestSession {
  cookies: string[];
  csrf: string;
  userId: string;
}

describe('Teacher approval and admin moderation', () => {
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
    await CourseModel.deleteMany({});
    await CategoryModel.deleteMany({});
    await SectionModel.deleteMany({});
    await LessonModel.deleteMany({});
  });

  async function registerUser(input: {
    name: string;
    email: string;
    role?: 'student' | 'teacher';
  }): Promise<TestSession> {
    const response = await request(app).post('/api/auth/register').send({
      name: input.name,
      email: input.email,
      password: 'Password123!',
      role: input.role,
    });

    expect(response.status).toBe(201);

    const cookies = response.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME);
    expect(csrf).toBeDefined();

    return {
      cookies,
      csrf: csrf!,
      userId: response.body.data.user.id as string,
    };
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

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'Password123!' });

    expect(response.status).toBe(200);

    const cookies = response.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME);
    expect(csrf).toBeDefined();

    return {
      cookies,
      csrf: csrf!,
      userId: response.body.data.user.id as string,
    };
  }

  function listTeachers(session: TestSession, query = '?status=pending') {
    return request(app)
      .get(`/api/admin/teachers${query}`)
      .set('Cookie', session.cookies);
  }

  function approveTeacher(
    session: TestSession,
    teacherId: string,
    csrf = true,
  ) {
    const req = request(app)
      .post(`/api/admin/teachers/${teacherId}/approve`)
      .set('Cookie', session.cookies);
    return csrf ? req.set('X-CSRF-Token', session.csrf) : req;
  }

  function rejectTeacher(
    session: TestSession,
    teacherId: string,
    body: unknown,
  ) {
    return request(app)
      .post(`/api/admin/teachers/${teacherId}/reject`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send(body);
  }

  function reapply(session: TestSession, csrf = true) {
    const req = request(app)
      .post('/api/teacher/reapply')
      .set('Cookie', session.cookies);
    return csrf ? req.set('X-CSRF-Token', session.csrf) : req;
  }

  function createCourse(session: TestSession, categoryId: string) {
    return request(app)
      .post('/api/teacher/courses')
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send({
        title: 'Moderation Course',
        description: 'A course submitted for moderation.',
        categoryId,
      });
  }

  it('lists pending teacher applications for an admin with safe profile fields', async () => {
    const pendingA = await registerUser({
      name: 'Pending Teacher A',
      email: 'pending-a@test.com',
      role: 'teacher',
    });
    await registerUser({
      name: 'Pending Teacher B',
      email: 'pending-b@test.com',
      role: 'teacher',
    });
    const approved = await registerUser({
      name: 'Approved Teacher',
      email: 'already-approved@test.com',
      role: 'teacher',
    });
    await UserModel.updateOne(
      { _id: approved.userId },
      { teacherStatus: 'approved' },
    ).exec();
    await registerUser({
      name: 'Student Account',
      email: 'student-approval@test.com',
      role: 'student',
    });

    const admin = await createAdmin('teachers-list-admin@test.com');
    const response = await listTeachers(admin);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.meta).toMatchObject({ page: 1, total: 2, totalPages: 1 });
    expect(
      response.body.data
        .map((teacher: { name: string }) => teacher.name)
        .sort(),
    ).toEqual(['Pending Teacher A', 'Pending Teacher B']);
    expect(response.body.data[0].passwordHash).toBeUndefined();
    expect(response.body.data[0].teacherReviewedBy).toBeUndefined();

    const detail = await request(app)
      .get(`/api/admin/teachers/${pendingA.userId}`)
      .set('Cookie', admin.cookies);

    expect(detail.status).toBe(200);
    expect(detail.body.data.teacher).toMatchObject({
      id: pendingA.userId,
      email: 'pending-a@test.com',
      role: 'teacher',
      teacherStatus: 'pending',
    });
  });

  it('approves a pending teacher and unlocks teacher operations without re-registration', async () => {
    const teacher = await registerUser({
      name: 'Pending Teacher',
      email: 'approve-teacher@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('approve-teacher-admin@test.com');

    const blockedBefore = await request(app)
      .get('/api/teacher/courses')
      .set('Cookie', teacher.cookies);
    expect(blockedBefore.status).toBe(403);
    expect(blockedBefore.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const approved = await approveTeacher(admin, teacher.userId);
    expect(approved.status).toBe(200);
    expect(approved.body.data.teacher).toMatchObject({
      id: teacher.userId,
      teacherStatus: 'approved',
    });
    expect(approved.body.data.teacher.teacherReviewedAt).toBeDefined();
    expect(approved.body.data.teacher.teacherRejectionReason).toBeUndefined();

    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', teacher.cookies);
    expect(me.status).toBe(200);
    expect(me.body.data.user.teacherStatus).toBe('approved');

    const course = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Course after approval' });
    expect(course.status).toBe(201);

    const stored = await UserModel.findById(teacher.userId).exec();
    expect(stored?.teacherStatus).toBe('approved');
    expect(stored?.teacherReviewedAt).toBeInstanceOf(Date);
    expect(stored?.teacherReviewedBy?.toString()).toBe(admin.userId);
  });

  it('rejects an application with feedback the teacher can read and keeps tools locked', async () => {
    const teacher = await registerUser({
      name: 'Rejected Teacher',
      email: 'reject-teacher@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('reject-teacher-admin@test.com');

    const rejected = await rejectTeacher(admin, teacher.userId, {
      reason: '  Add a teaching profile before applying again.  ',
    });

    expect(rejected.status).toBe(200);
    expect(rejected.body.data.teacher).toMatchObject({
      id: teacher.userId,
      teacherStatus: 'rejected',
      teacherRejectionReason: 'Add a teaching profile before applying again.',
    });
    expect(rejected.body.data.teacher.teacherReviewedAt).toBeDefined();

    const me = await request(app)
      .get('/api/auth/me')
      .set('Cookie', teacher.cookies);
    expect(me.status).toBe(200);
    expect(me.body.data.user.teacherStatus).toBe('rejected');
    expect(me.body.data.user.teacherRejectionReason).toBe(
      'Add a teaching profile before applying again.',
    );

    const blocked = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Should stay blocked' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);
  });

  it('validates decisions and only reviews pending applications once', async () => {
    const teacher = await registerUser({
      name: 'Review Once',
      email: 'review-once@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('review-once-admin@test.com');

    expect((await approveTeacher(admin, teacher.userId)).status).toBe(200);

    const secondApprove = await approveTeacher(admin, teacher.userId);
    expect(secondApprove.status).toBe(409);
    expect(secondApprove.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REVIEWABLE,
    );

    const rejectApproved = await rejectTeacher(admin, teacher.userId, {
      reason: 'Too late',
    });
    expect(rejectApproved.status).toBe(409);
    expect(rejectApproved.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REVIEWABLE,
    );

    const otherTeacher = await registerUser({
      name: 'Reason Required',
      email: 'reason-required@test.com',
      role: 'teacher',
    });
    const missingReason = await rejectTeacher(admin, otherTeacher.userId, {
      reason: '   ',
    });
    expect(missingReason.status).toBe(422);
    expect(missingReason.body.error.code).toBe('VALIDATION_ERROR');

    const missingId = '64f000000000000000000000';
    const missing = await approveTeacher(admin, missingId);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_FOUND,
    );

    const invalidId = await approveTeacher(admin, 'not-an-object-id');
    expect(invalidId.status).toBe(422);
  });

  it('restricts teacher approval endpoints to admins and requires CSRF', async () => {
    const teacher = await registerUser({
      name: 'Not Admin',
      email: 'not-admin-teacher@test.com',
      role: 'teacher',
    });
    const student = await registerUser({
      name: 'Student',
      email: 'not-admin-student@test.com',
      role: 'student',
    });
    const admin = await createAdmin('approval-security-admin@test.com');

    const asTeacher = await listTeachers(teacher);
    expect(asTeacher.status).toBe(403);
    expect(asTeacher.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const asStudent = await listTeachers(student);
    expect(asStudent.status).toBe(403);

    const teacherDecision = await approveTeacher(teacher, teacher.userId);
    expect(teacherDecision.status).toBe(403);

    const missingCsrf = await approveTeacher(admin, teacher.userId, false);
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.code).toBe(
      AUTH_ERRORS.CSRF_TOKEN_MISSING,
    );

    const unauthenticated = await request(app).get('/api/admin/teachers');
    expect(unauthenticated.status).toBe(401);
  });

  it('keeps course moderation admin-only and approval separate from publishing', async () => {
    const category = await CategoryModel.create({
      name: 'Moderation Category',
      slug: 'moderation-category',
      isActive: true,
    });

    const teacher = await registerUser({
      name: 'Course Teacher',
      email: 'course-moderation-teacher@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('course-moderation-admin@test.com');

    await UserModel.updateOne(
      { _id: teacher.userId },
      { teacherStatus: 'approved' },
    ).exec();

    const created = await createCourse(teacher, category._id.toString());
    expect(created.status).toBe(201);
    const courseId = created.body.data.course.id as string;

    const submitted = await request(app)
      .post(`/api/teacher/courses/${courseId}/submit`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({});
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.course.status).toBe('pending_review');

    const teacherQueue = await request(app)
      .get('/api/admin/courses')
      .set('Cookie', teacher.cookies);
    expect(teacherQueue.status).toBe(403);

    const queue = await request(app)
      .get('/api/admin/courses?status=pending_review')
      .set('Cookie', admin.cookies);
    expect(queue.status).toBe(200);
    expect(queue.body.data.map((course: { id: string }) => course.id)).toContain(
      courseId,
    );

    const approved = await request(app)
      .post(`/api/admin/courses/${courseId}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({});
    expect(approved.status).toBe(200);
    expect(approved.body.data.course.status).toBe('approved');
    expect(approved.body.data.course.publishedAt).toBeUndefined();
  });

  it('lets a rejected teacher resubmit for review and returns to the pending queue', async () => {
    const teacher = await registerUser({
      name: 'Reapply Teacher',
      email: 'reapply-teacher@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('reapply-admin@test.com');

    const rejected = await rejectTeacher(admin, teacher.userId, {
      reason: 'Add a teaching profile before applying again.',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.teacher.teacherStatus).toBe('rejected');

    const reapplied = await reapply(teacher);
    expect(reapplied.status).toBe(200);
    expect(reapplied.body.data.teacher).toMatchObject({
      id: teacher.userId,
      teacherStatus: 'pending',
    });
    expect(reapplied.body.data.teacher.teacherRejectionReason).toBeUndefined();
    expect(reapplied.body.data.teacher.teacherReviewedAt).toBeUndefined();

    const stored = await UserModel.findById(teacher.userId).exec();
    expect(stored?.teacherStatus).toBe('pending');
    expect(stored?.teacherRejectionReason).toBeUndefined();
    expect(stored?.teacherReviewedAt).toBeUndefined();
    expect(stored?.teacherReviewedBy).toBeUndefined();

    const queue = await listTeachers(admin);
    expect(queue.status).toBe(200);
    expect(
      queue.body.data.map((item: { id: string }) => item.id),
    ).toContain(teacher.userId);

    const approved = await approveTeacher(admin, teacher.userId);
    expect(approved.status).toBe(200);
    expect(approved.body.data.teacher.teacherStatus).toBe('approved');
  });

  it('blocks reapplication from pending, approved, student and admin accounts', async () => {
    const pendingTeacher = await registerUser({
      name: 'Pending Reapply',
      email: 'pending-reapply@test.com',
      role: 'teacher',
    });
    const approvedTeacher = await registerUser({
      name: 'Approved Reapply',
      email: 'approved-reapply@test.com',
      role: 'teacher',
    });
    await UserModel.updateOne(
      { _id: approvedTeacher.userId },
      { teacherStatus: 'approved' },
    ).exec();
    const student = await registerUser({
      name: 'Student Reapply',
      email: 'student-reapply@test.com',
      role: 'student',
    });
    const admin = await createAdmin('reapply-security-admin@test.com');

    const pendingResponse = await reapply(pendingTeacher);
    expect(pendingResponse.status).toBe(409);
    expect(pendingResponse.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REAPPLICABLE,
    );
    expect(pendingResponse.body.error.details).toEqual({
      currentStatus: 'pending',
    });

    const approvedResponse = await reapply(approvedTeacher);
    expect(approvedResponse.status).toBe(409);
    expect(approvedResponse.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REAPPLICABLE,
    );
    expect(approvedResponse.body.error.details).toEqual({
      currentStatus: 'approved',
    });

    const studentResponse = await reapply(student);
    expect(studentResponse.status).toBe(403);
    expect(studentResponse.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const adminResponse = await reapply(admin);
    expect(adminResponse.status).toBe(403);
    expect(adminResponse.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const missingCsrf = await reapply(pendingTeacher, false);
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.code).toBe(
      AUTH_ERRORS.CSRF_TOKEN_MISSING,
    );

    const unauthenticated = await request(app).post('/api/teacher/reapply');
    expect(unauthenticated.status).toBe(401);

    const unchanged = await UserModel.findById(approvedTeacher.userId).exec();
    expect(unchanged?.teacherStatus).toBe('approved');
  });

  it('returns 404 for non-teacher ids and protects the detail endpoint', async () => {
    const student = await registerUser({
      name: 'Detail Student',
      email: 'detail-student@test.com',
      role: 'student',
    });
    const teacher = await registerUser({
      name: 'Detail Teacher',
      email: 'detail-teacher@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('detail-admin@test.com');

    const asAdmin = await request(app)
      .get(`/api/admin/teachers/${student.userId}`)
      .set('Cookie', admin.cookies);
    expect(asAdmin.status).toBe(404);
    expect(asAdmin.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_FOUND,
    );

    const unauthenticated = await request(app).get(
      `/api/admin/teachers/${teacher.userId}`,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);

    const asStudent = await request(app)
      .get(`/api/admin/teachers/${teacher.userId}`)
      .set('Cookie', student.cookies);
    expect(asStudent.status).toBe(403);
    expect(asStudent.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const asTeacher = await request(app)
      .get(`/api/admin/teachers/${teacher.userId}`)
      .set('Cookie', teacher.cookies);
    expect(asTeacher.status).toBe(403);
    expect(asTeacher.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const invalidId = await request(app)
      .get('/api/admin/teachers/not-an-object-id')
      .set('Cookie', admin.cookies);
    expect(invalidId.status).toBe(422);
    expect(invalidId.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('defaults the queue to pending, filters by status and rejects invalid pagination', async () => {
    const pending = await registerUser({
      name: 'Default Pending',
      email: 'default-pending@test.com',
      role: 'teacher',
    });
    const approved = await registerUser({
      name: 'Default Approved',
      email: 'default-approved@test.com',
      role: 'teacher',
    });
    await UserModel.updateOne(
      { _id: approved.userId },
      { teacherStatus: 'approved' },
    ).exec();
    const admin = await createAdmin('default-queue-admin@test.com');

    const defaulted = await request(app)
      .get('/api/admin/teachers')
      .set('Cookie', admin.cookies);
    expect(defaulted.status).toBe(200);
    expect(
      defaulted.body.data.map((item: { id: string }) => item.id),
    ).toEqual([pending.userId]);
    expect(defaulted.body.meta).toMatchObject({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });

    const approvedOnly = await request(app)
      .get('/api/admin/teachers?status=approved')
      .set('Cookie', admin.cookies);
    expect(approvedOnly.status).toBe(200);
    expect(
      approvedOnly.body.data.map((item: { id: string }) => item.id),
    ).toEqual([approved.userId]);

    for (const query of [
      '?page=0',
      '?page=abc',
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?status=not-a-status',
    ]) {
      const invalid = await request(app)
        .get(`/api/admin/teachers${query}`)
        .set('Cookie', admin.cookies);
      expect(invalid.status).toBe(422);
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('accepts a 1000-character rejection reason and rejects 1001 characters', async () => {
    const teacherAtLimit = await registerUser({
      name: 'Reason Limit',
      email: 'reason-limit@test.com',
      role: 'teacher',
    });
    const teacherOverLimit = await registerUser({
      name: 'Reason Too Long',
      email: 'reason-too-long@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('reason-limit-admin@test.com');

    const atLimit = 'a'.repeat(1000);
    const accepted = await rejectTeacher(admin, teacherAtLimit.userId, {
      reason: atLimit,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.teacher.teacherRejectionReason).toHaveLength(1000);

    const tooLong = await rejectTeacher(admin, teacherOverLimit.userId, {
      reason: 'b'.repeat(1001),
    });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.code).toBe('VALIDATION_ERROR');
    expect(tooLong.body.error.details.body.reason).toBeDefined();

    const stored = await UserModel.findById(teacherOverLimit.userId).exec();
    expect(stored?.teacherStatus).toBe('pending');
    expect(stored?.teacherRejectionReason).toBeUndefined();
  });

  it('rejects a present but invalid CSRF token', async () => {
    const teacher = await registerUser({
      name: 'Invalid CSRF',
      email: 'invalid-csrf@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('invalid-csrf-admin@test.com');

    const invalid = await request(app)
      .post(`/api/admin/teachers/${teacher.userId}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', 'not-the-cookie-token');
    expect(invalid.status).toBe(403);
    expect(invalid.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_INVALID);

    const stored = await UserModel.findById(teacher.userId).exec();
    expect(stored?.teacherStatus).toBe('pending');
  });

  it('clears stale rejection metadata when a pending application is approved', async () => {
    const teacher = await registerUser({
      name: 'Stale Metadata',
      email: 'stale-metadata@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('stale-metadata-admin@test.com');

    // The reapply endpoint clears this metadata, but a repair or migration could
    // leave a pending application carrying an older decision. Approval must not
    // preserve stale feedback.
    await UserModel.updateOne(
      { _id: teacher.userId },
      {
        teacherStatus: 'pending',
        teacherRejectionReason: 'Stale rejection reason',
        teacherReviewedAt: new Date('2025-01-01T00:00:00.000Z'),
        teacherReviewedBy: new mongoose.Types.ObjectId(admin.userId),
      },
    ).exec();

    const approved = await approveTeacher(admin, teacher.userId);
    expect(approved.status).toBe(200);
    expect(approved.body.data.teacher.teacherStatus).toBe('approved');
    expect(
      approved.body.data.teacher.teacherRejectionReason,
    ).toBeUndefined();

    const stored = await UserModel.findById(teacher.userId).exec();
    expect(stored?.teacherStatus).toBe('approved');
    expect(stored?.teacherRejectionReason).toBeUndefined();
    expect(stored?.teacherReviewedBy?.toString()).toBe(admin.userId);
  });

  it('enforces the rejection reason limit at the repository boundary', async () => {
    const teacher = await registerUser({
      name: 'Repository Limit',
      email: 'repository-limit@test.com',
      role: 'teacher',
    });

    await expect(
      userRepository.reviewTeacher({
        teacherId: teacher.userId,
        status: 'rejected',
        reviewedBy: '64f000000000000000000000',
        rejectionReason: 'c'.repeat(1001),
      }),
    ).rejects.toThrow(/cannot exceed 1000 characters/);

    const stored = await UserModel.findById(teacher.userId).exec();
    expect(stored?.teacherStatus).toBe('pending');
    expect(stored?.teacherRejectionReason).toBeUndefined();
  });

  it('excludes disabled teacher accounts from the review queue', async () => {
    const active = await registerUser({
      name: 'Active Applicant',
      email: 'active-applicant@test.com',
      role: 'teacher',
    });
    const disabled = await registerUser({
      name: 'Disabled Applicant',
      email: 'disabled-applicant@test.com',
      role: 'teacher',
    });
    await UserModel.updateOne(
      { _id: disabled.userId },
      { isActive: false },
    ).exec();
    const admin = await createAdmin('disabled-queue-admin@test.com');

    const queue = await listTeachers(admin);
    expect(queue.status).toBe(200);
    const ids = queue.body.data.map((item: { id: string }) => item.id);
    expect(ids).toContain(active.userId);
    expect(ids).not.toContain(disabled.userId);
    expect(queue.body.meta.total).toBe(1);

    const detail = await request(app)
      .get(`/api/admin/teachers/${disabled.userId}`)
      .set('Cookie', admin.cookies);
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_FOUND,
    );
  });

  it('resolves concurrent admin decisions so only one review is applied', async () => {
    const teacher = await registerUser({
      name: 'Concurrent Review',
      email: 'concurrent-review@test.com',
      role: 'teacher',
    });
    const approvingAdmin = await createAdmin(
      'concurrent-approve-admin@test.com',
    );
    const rejectingAdmin = await createAdmin(
      'concurrent-reject-admin@test.com',
    );

    const [approval, rejection] = await Promise.all([
      approveTeacher(approvingAdmin, teacher.userId),
      rejectTeacher(rejectingAdmin, teacher.userId, {
        reason: 'Rejected while approving',
      }),
    ]);

    const statuses = [approval.status, rejection.status].sort(
      (a, b) => a - b,
    );
    expect(statuses).toEqual([200, 409]);

    const conflict = approval.status === 409 ? approval : rejection;
    expect(conflict.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REVIEWABLE,
    );
    expect(conflict.body.error.details.currentStatus).not.toBe('pending');

    const stored = await UserModel.findById(teacher.userId).exec();
    if (approval.status === 200) {
      expect(stored?.teacherStatus).toBe('approved');
      expect(stored?.teacherRejectionReason).toBeUndefined();
    } else {
      expect(stored?.teacherStatus).toBe('rejected');
      expect(stored?.teacherRejectionReason).toBe(
        'Rejected while approving',
      );
    }
  });

  it('allows only one of two concurrent resubmissions', async () => {
    const teacher = await registerUser({
      name: 'Concurrent Reapply',
      email: 'concurrent-reapply@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('concurrent-reapply-admin@test.com');

    await rejectTeacher(admin, teacher.userId, {
      reason: 'Needs a teaching profile',
    });

    const [first, second] = await Promise.all([
      reapply(teacher),
      reapply(teacher),
    ]);

    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const conflict = first.status === 409 ? first : second;
    expect(conflict.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REAPPLICABLE,
    );
    expect(conflict.body.error.details).toEqual({ currentStatus: 'pending' });

    const stored = await UserModel.findById(teacher.userId).exec();
    expect(stored?.teacherStatus).toBe('pending');
    expect(stored?.teacherRejectionReason).toBeUndefined();
  });

  it('resubmits only the caller account and leaves other rejected teachers untouched', async () => {
    const teacherA = await registerUser({
      name: 'Reapply Self',
      email: 'reapply-self@test.com',
      role: 'teacher',
    });
    const teacherB = await registerUser({
      name: 'Reapply Other',
      email: 'reapply-other@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('reapply-self-admin@test.com');

    await rejectTeacher(admin, teacherA.userId, { reason: 'Reason for A' });
    await rejectTeacher(admin, teacherB.userId, { reason: 'Reason for B' });

    const reapplied = await reapply(teacherA);
    expect(reapplied.status).toBe(200);
    expect(reapplied.body.data.teacher).toMatchObject({
      id: teacherA.userId,
      teacherStatus: 'pending',
    });

    const storedA = await UserModel.findById(teacherA.userId).exec();
    expect(storedA?.teacherStatus).toBe('pending');
    expect(storedA?.teacherRejectionReason).toBeUndefined();
    expect(storedA?.teacherReviewedAt).toBeUndefined();
    expect(storedA?.teacherReviewedBy).toBeUndefined();

    const storedB = await UserModel.findById(teacherB.userId).exec();
    expect(storedB?.teacherStatus).toBe('rejected');
    expect(storedB?.teacherRejectionReason).toBe('Reason for B');
    expect(storedB?.teacherReviewedBy?.toString()).toBe(admin.userId);

    const repeated = await reapply(teacherA);
    expect(repeated.status).toBe(409);
    expect(repeated.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_REAPPLICABLE,
    );
    expect(repeated.body.error.details).toEqual({ currentStatus: 'pending' });

    const storedBAfter = await UserModel.findById(teacherB.userId).exec();
    expect(storedBAfter?.teacherStatus).toBe('rejected');
    expect(storedBAfter?.teacherRejectionReason).toBe('Reason for B');
  });

  it('blocks disabled teachers from resubmitting or being reviewed', async () => {
    const teacher = await registerUser({
      name: 'Disabled Reapply',
      email: 'disabled-reapply@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('disabled-reapply-admin@test.com');

    await rejectTeacher(admin, teacher.userId, {
      reason: 'Before the account was disabled',
    });
    await UserModel.updateOne(
      { _id: teacher.userId },
      { isActive: false },
    ).exec();

    const resubmit = await reapply(teacher);
    expect(resubmit.status).toBe(403);
    expect(resubmit.body.error.code).toBe(AUTH_ERRORS.ACCOUNT_DISABLED);

    const approval = await approveTeacher(admin, teacher.userId);
    expect(approval.status).toBe(404);
    expect(approval.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_FOUND,
    );

    const rejection = await rejectTeacher(admin, teacher.userId, {
      reason: 'Disabled account decision',
    });
    expect(rejection.status).toBe(404);
    expect(rejection.body.error.code).toBe(
      TEACHER_APPROVAL_ERRORS.TEACHER_NOT_FOUND,
    );

    const stored = await UserModel.findById(teacher.userId).exec();
    expect(stored?.teacherStatus).toBe('rejected');
    expect(stored?.teacherRejectionReason).toBe(
      'Before the account was disabled',
    );
  });

  it('never exposes password hashes or reviewer identity in approval responses', async () => {
    const teacher = await registerUser({
      name: 'Safe Response',
      email: 'safe-response@test.com',
      role: 'teacher',
    });
    const otherTeacher = await registerUser({
      name: 'Safe Response Other',
      email: 'safe-response-other@test.com',
      role: 'teacher',
    });
    const admin = await createAdmin('safe-response-admin@test.com');

    const detail = await request(app)
      .get(`/api/admin/teachers/${teacher.userId}`)
      .set('Cookie', admin.cookies);
    expect(detail.status).toBe(200);
    expect(detail.body.data.teacher.passwordHash).toBeUndefined();
    expect(detail.body.data.teacher.teacherReviewedBy).toBeUndefined();

    const approved = await approveTeacher(admin, teacher.userId);
    expect(approved.status).toBe(200);
    expect(approved.body.data.teacher.passwordHash).toBeUndefined();
    expect(approved.body.data.teacher.teacherReviewedBy).toBeUndefined();

    const rejected = await rejectTeacher(admin, otherTeacher.userId, {
      reason: 'Safe response rejection',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.teacher.passwordHash).toBeUndefined();
    expect(rejected.body.data.teacher.teacherReviewedBy).toBeUndefined();

    const reapplied = await reapply(otherTeacher);
    expect(reapplied.status).toBe(200);
    expect(reapplied.body.data.teacher.passwordHash).toBeUndefined();
    expect(reapplied.body.data.teacher.teacherReviewedBy).toBeUndefined();
  });
});
