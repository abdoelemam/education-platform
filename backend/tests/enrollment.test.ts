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
import { enrollmentRepository } from '../src/modules/enrollments/enrollment.repository.js';
import type { CourseDocument } from '../src/modules/courses/course.types.js';
import { COURSE_ERRORS } from '../src/modules/courses/course.constants.js';
import { ENROLLMENT_ERRORS } from '../src/modules/enrollments/enrollment.constants.js';
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

interface EnrollDto {
  id: string;
  studentId: string;
  courseId: string;
  status: string;
  enrolledAt: string | null;
  completedAt?: string;
  source: string;
}

describe('Enrollment Integration Tests', () => {
  const app = createApp();
  let courseSequence = 0;

  beforeAll(async () => {
    assertSafeTestDatabase();

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }

    assertSafeTestDatabase();

    // Build the unique index before the concurrency tests run.
    await EnrollmentModel.init();
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
      name: input.name ?? 'Enrollment Test User',
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
    name = 'Enrollment Student',
  ): Promise<TestSession> {
    return registerUser({ name, email });
  }

  async function registerApprovedTeacher(
    email: string,
    name = 'Enrollment Teacher',
  ): Promise<TestSession> {
    const session = await registerUser({ name, email, role: 'teacher' });

    await UserModel.updateOne(
      { _id: session.userId },
      { teacherStatus: 'approved' },
    ).exec();

    return session;
  }

  async function registerPendingTeacher(
    email: string,
    name = 'Pending Teacher',
  ): Promise<TestSession> {
    return registerUser({ name, email, role: 'teacher' });
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

  /**
   * Seed a course directly in the desired lifecycle state.
   *
   * `includePrice: false` simulates a legacy published course created before the
   * publishing phase introduced price/currency requirements.
   */
  async function seedCourse(input: {
    ownerId: string;
    title?: string;
    status?: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'published' | 'archived';
    priceMinor?: number;
    currency?: string;
    includePrice?: boolean;
  }): Promise<CourseDocument> {
    courseSequence += 1;

    const status = input.status ?? 'published';
    const data: Record<string, unknown> = {
      ownerId: new Types.ObjectId(input.ownerId),
      title: input.title ?? `Enrollment Course ${courseSequence}`,
      slug: `enrollment-course-${courseSequence}-${new Types.ObjectId().toString()}`,
      description: 'An enrollment test course.',
      status,
    };

    if (status === 'published') {
      data.publishedAt = new Date();
    }

    if (input.includePrice !== false) {
      data.priceMinor = input.priceMinor ?? 0;
      data.currency = input.currency ?? 'USD';
    }

    return CourseModel.create(data);
  }

  async function seedCurriculum(courseId: string): Promise<void> {
    const sectionOne = await SectionModel.create({
      courseId: new Types.ObjectId(courseId),
      title: 'Section One',
      order: 1,
      committed: true,
    });
    const sectionTwo = await SectionModel.create({
      courseId: new Types.ObjectId(courseId),
      title: 'Section Two',
      order: 2,
      committed: true,
    });

    await LessonModel.create([
      {
        courseId: new Types.ObjectId(courseId),
        sectionId: sectionOne._id,
        title: 'Lesson One',
        type: 'text',
        content: 'First lesson',
        order: 1,
        committed: true,
      },
      {
        courseId: new Types.ObjectId(courseId),
        sectionId: sectionOne._id,
        title: 'Lesson Two',
        type: 'text',
        content: 'Second lesson',
        order: 2,
        committed: true,
      },
      {
        courseId: new Types.ObjectId(courseId),
        sectionId: sectionTwo._id,
        title: 'Lesson Three',
        type: 'text',
        content: 'Third lesson',
        order: 1,
        committed: true,
      },
      {
        // Staged content must never be counted in the curriculum summary.
        courseId: new Types.ObjectId(courseId),
        sectionId: sectionTwo._id,
        title: 'Staged Lesson',
        type: 'text',
        content: 'Not committed yet',
        order: 2,
        committed: false,
      },
    ]);
  }

  function enroll(
    session: TestSession,
    courseId: string,
    body?: Record<string, unknown>,
  ) {
    let req = request(app)
      .post(`/api/courses/${courseId}/enroll`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf);

    if (body !== undefined) {
      req = req.send(body);
    }

    return req;
  }

  function enrollmentStatus(session: TestSession, courseId: string) {
    return request(app)
      .get(`/api/courses/${courseId}/enrollment`)
      .set('Cookie', session.cookies);
  }

  function myCourses(session: TestSession, query = '') {
    return request(app)
      .get(`/api/my-courses${query}`)
      .set('Cookie', session.cookies);
  }

  function roster(session: TestSession, courseId: string, query = '') {
    return request(app)
      .get(`/api/teacher/courses/${courseId}/enrollments${query}`)
      .set('Cookie', session.cookies);
  }

  // ---------------------------------------------------------------------------
  // Free enrollment
  // ---------------------------------------------------------------------------
  describe('free enrollment', () => {
    it('enrolls a student in a published free course', async () => {
      const teacher = await registerApprovedTeacher('free-teacher@example.com');
      const student = await registerStudent('free-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId, priceMinor: 0 });

      const res = await enroll(student, course._id.toString());

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.created).toBe(true);

      const enrollment = res.body.data.enrollment as EnrollDto;
      expect(enrollment.courseId).toBe(course._id.toString());
      expect(enrollment.studentId).toBe(student.userId);
      expect(enrollment.status).toBe('active');
      expect(enrollment.source).toBe('free');
      expect(typeof enrollment.enrolledAt).toBe('string');

      const stored = await EnrollmentModel.findOne({
        studentId: student.userId,
        courseId: course._id.toString(),
      }).exec();
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('active');
      expect(stored!.orderId).toBeUndefined();
      expect(await EnrollmentModel.countDocuments({})).toBe(1);
    });

    it('treats a published course with priceMinor 0 and a currency as free', async () => {
      const teacher = await registerApprovedTeacher('zero-teacher@example.com');
      const student = await registerStudent('zero-student@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        priceMinor: 0,
        currency: 'EGP',
      });

      const res = await enroll(student, course._id.toString());
      expect(res.status).toBe(201);
    });

    it('rejects a client body that tries to set price, status, or order fields', async () => {
      const teacher = await registerApprovedTeacher('tamper-teacher@example.com');
      const student = await registerStudent('tamper-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId, priceMinor: 0 });

      const res = await enroll(student, course._id.toString(), {
        priceMinor: 0,
        status: 'completed',
        source: 'free',
        orderId: new Types.ObjectId().toString(),
      });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(await EnrollmentModel.countDocuments({})).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Duplicates and concurrency
  // ---------------------------------------------------------------------------
  describe('duplicate and concurrent enrollment', () => {
    it('returns the existing enrollment on a repeated request without resetting it', async () => {
      const teacher = await registerApprovedTeacher('dupe-teacher@example.com');
      const student = await registerStudent('dupe-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      const first = await enroll(student, courseId);
      expect(first.status).toBe(201);

      const second = await enroll(student, courseId);
      expect(second.status).toBe(200);
      expect(second.body.data.created).toBe(false);
      expect(second.body.data.enrollment.id).toBe(
        first.body.data.enrollment.id,
      );
      expect(await EnrollmentModel.countDocuments({})).toBe(1);
    });

    it('persists exactly one enrollment for concurrent requests', async () => {
      const teacher = await registerApprovedTeacher('race-teacher@example.com');
      const student = await registerStudent('race-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => enroll(student, courseId)),
      );

      for (const response of responses) {
        expect([200, 201]).toContain(response.status);
      }

      const createdResponses = responses.filter((r) => r.status === 201);
      expect(createdResponses).toHaveLength(1);

      const ids = new Set(
        responses.map((r) => r.body.data.enrollment.id as string),
      );
      expect(ids.size).toBe(1);
      expect(await EnrollmentModel.countDocuments({})).toBe(1);
      expect(
        await EnrollmentModel.countDocuments({
          studentId: student.userId,
          courseId,
        }),
      ).toBe(1);
    });

    it('enforces the unique student/course index at the database level', async () => {
      const teacher = await registerApprovedTeacher('index-teacher@example.com');
      const student = await registerStudent('index-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });

      const indexes = await EnrollmentModel.collection.indexes();
      const uniquePair = indexes.find(
        (index) =>
          index.key.studentId === 1 &&
          index.key.courseId === 1 &&
          index.unique === true,
      );
      expect(uniquePair).toBeDefined();

      await EnrollmentModel.create({
        studentId: student.userId,
        courseId: course._id,
      });

      await expect(
        EnrollmentModel.create({
          studentId: student.userId,
          courseId: course._id,
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('does not reset a completed enrollment on re-enrollment', async () => {
      const teacher = await registerApprovedTeacher('reset-teacher@example.com');
      const student = await registerStudent('reset-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      const first = await enroll(student, courseId);
      expect(first.status).toBe(201);

      const completedAt = new Date('2025-05-01T10:00:00.000Z');
      await enrollmentRepository.markCompleted({
        studentId: student.userId,
        courseId,
        completedAt,
      });

      const again = await enroll(student, courseId);
      expect(again.status).toBe(200);
      expect(again.body.data.created).toBe(false);
      expect(again.body.data.hasAccess).toBe(true);
      expect(again.body.data.enrollment.status).toBe('completed');
      expect(again.body.data.enrollment.completedAt).toBe(
        completedAt.toISOString(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Paid-course gate
  // ---------------------------------------------------------------------------
  describe('paid-course eligibility', () => {
    it('blocks enrollment in a paid course and creates nothing', async () => {
      const teacher = await registerApprovedTeacher('paid-teacher@example.com');
      const student = await registerStudent('paid-student@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        priceMinor: 4999,
        currency: 'USD',
      });

      const res = await enroll(student, course._id.toString());

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe(ENROLLMENT_ERRORS.PAYMENT_REQUIRED);
      expect(res.body.error.details).toMatchObject({
        priceMinor: 4999,
        currency: 'USD',
      });
      expect(await EnrollmentModel.countDocuments({})).toBe(0);
    });

    it('does not let a tampered body bypass the paid gate', async () => {
      const teacher = await registerApprovedTeacher('paid-tamper-teacher@example.com');
      const student = await registerStudent('paid-tamper-student@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        priceMinor: 2500,
        currency: 'USD',
      });

      const res = await enroll(student, course._id.toString(), {
        priceMinor: 0,
        status: 'active',
      });

      expect(res.status).toBe(422);
      expect(await EnrollmentModel.countDocuments({})).toBe(0);
    });

    it('keeps the paid gate after a legacy published course gains a price', async () => {
      const teacher = await registerApprovedTeacher('legacy-paid-teacher@example.com');
      const enrolledStudent = await registerStudent(
        'legacy-paid-enrolled@example.com',
      );
      const newStudent = await registerStudent('legacy-paid-new@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        includePrice: false,
      });
      const courseId = course._id.toString();

      // Legacy course starts free and one student enrolls.
      const first = await enroll(enrolledStudent, courseId);
      expect(first.status).toBe(201);

      // The course then gains a price.
      await CourseModel.updateOne(
        { _id: course._id },
        { $set: { priceMinor: 1000, currency: 'USD' } },
      ).exec();

      const blocked = await enroll(newStudent, courseId);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe(ENROLLMENT_ERRORS.PAYMENT_REQUIRED);
      expect(await EnrollmentModel.countDocuments({})).toBe(1);

      // The pre-existing enrollment remains intact and retains access.
      const status = await enrollmentStatus(enrolledStudent, courseId);
      expect(status.status).toBe(200);
      expect(status.body.data.enrolled).toBe(true);
      expect(status.body.data.hasAccess).toBe(true);
    });

    it('does not treat an invalid negative legacy price as free', async () => {
      const teacher = await registerApprovedTeacher('invalid-price-teacher@example.com');
      const student = await registerStudent('invalid-price-student@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        includePrice: false,
      });

      await CourseModel.updateOne(
        { _id: course._id },
        { $set: { priceMinor: -1 } },
      ).exec();

      const res = await enroll(student, course._id.toString());

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ENROLLMENT_ERRORS.PAYMENT_REQUIRED);
      expect(await EnrollmentModel.countDocuments({})).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Course eligibility
  // ---------------------------------------------------------------------------
  describe('course eligibility and visibility', () => {
    it.each([
      'draft',
      'pending_review',
      'approved',
      'rejected',
      'archived',
    ] as const)(
      'refuses enrollment in a %s course',
      async (status) => {
        const teacher = await registerApprovedTeacher(
          `ineligible-${status}@example.com`,
        );
        const student = await registerStudent(
          `ineligible-student-${status}@example.com`,
        );
        const course = await seedCourse({
          ownerId: teacher.userId,
          status,
          includePrice: false,
        });

        const res = await enroll(student, course._id.toString());

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);
        expect(await EnrollmentModel.countDocuments({})).toBe(0);
      },
    );

    it('returns not found for a missing course', async () => {
      const student = await registerStudent('missing-course@example.com');
      const missingCourseId = new Types.ObjectId().toString();

      const res = await enroll(student, missingCourseId);

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);
      expect(await EnrollmentModel.countDocuments({})).toBe(0);
    });

    it('keeps the public catalog available without authentication', async () => {
      const teacher = await registerApprovedTeacher('catalog-teacher@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        title: 'Public Catalog Course',
      });

      const res = await request(app).get('/api/courses');

      expect(res.status).toBe(200);
      expect(
        (res.body.data as Array<{ id: string }>).some(
          (item) => item.id === course._id.toString(),
        ),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------------
  describe('authorization and validation', () => {
    it('requires authentication to enroll', async () => {
      const teacher = await registerApprovedTeacher('auth-teacher@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });

      const res = await request(app)
        .post(`/api/courses/${course._id.toString()}/enroll`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);
      expect(await EnrollmentModel.countDocuments({})).toBe(0);
    });

    it('rejects teachers and admins as enrollees', async () => {
      const teacher = await registerApprovedTeacher('role-teacher@example.com');
      const otherTeacher = await registerApprovedTeacher('role-teacher-2@example.com');
      const admin = await createAdmin('role-admin@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });

      const teacherRes = await enroll(otherTeacher, course._id.toString());
      expect(teacherRes.status).toBe(403);
      expect(teacherRes.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

      const adminRes = await enroll(admin, course._id.toString());
      expect(adminRes.status).toBe(403);
      expect(adminRes.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

      expect(await EnrollmentModel.countDocuments({})).toBe(0);
    });

    it('requires a CSRF token for enrollment', async () => {
      const teacher = await registerApprovedTeacher('csrf-teacher@example.com');
      const student = await registerStudent('csrf-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });

      const res = await request(app)
        .post(`/api/courses/${course._id.toString()}/enroll`)
        .set('Cookie', student.cookies);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_MISSING);
      expect(await EnrollmentModel.countDocuments({})).toBe(0);
    });

    it('rejects a malformed course id with a validation error', async () => {
      const student = await registerStudent('malformed-student@example.com');

      const res = await enroll(student, 'not-an-object-id');

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // Enrollment status
  // ---------------------------------------------------------------------------
  describe('enrollment status', () => {
    it('returns the caller enrollment status and never another student record', async () => {
      const teacher = await registerApprovedTeacher('status-teacher@example.com');
      const studentA = await registerStudent('status-a@example.com', 'Student A');
      const studentB = await registerStudent('status-b@example.com', 'Student B');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      const before = await enrollmentStatus(studentA, courseId);
      expect(before.status).toBe(200);
      expect(before.body.data).toEqual({
        enrolled: false,
        hasAccess: false,
        enrollment: null,
      });

      await enroll(studentA, courseId);

      const own = await enrollmentStatus(studentA, courseId);
      expect(own.status).toBe(200);
      expect(own.body.data.enrolled).toBe(true);
      expect(own.body.data.hasAccess).toBe(true);
      expect(own.body.data.enrollment.studentId).toBe(studentA.userId);

      const other = await enrollmentStatus(studentB, courseId);
      expect(other.status).toBe(200);
      expect(other.body.data.enrolled).toBe(false);
      expect(other.body.data.hasAccess).toBe(false);
      expect(other.body.data.enrollment).toBeNull();

      expect(await EnrollmentModel.countDocuments({})).toBe(1);
    });

    it('exposes lifecycle access for all enrollment statuses', async () => {
      const teacher = await registerApprovedTeacher('status-access-teacher@example.com');
      const student = await registerStudent('status-access-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      const first = await enroll(student, courseId);
      expect(first.status).toBe(201);
      expect(first.body.data.hasAccess).toBe(true);

      const expectations = [
        { status: 'active', hasAccess: true },
        { status: 'completed', hasAccess: true },
        { status: 'cancelled', hasAccess: false },
        { status: 'expired', hasAccess: false },
      ] as const;

      for (const expectation of expectations) {
        await EnrollmentModel.updateOne(
          { studentId: student.userId, courseId },
          { $set: { status: expectation.status } },
        ).exec();

        const res = await enrollmentStatus(student, courseId);
        expect(res.status).toBe(200);
        expect(res.body.data.enrolled).toBe(true);
        expect(res.body.data.hasAccess).toBe(expectation.hasAccess);
        expect(res.body.data.enrollment.status).toBe(expectation.status);
      }

      const list = await myCourses(student);
      expect(list.status).toBe(200);
      expect(list.body.meta.total).toBe(1);
      expect(list.body.data[0].hasAccess).toBe(false); // final status: expired
    });

    it('does not reactivate cancelled or expired enrollments on repeat enrollment', async () => {
      const teacher = await registerApprovedTeacher('status-repeat-teacher@example.com');
      const student = await registerStudent('status-repeat-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      await enroll(student, courseId);

      for (const status of ['cancelled', 'expired'] as const) {
        await EnrollmentModel.updateOne(
          { studentId: student.userId, courseId },
          { $set: { status } },
        ).exec();

        const again = await enroll(student, courseId);
        expect(again.status).toBe(200);
        expect(again.body.data.created).toBe(false);
        expect(again.body.data.hasAccess).toBe(false);
        expect(again.body.data.enrollment.status).toBe(status);
        expect(await EnrollmentModel.countDocuments({})).toBe(1);
      }
    });

    it('hides unpublished courses from the status endpoint', async () => {
      const teacher = await registerApprovedTeacher('status-hidden-teacher@example.com');
      const student = await registerStudent('status-hidden-student@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        status: 'draft',
      });

      const res = await enrollmentStatus(student, course._id.toString());

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);
    });

    it('denies access for every status when the course is unpublished', async () => {
      const teacher = await registerApprovedTeacher('status-unpublished-teacher@example.com');
      const student = await registerStudent('status-unpublished-student@example.com');

      for (const status of ['active', 'completed', 'cancelled', 'expired'] as const) {
        const course = await seedCourse({
          ownerId: teacher.userId,
          status: 'draft',
        });

        await EnrollmentModel.create({
          studentId: new Types.ObjectId(student.userId),
          courseId: course._id,
          status,
        });

        const res = await enrollmentStatus(student, course._id.toString());
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_FOUND);
      }

      const list = await myCourses(student);
      expect(list.status).toBe(200);
      expect(list.body.meta.total).toBe(4);
      for (const row of list.body.data as Array<{ hasAccess: boolean }>) {
        expect(row.hasAccess).toBe(false);
      }
    });

    it('requires authentication and a student role', async () => {
      const teacher = await registerApprovedTeacher('status-role-teacher@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });

      const anonymous = await request(app).get(
        `/api/courses/${course._id.toString()}/enrollment`,
      );
      expect(anonymous.status).toBe(401);

      const asTeacher = await enrollmentStatus(teacher, course._id.toString());
      expect(asTeacher.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // My courses
  // ---------------------------------------------------------------------------
  describe('my courses', () => {
    it('lists only the caller enrollments with safe course summaries', async () => {
      const teacher = await registerApprovedTeacher(
        'my-courses-teacher@example.com',
        'Instructor Name',
      );
      const student = await registerStudent('my-courses-student@example.com');
      const otherStudent = await registerStudent('my-courses-other@example.com');

      const course = await seedCourse({
        ownerId: teacher.userId,
        title: 'My Course One',
        priceMinor: 0,
        currency: 'USD',
      });
      const otherCourse = await seedCourse({
        ownerId: teacher.userId,
        title: 'Someone Else Course',
      });
      const enrollmentCourse = await seedCourse({
        ownerId: teacher.userId,
        title: 'Unenrolled Course',
      });

      await seedCurriculum(course._id.toString());
      await enroll(student, course._id.toString());
      await enroll(otherStudent, otherCourse._id.toString());

      const res = await myCourses(student);

      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(res.body.data).toHaveLength(1);

      const item = res.body.data[0];
      expect(item.enrollment.courseId).toBe(course._id.toString());
      expect(item.course.id).toBe(course._id.toString());
      expect(item.course.title).toBe('My Course One');
      expect(item.course.instructor.name).toBe('Instructor Name');
      expect(item.course.instructor.email).toBeUndefined();
      expect(item.course.ownerId).toBeUndefined();
      expect(item.course.sections).toBeUndefined();
      expect(item.course.isFree).toBe(true);
      expect(item.course.totalSections).toBe(2);
      expect(item.course.totalLessons).toBe(3);
      expect(item.hasAccess).toBe(true);
      expect(item.progress).toEqual({
        completedLessons: 0,
        totalLessons: 3,
        percent: 0,
      });

      expect(
        (res.body.data as Array<{ course: { id: string } }>).some(
          (row) => row.course.id === enrollmentCourse._id.toString(),
        ),
      ).toBe(false);
    });

    it('paginates the student course list', async () => {
      const teacher = await registerApprovedTeacher('page-teacher@example.com');
      const student = await registerStudent('page-student@example.com');

      const courses = await Promise.all(
        [1, 2, 3].map((index) =>
          seedCourse({
            ownerId: teacher.userId,
            title: `Paged Course ${index}`,
          }),
        ),
      );

      for (const course of courses) {
        await enroll(student, course._id.toString());
      }

      const firstPage = await myCourses(student, '?page=1&limit=2');
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.meta).toMatchObject({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      expect(firstPage.body.data).toHaveLength(2);

      const secondPage = await myCourses(student, '?page=2&limit=2');
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.data).toHaveLength(1);

      const ids = [
        ...firstPage.body.data.map(
          (row: { course: { id: string } }) => row.course.id,
        ),
        ...secondPage.body.data.map(
          (row: { course: { id: string } }) => row.course.id,
        ),
      ];
      expect(new Set(ids).size).toBe(3);
    });

    it('requires authentication and a student role', async () => {
      const teacher = await registerApprovedTeacher('my-courses-role@example.com');

      const anonymous = await request(app).get('/api/my-courses');
      expect(anonymous.status).toBe(401);

      const asTeacher = await myCourses(teacher);
      expect(asTeacher.status).toBe(403);
    });

    it('excludes orphaned enrollments from data, totals and page counts', async () => {
      const teacher = await registerApprovedTeacher('orphan-teacher@example.com');
      const student = await registerStudent('orphan-student@example.com');

      const courses = await Promise.all(
        [1, 2].map((index) =>
          seedCourse({
            ownerId: teacher.userId,
            title: `Orphan Test Course ${index}`,
          }),
        ),
      );

      for (const course of courses) {
        await enroll(student, course._id.toString());
      }

      // Simulate a legacy enrollment whose course no longer exists.
      await EnrollmentModel.create({
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(),
        status: 'active',
      });

      const firstPage = await myCourses(student, '?page=1&limit=1');
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.meta).toMatchObject({
        page: 1,
        limit: 1,
        total: 2,
        totalPages: 2,
      });
      expect(firstPage.body.data).toHaveLength(1);

      const secondPage = await myCourses(student, '?page=2&limit=1');
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.meta).toMatchObject({
        page: 2,
        limit: 1,
        total: 2,
        totalPages: 2,
      });
      expect(secondPage.body.data).toHaveLength(1);

      const all = await myCourses(student, '?page=1&limit=20');
      expect(all.status).toBe(200);
      expect(all.body.meta).toMatchObject({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
      expect(all.body.data).toHaveLength(2);
    });

    it('rejects invalid and unbounded pagination', async () => {
      const student = await registerStudent('my-courses-invalid@example.com');

      for (const query of [
        '?page=0&limit=1000',
        `?page=${1_000_001}&limit=20`,
        '?page=1e300&limit=20',
      ]) {
        const res = await myCourses(student, query);
        expect(res.status).toBe(422);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Teacher roster
  // ---------------------------------------------------------------------------
  describe('teacher roster', () => {
    it('lets the owner list enrolled students without exposing email', async () => {
      const teacher = await registerApprovedTeacher('roster-owner@example.com');
      const studentA = await registerStudent('roster-a@example.com', 'Roster A');
      const studentB = await registerStudent('roster-b@example.com', 'Roster B');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      await enroll(studentA, courseId);
      await enroll(studentB, courseId);

      const res = await roster(teacher, courseId);

      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
      expect(res.body.data).toHaveLength(2);

      const names = new Set(
        (res.body.data as Array<{ student: { name: string } }>).map(
          (row) => row.student.name,
        ),
      );
      expect(names).toEqual(new Set(['Roster A', 'Roster B']));

      for (const row of res.body.data) {
        expect(row.status).toBe('active');
        expect(row.source).toBe('free');
        expect(row.student.email).toBeUndefined();
        expect(row.student.id).toBeDefined();
      }
    });

    it('scopes the roster to the requested course', async () => {
      const teacher = await registerApprovedTeacher('roster-scope@example.com');
      const studentA = await registerStudent('roster-scope-a@example.com', 'Scoped A');
      const studentB = await registerStudent('roster-scope-b@example.com', 'Scoped B');
      const courseOne = await seedCourse({ ownerId: teacher.userId });
      const courseTwo = await seedCourse({ ownerId: teacher.userId });

      await enroll(studentA, courseOne._id.toString());
      await enroll(studentB, courseTwo._id.toString());

      const res = await roster(teacher, courseOne._id.toString());
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].student.name).toBe('Scoped A');
    });

    it('paginates the roster', async () => {
      const teacher = await registerApprovedTeacher('roster-page@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      for (let index = 0; index < 3; index += 1) {
        const student = await registerStudent(
          `roster-page-${index}@example.com`,
          `Paged Student ${index}`,
        );
        await enroll(student, courseId);
      }

      const firstPage = await roster(teacher, courseId, '?page=1&limit=2');
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.meta).toMatchObject({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      expect(firstPage.body.data).toHaveLength(2);

      const secondPage = await roster(teacher, courseId, '?page=2&limit=2');
      expect(secondPage.body.data).toHaveLength(1);
    });

    it('forbids another teacher from reading the roster', async () => {
      const owner = await registerApprovedTeacher('roster-owner-2@example.com');
      const otherTeacher = await registerApprovedTeacher('roster-other@example.com');
      const course = await seedCourse({ ownerId: owner.userId });

      const res = await roster(otherTeacher, course._id.toString());

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);
    });

    it('allows an admin to read any course roster', async () => {
      const owner = await registerApprovedTeacher('roster-admin-owner@example.com');
      const student = await registerStudent('roster-admin-student@example.com');
      const admin = await createAdmin('roster-admin@example.com');
      const course = await seedCourse({ ownerId: owner.userId });
      const courseId = course._id.toString();

      await enroll(student, courseId);

      const res = await roster(admin, courseId);

      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
    });

    it('rejects pending teachers, students and anonymous callers', async () => {
      const owner = await registerApprovedTeacher('roster-owner-3@example.com');
      const pendingTeacher = await registerPendingTeacher('roster-pending@example.com');
      const student = await registerStudent('roster-student@example.com');
      const course = await seedCourse({ ownerId: owner.userId });
      const courseId = course._id.toString();

      const pendingRes = await roster(pendingTeacher, courseId);
      expect(pendingRes.status).toBe(403);
      expect(pendingRes.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

      const studentRes = await roster(student, courseId);
      expect(studentRes.status).toBe(403);

      const anonymous = await request(app).get(
        `/api/teacher/courses/${courseId}/enrollments`,
      );
      expect(anonymous.status).toBe(401);
    });

    it('validates the course id', async () => {
      const teacher = await registerApprovedTeacher('roster-invalid@example.com');

      const res = await roster(teacher, 'invalid-id');

      expect(res.status).toBe(422);
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy data
  // ---------------------------------------------------------------------------
  describe('legacy data compatibility', () => {
    it('enrolls in a legacy published course that has no price or currency', async () => {
      const teacher = await registerApprovedTeacher('legacy-teacher@example.com');
      const student = await registerStudent('legacy-student@example.com');
      const course = await seedCourse({
        ownerId: teacher.userId,
        includePrice: false,
      });

      const res = await enroll(student, course._id.toString());

      expect(res.status).toBe(201);
      expect(res.body.data.enrollment.status).toBe('active');
      expect(res.body.data.enrollment.source).toBe('free');
    });

    it('normalizes a legacy enrollment row without status, source or enrolledAt', async () => {
      const teacher = await registerApprovedTeacher('legacy-row-teacher@example.com');
      const student = await registerStudent('legacy-row-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      const createdAt = new Date('2024-01-02T03:04:05.000Z');
      await mongoose.connection.db!.collection('enrollments').insertOne({
        _id: new Types.ObjectId(),
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(courseId),
        createdAt,
      });

      const status = await enrollmentStatus(student, courseId);
      expect(status.status).toBe(200);
      expect(status.body.data.enrolled).toBe(true);
      expect(status.body.data.enrollment.status).toBe('active');
      expect(status.body.data.enrollment.source).toBe('free');
      expect(status.body.data.enrollment.enrolledAt).toBe(
        createdAt.toISOString(),
      );

      const list = await myCourses(student);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].enrollment.status).toBe('active');
      expect(list.body.data[0].enrollment.enrolledAt).toBe(
        createdAt.toISOString(),
      );
      expect(list.body.data[0].progress).toEqual({
        completedLessons: 0,
        totalLessons: 0,
        percent: 0,
      });
    });

    it('normalizes a legacy completed purchase row', async () => {
      const teacher = await registerApprovedTeacher('legacy-done-teacher@example.com');
      const student = await registerStudent('legacy-done-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      const completedAt = new Date('2024-06-01T00:00:00.000Z');
      await mongoose.connection.db!.collection('enrollments').insertOne({
        _id: new Types.ObjectId(),
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(courseId),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        completedAt,
        orderId: new Types.ObjectId(),
      });

      const status = await enrollmentStatus(student, courseId);
      expect(status.body.data.enrollment.status).toBe('completed');
      expect(status.body.data.enrollment.source).toBe('purchase');
      expect(status.body.data.enrollment.completedAt).toBe(
        completedAt.toISOString(),
      );
    });

    it('returns a null enrolledAt when both timestamps are missing', async () => {
      const teacher = await registerApprovedTeacher('legacy-no-time-teacher@example.com');
      const student = await registerStudent('legacy-no-time-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      await mongoose.connection.db!.collection('enrollments').insertOne({
        _id: new Types.ObjectId(),
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(courseId),
        status: 'active',
        source: 'free',
      });

      const status = await enrollmentStatus(student, courseId);
      expect(status.status).toBe(200);
      expect(status.body.data.enrollment.enrolledAt).toBeNull();
      expect(status.body.data.hasAccess).toBe(true);

      const list = await myCourses(student);
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].enrollment.enrolledAt).toBeNull();
      expect(list.body.data[0].hasAccess).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Completion state (Progress System entry point)
  // ---------------------------------------------------------------------------
  describe('completion state', () => {
    it('marks an active enrollment completed once and preserves the first timestamp', async () => {
      const teacher = await registerApprovedTeacher('complete-teacher@example.com');
      const student = await registerStudent('complete-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      await enroll(student, courseId);

      const completedAt = new Date('2025-03-03T09:00:00.000Z');
      const completed = await enrollmentRepository.markCompleted({
        studentId: student.userId,
        courseId,
        completedAt,
      });

      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
      expect(completed!.completedAt?.toISOString()).toBe(
        completedAt.toISOString(),
      );

      const later = new Date('2025-04-04T09:00:00.000Z');
      const repeat = await enrollmentRepository.markCompleted({
        studentId: student.userId,
        courseId,
        completedAt: later,
      });

      expect(repeat).toBeNull();
      const stored = await EnrollmentModel.findById(completed!._id).exec();
      expect(stored?.status).toBe('completed');
      expect(stored?.completedAt?.toISOString()).toBe(
        completedAt.toISOString(),
      );
      expect(await EnrollmentModel.countDocuments({})).toBe(1);
    });

    it('completes a legacy enrollment row without a stored status', async () => {
      const teacher = await registerApprovedTeacher('complete-legacy-teacher@example.com');
      const student = await registerStudent('complete-legacy-student@example.com');
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      await mongoose.connection.db!.collection('enrollments').insertOne({
        _id: new Types.ObjectId(),
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(courseId),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });

      const completedAt = new Date('2025-07-07T07:00:00.000Z');
      const completed = await enrollmentRepository.markCompleted({
        studentId: student.userId,
        courseId,
        completedAt,
      });

      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
      expect(completed!.completedAt?.toISOString()).toBe(
        completedAt.toISOString(),
      );
    });

    it('preserves an existing completion timestamp on a legacy completed row', async () => {
      const teacher = await registerApprovedTeacher(
        'complete-legacy-done-teacher@example.com',
      );
      const student = await registerStudent(
        'complete-legacy-done-student@example.com',
      );
      const course = await seedCourse({ ownerId: teacher.userId });
      const courseId = course._id.toString();

      const completedAt = new Date('2024-06-01T00:00:00.000Z');
      await mongoose.connection.db!.collection('enrollments').insertOne({
        _id: new Types.ObjectId(),
        studentId: new Types.ObjectId(student.userId),
        courseId: new Types.ObjectId(courseId),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        completedAt,
      });

      const later = new Date('2025-08-08T08:00:00.000Z');
      const completed = await enrollmentRepository.markCompleted({
        studentId: student.userId,
        courseId,
        completedAt: later,
      });

      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
      expect(completed!.completedAt?.toISOString()).toBe(
        completedAt.toISOString(),
      );

      const stored = await EnrollmentModel.findById(completed!._id).exec();
      expect(stored?.status).toBe('completed');
      expect(stored?.completedAt?.toISOString()).toBe(
        completedAt.toISOString(),
      );
    });

    it.each(['cancelled', 'expired'] as const)(
      'returns null without changing a %s enrollment',
      async (status) => {
        const teacher = await registerApprovedTeacher(
          `complete-${status}-teacher@example.com`,
        );
        const student = await registerStudent(
          `complete-${status}-student@example.com`,
        );
        const course = await seedCourse({ ownerId: teacher.userId });
        const courseId = course._id.toString();

        await enroll(student, courseId);
        await EnrollmentModel.updateOne(
          { studentId: student.userId, courseId },
          { $set: { status } },
        ).exec();

        const result = await enrollmentRepository.markCompleted({
          studentId: student.userId,
          courseId,
        });

        expect(result).toBeNull();

        const stored = await EnrollmentModel.findOne({
          studentId: student.userId,
          courseId,
        }).exec();
        expect(stored?.status).toBe(status);
        expect(stored?.completedAt).toBeUndefined();
      },
    );
  });
});
