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
import { CategoryModel } from '../src/modules/categories/category.model.js';
import { CategoryLockModel } from '../src/modules/categories/category-lock.model.js';
import { categoryRepository } from '../src/modules/categories/category.repository.js';
import { CategoryService } from '../src/modules/categories/category.service.js';
import type { CategoryMutationFence } from '../src/modules/categories/category.fence.js';
import {
  CATEGORY_ERRORS,
  CATEGORY_LOCK_ID,
} from '../src/modules/categories/category.constants.js';
import { courseRepository } from '../src/modules/courses/course.repository.js';
import { sectionRepository } from '../src/modules/courses/section.repository.js';
import { lessonRepository } from '../src/modules/courses/lesson.repository.js';
import { videoRepository } from '../src/modules/videos/video.repository.js';
import { userRepository } from '../src/modules/users/user.repository.js';
import { CourseService } from '../src/modules/courses/course.service.js';
import {
  COURSE_ERRORS,
  COURSE_PUBLISH_ISSUES,
} from '../src/modules/courses/course.constants.js';
import { AUTH_ERRORS } from '../src/modules/auth/auth.constants.js';
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

interface CourseDto {
  id: string;
  ownerId: string;
  title: string;
  slug: string;
  status: string;
  categoryId?: string;
  publishedAt?: string;
  sections: Array<{ id: string }>;
}

interface CatalogCategoryDto {
  id: string;
  name: string;
  slug: string;
}

interface CatalogCourseDto {
  id: string;
  title: string;
  slug: string;
  category: CatalogCategoryDto | null;
}

interface CatalogDetailDto extends CatalogCourseDto {
  curriculum: unknown[];
}

function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

describe('Course ↔ Category Integration Tests', () => {
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
    await LessonModel.deleteMany({});
    await SectionModel.deleteMany({});
    await CourseModel.deleteMany({});
    await CategoryModel.deleteMany({});
    await CategoryLockModel.deleteMany({});
    await UserModel.deleteMany({});
    await RefreshTokenModel.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    assertSafeTestDatabase();
    await LessonModel.deleteMany({});
    await SectionModel.deleteMany({});
    await CourseModel.deleteMany({});
    await CategoryModel.deleteMany({});
    await CategoryLockModel.deleteMany({});
    await UserModel.deleteMany({});
    await RefreshTokenModel.deleteMany({});
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
      name: input.name ?? 'Category Test User',
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

  async function seedCategory(input: {
    name: string;
    slug: string;
    parentId?: string;
    isActive?: boolean;
  }): Promise<string> {
    const category = await CategoryModel.create({
      name: input.name,
      slug: input.slug,
      parentId: input.parentId
        ? new Types.ObjectId(input.parentId)
        : undefined,
      isActive: input.isActive ?? true,
    });

    return category._id.toString();
  }

  async function createCourse(
    session: TestSession,
    title = 'Category Course',
    categoryId?: string | null,
  ): Promise<CourseDto> {
    const body: Record<string, unknown> = { title };
    if (categoryId !== undefined) {
      body.categoryId = categoryId;
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
  ): Promise<{ id: string }> {
    const res = await request(app)
      .post(`/api/teacher/courses/${courseId}/sections`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send({ title });

    expect(res.status).toBe(201);
    return res.body.data.course.sections[0] as { id: string };
  }

  async function addTextLesson(
    session: TestSession,
    courseId: string,
    sectionId: string,
  ) {
    const res = await request(app)
      .post(`/api/teacher/courses/${courseId}/sections/${sectionId}/lessons`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send({ type: 'text', title: 'Lesson 1', content: 'Lesson content' });

    expect(res.status).toBe(201);
  }

  async function submitForReview(session: TestSession, courseId: string) {
    const res = await request(app)
      .post(`/api/teacher/courses/${courseId}/submit`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf);

    expect(res.status).toBe(200);
    expect(res.body.data.course.status).toBe('pending_review');
  }

  async function approveCourse(admin: TestSession, courseId: string) {
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
    targetApp = app,
  ) {
    return request(targetApp)
      .post(`/api/teacher/courses/${courseId}/publish`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf);
  }

  async function makeApprovedCourse(
    teacher: TestSession,
    admin: TestSession,
    options: { title?: string; categoryId?: string } = {},
  ): Promise<CourseDto> {
    const course = await createCourse(
      teacher,
      options.title ?? 'Publishable Category Course',
      options.categoryId,
    );

    const patch = await patchCourse(teacher, course.id, {
      ...PUBLISH_METADATA,
      ...(options.categoryId ? { categoryId: options.categoryId } : {}),
    });
    expect(patch.status).toBe(200);

    const section = await addSection(teacher, course.id);
    await addTextLesson(teacher, course.id, section.id);
    await submitForReview(teacher, course.id);
    return approveCourse(admin, course.id);
  }

  async function seedPublishedCourse(input: {
    ownerId: string;
    title: string;
    slug: string;
    categoryId?: string;
    publishedAt?: Date;
  }) {
    return CourseModel.create({
      ownerId: input.ownerId,
      title: input.title,
      slug: input.slug,
      description: `${input.title} description`,
      categoryId: input.categoryId
        ? new Types.ObjectId(input.categoryId)
        : undefined,
      status: 'published',
      thumbnailUrl: PUBLISH_METADATA.thumbnailUrl,
      level: 'beginner',
      language: 'en',
      learningOutcomes: ['Learn something'],
      requirements: [],
      priceMinor: 0,
      currency: 'USD',
      publishedAt: input.publishedAt ?? new Date(),
    });
  }

  async function patchCategory(
    admin: TestSession,
    categoryId: string,
    body: Record<string, unknown>,
  ) {
    return request(app)
      .patch(`/api/admin/categories/${categoryId}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send(body);
  }

  async function deleteCategory(admin: TestSession, categoryId: string) {
    return request(app)
      .delete(`/api/admin/categories/${categoryId}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf);
  }

  function assignCourseCategory(
    admin: TestSession,
    courseId: string,
    body: Record<string, unknown>,
    targetApp = app,
  ) {
    return request(targetApp)
      .patch(`/api/admin/courses/${courseId}/category`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send(body);
  }

  function makeCourseService(categorySvc: CategoryService): CourseService {
    return new CourseService(
      courseRepository,
      sectionRepository,
      lessonRepository,
      videoRepository,
      userRepository,
      categorySvc,
    );
  }

  /**
   * Make a category-tree lease look abandoned, exactly as if
   * CATEGORY_LOCK_TTL_MS had elapsed while a request was paused.
   */
  async function expireCategoryLease(): Promise<void> {
    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    ).exec();
  }

  // ---------------------------------------------------------------------------
  // Course create/update references
  // ---------------------------------------------------------------------------

  it('creates a course with a valid category and normalizes the id', async () => {
    const teacher = await registerApprovedTeacher('create-category@test.com');
    const categoryId = await seedCategory({
      name: 'Programming',
      slug: 'programming',
    });

    const course = await createCourse(
      teacher,
      'Course with category',
      categoryId.toUpperCase(),
    );

    expect(course.categoryId).toBe(categoryId);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.categoryId?.toString()).toBe(categoryId);
  });

  it('rejects unknown and malformed category references on create', async () => {
    const teacher = await registerApprovedTeacher('invalid-category@test.com');

    const unknown = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({
        title: 'Unknown category course',
        categoryId: new Types.ObjectId().toString(),
      });

    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe(
      COURSE_ERRORS.COURSE_CATEGORY_NOT_FOUND,
    );
    expect(await CourseModel.countDocuments({})).toBe(0);

    const malformed = await request(app)
      .post('/api/teacher/courses')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Malformed category course', categoryId: 'not-an-id' });

    expect(malformed.status).toBe(422);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
    expect(await CourseModel.countDocuments({})).toBe(0);
  });

  it('updates, replaces and clears a draft category', async () => {
    const teacher = await registerApprovedTeacher('update-category@test.com');
    const first = await seedCategory({ name: 'First', slug: 'first' });
    const second = await seedCategory({ name: 'Second', slug: 'second' });

    const course = await createCourse(teacher, 'Editable category', first);

    const replaced = await patchCourse(teacher, course.id, {
      categoryId: second,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.course.categoryId).toBe(second);

    const unknown = await patchCourse(teacher, course.id, {
      categoryId: new Types.ObjectId().toString(),
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe(
      COURSE_ERRORS.COURSE_CATEGORY_NOT_FOUND,
    );

    const storedAfterFailure = await CourseModel.findById(course.id).exec();
    expect(storedAfterFailure?.categoryId?.toString()).toBe(second);

    const cleared = await patchCourse(teacher, course.id, { categoryId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.course.categoryId).toBeUndefined();

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.categoryId).toBeUndefined();
  });

  it('forbids another teacher from changing a course category', async () => {
    const owner = await registerApprovedTeacher('category-owner@test.com');
    const other = await registerApprovedTeacher('category-other@test.com');
    const ownerCategory = await seedCategory({
      name: 'Owner Category',
      slug: 'owner-category',
    });
    const otherCategory = await seedCategory({
      name: 'Other Category',
      slug: 'other-category',
    });

    const course = await createCourse(owner, 'Owned course', ownerCategory);

    const res = await patchCourse(other, course.id, {
      categoryId: otherCategory,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_FORBIDDEN);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.categoryId?.toString()).toBe(ownerCategory);
  });

  // ---------------------------------------------------------------------------
  // Publishing category rules
  // ---------------------------------------------------------------------------

  it('publishes a course with a public category and exposes it in the catalog', async () => {
    const teacher = await registerApprovedTeacher('publish-category@test.com');
    const admin = await createAdmin('publish-category-admin@test.com');
    const rootId = await seedCategory({
      name: 'Programming',
      slug: 'programming',
    });
    const categoryId = await seedCategory({
      name: 'Frontend',
      slug: 'frontend',
      parentId: rootId,
    });

    const course = await makeApprovedCourse(teacher, admin, { categoryId });
    const res = await publish(teacher, course.id);

    expect(res.status).toBe(200);
    expect(res.body.data.course.categoryId).toBe(categoryId);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('published');
    expect(stored?.categoryId?.toString()).toBe(categoryId);

    const detail = await request(app).get(`/api/courses/${course.slug}`);
    expect(detail.status).toBe(200);
    expect(
      (detail.body.data.course as CatalogDetailDto).category,
    ).toEqual({
      id: categoryId,
      name: 'Frontend',
      slug: 'frontend',
    });
  });

  it('requires a category to publish an approved course whose category was removed', async () => {
    const teacher = await registerApprovedTeacher('legacy-approved@test.com');
    const admin = await createAdmin('legacy-approved-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Later Removed',
      slug: 'later-removed',
    });

    const course = await makeApprovedCourse(teacher, admin, { categoryId });

    // Simulate a historical approved row that predates the approval category
    // guard (or whose category reference was erased directly in the database).
    await CourseModel.updateOne(
      { _id: course.id },
      { $unset: { categoryId: 1 } },
    ).exec();

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_PUBLISHABLE);
    expect(res.body.error.details.reasons).toContain(
      COURSE_PUBLISH_ISSUES.CATEGORY_REQUIRED,
    );

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('approved');
    expect(stored?.publishedAt).toBeUndefined();
  });

  it('rejects publishing when the stored category no longer exists', async () => {
    const teacher = await registerApprovedTeacher('missing-category@test.com');
    const admin = await createAdmin('missing-category-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Removed Category',
      slug: 'removed-category',
    });

    const course = await makeApprovedCourse(teacher, admin, { categoryId });

    // Simulate a historical/corrupt reference that survived a category delete.
    await CourseModel.updateOne(
      { _id: course.id },
      { categoryId: new Types.ObjectId() },
    ).exec();

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons).toContain(
      COURSE_PUBLISH_ISSUES.CATEGORY_NOT_FOUND,
    );
  });

  it('rejects publishing an inactive category', async () => {
    const teacher = await registerApprovedTeacher('inactive-category@test.com');
    const admin = await createAdmin('inactive-category-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Inactive Category',
      slug: 'inactive-category',
    });

    // Approval itself now requires an active category. Simulate a historical
    // approved row whose category was deactivated directly in the database.
    const course = await makeApprovedCourse(teacher, admin, { categoryId });
    await CategoryModel.updateOne(
      { _id: categoryId },
      { isActive: false },
    ).exec();

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons).toContain(
      COURSE_PUBLISH_ISSUES.CATEGORY_INACTIVE,
    );

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('approved');
  });

  it('rejects publishing when an ancestor of the category is inactive', async () => {
    const teacher = await registerApprovedTeacher('hidden-ancestor@test.com');
    const admin = await createAdmin('hidden-ancestor-admin@test.com');
    const rootId = await seedCategory({
      name: 'Hidden Root',
      slug: 'hidden-root',
    });
    const categoryId = await seedCategory({
      name: 'Visible Child',
      slug: 'visible-child',
      parentId: rootId,
    });

    const course = await makeApprovedCourse(teacher, admin, { categoryId });
    // Historical direct write: the API guard would refuse to hide a branch
    // containing this approved course.
    await CategoryModel.updateOne(
      { _id: rootId },
      { isActive: false },
    ).exec();

    const res = await publish(teacher, course.id);

    expect(res.status).toBe(422);
    expect(res.body.error.details.reasons).toContain(
      COURSE_PUBLISH_ISSUES.CATEGORY_INACTIVE,
    );
  });

  it('keeps a legacy draft editable and submittable without a category', async () => {
    const teacher = await registerApprovedTeacher('legacy-draft@test.com');
    const course = await createCourse(teacher, 'Legacy draft');

    const renamed = await patchCourse(teacher, course.id, {
      title: 'Renamed legacy draft',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.course.categoryId).toBeUndefined();

    const section = await addSection(teacher, course.id);
    await addTextLesson(teacher, course.id, section.id);
    await submitForReview(teacher, course.id);
  });

  // ---------------------------------------------------------------------------
  // Public catalog filtering
  // ---------------------------------------------------------------------------

  it('filters the catalog by a category and includes its descendants', async () => {
    const teacher = await registerApprovedTeacher('catalog-filter@test.com');
    const rootId = await seedCategory({
      name: 'Programming',
      slug: 'programming',
    });
    const frontendId = await seedCategory({
      name: 'Frontend',
      slug: 'frontend',
      parentId: rootId,
    });
    const reactId = await seedCategory({
      name: 'React',
      slug: 'react',
      parentId: frontendId,
    });
    const designId = await seedCategory({
      name: 'Design',
      slug: 'design',
    });

    const now = Date.now();
    await seedPublishedCourse({
      ownerId: teacher.userId,
      title: 'Root Course',
      slug: 'root-course',
      categoryId: rootId,
      publishedAt: new Date(now - 30_000),
    });
    await seedPublishedCourse({
      ownerId: teacher.userId,
      title: 'Child Course',
      slug: 'child-course',
      categoryId: frontendId,
      publishedAt: new Date(now - 20_000),
    });
    await seedPublishedCourse({
      ownerId: teacher.userId,
      title: 'Grandchild Course',
      slug: 'grandchild-course',
      categoryId: reactId,
      publishedAt: new Date(now - 10_000),
    });
    await seedPublishedCourse({
      ownerId: teacher.userId,
      title: 'Design Course',
      slug: 'design-course',
      categoryId: designId,
      publishedAt: new Date(now - 5_000),
    });
    await seedPublishedCourse({
      ownerId: teacher.userId,
      title: 'Legacy Course',
      slug: 'legacy-course',
      publishedAt: new Date(now),
    });

    const root = await request(app).get('/api/courses?category=programming');
    expect(root.status).toBe(200);
    expect(root.body.meta.total).toBe(3);
    expect(root.body.data.map((item: CatalogCourseDto) => item.title)).toEqual([
      'Grandchild Course',
      'Child Course',
      'Root Course',
    ]);

    const frontend = await request(app).get('/api/courses?category=frontend');
    expect(frontend.body.meta.total).toBe(2);
    expect(
      frontend.body.data.map((item: CatalogCourseDto) => item.title),
    ).toEqual(['Grandchild Course', 'Child Course']);

    const react = await request(app).get('/api/courses?category=react');
    expect(react.body.meta.total).toBe(1);
    expect(react.body.data[0].title).toBe('Grandchild Course');

    const design = await request(app).get('/api/courses?category=design');
    expect(design.body.meta.total).toBe(1);
    expect(design.body.data[0].category).toEqual({
      id: designId,
      name: 'Design',
      slug: 'design',
    });

    const firstPage = await request(app).get(
      '/api/courses?category=programming&page=1&limit=2',
    );
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.meta).toEqual({
      page: 1,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
    expect(firstPage.body.data).toHaveLength(2);

    const secondPage = await request(app).get(
      '/api/courses?category=programming&page=2&limit=2',
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data).toHaveLength(1);

    const unfiltered = await request(app).get('/api/courses');
    expect(unfiltered.body.meta.total).toBe(5);
  });

  it('returns 404 for unknown or hidden category filters', async () => {
    const hiddenRootId = await seedCategory({
      name: 'Hidden Root',
      slug: 'hidden-root',
      isActive: false,
    });
    const visibleChildId = await seedCategory({
      name: 'Visible Child',
      slug: 'visible-child',
      parentId: hiddenRootId,
    });
    const inactiveId = await seedCategory({
      name: 'Inactive',
      slug: 'inactive',
      isActive: false,
    });

    const unknown = await request(app).get('/api/courses?category=nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_NOT_FOUND);

    const inactive = await request(app).get('/api/courses?category=inactive');
    expect(inactive.status).toBe(404);
    expect(inactive.body.error.code).toBe(
      CATEGORY_ERRORS.CATEGORY_NOT_FOUND,
    );

    const hiddenAncestor = await request(app).get(
      '/api/courses?category=visible-child',
    );
    expect(hiddenAncestor.status).toBe(404);
    expect(hiddenAncestor.body.error.code).toBe(
      CATEGORY_ERRORS.CATEGORY_NOT_FOUND,
    );

    const malformed = await request(app).get(
      '/api/courses?category=Not_A_Slug',
    );
    expect(malformed.status).toBe(422);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');

    // Ensure the seeded ids are actually used, keeping the fixture meaningful.
    expect(visibleChildId).toBeDefined();
    expect(inactiveId).toBeDefined();
  });

  it('keeps legacy published courses visible with a null category', async () => {
    const teacher = await registerApprovedTeacher('legacy-published@test.com');
    await seedPublishedCourse({
      ownerId: teacher.userId,
      title: 'Legacy Published',
      slug: 'legacy-published',
    });

    const list = await request(app).get('/api/courses');
    expect(list.status).toBe(200);
    expect((list.body.data[0] as CatalogCourseDto).category).toBeNull();

    const detail = await request(app).get('/api/courses/legacy-published');
    expect(detail.status).toBe(200);
    expect((detail.body.data.course as CatalogDetailDto).category).toBeNull();
  });

  it('does not leak a category that became hidden after publication', async () => {
    const teacher = await registerApprovedTeacher('hidden-category-row@test.com');
    const categoryId = await seedCategory({
      name: 'Formerly Active',
      slug: 'formerly-active',
    });
    await seedPublishedCourse({
      ownerId: teacher.userId,
      title: 'Historical Course',
      slug: 'historical-course',
      categoryId,
    });

    // Simulate historical data written before the deactivation guard existed.
    await CategoryModel.updateOne(
      { _id: categoryId },
      { isActive: false },
    ).exec();

    const detail = await request(app).get('/api/courses/historical-course');
    expect(detail.status).toBe(200);
    expect((detail.body.data.course as CatalogDetailDto).category).toBeNull();

    const filtered = await request(app).get('/api/courses?category=formerly-active');
    expect(filtered.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Category guards and lock participation
  // ---------------------------------------------------------------------------

  it('blocks deleting a referenced category until the reference is cleared', async () => {
    const teacher = await registerApprovedTeacher('delete-guard@test.com');
    const admin = await createAdmin('delete-guard-admin@test.com');
    const categoryId = await seedCategory({
      name: 'In Use',
      slug: 'in-use',
    });

    const course = await createCourse(teacher, 'Draft with category', categoryId);

    const blocked = await deleteCategory(admin, categoryId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    const cleared = await patchCourse(teacher, course.id, { categoryId: null });
    expect(cleared.status).toBe(200);

    const deleted = await deleteCategory(admin, categoryId);
    expect(deleted.status).toBe(200);
  });

  it('blocks hiding a category subtree that contains a published course', async () => {
    const teacher = await registerApprovedTeacher('hide-guard@test.com');
    const admin = await createAdmin('hide-guard-admin@test.com');
    const rootId = await seedCategory({
      name: 'Parent',
      slug: 'parent',
    });
    const categoryId = await seedCategory({
      name: 'Child',
      slug: 'child',
      parentId: rootId,
    });

    const course = await makeApprovedCourse(teacher, admin, { categoryId });
    const published = await publish(teacher, course.id);
    expect(published.status).toBe(200);

    const child = await patchCategory(admin, categoryId, { isActive: false });
    expect(child.status).toBe(409);
    expect(child.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    const root = await patchCategory(admin, rootId, { isActive: false });
    expect(root.status).toBe(409);
    expect(root.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);
  });

  it('does not serialize unrelated course edits on the category lock', async () => {
    const teacher = await registerApprovedTeacher('lock-scope@test.com');
    const categoryId = await seedCategory({
      name: 'Locked Category',
      slug: 'locked-category',
    });
    const draft = await createCourse(teacher, 'Draft without category');

    const lease = await categoryRepository.acquireLock();
    expect(lease).not.toBeNull();

    try {
      const withCategory = await request(app)
        .post('/api/teacher/courses')
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf)
        .send({ title: 'Blocked category course', categoryId });
      expect(withCategory.status).toBe(409);
      expect(withCategory.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_BUSY);

      const withoutCategory = await request(app)
        .post('/api/teacher/courses')
        .set('Cookie', teacher.cookies)
        .set('X-CSRF-Token', teacher.csrf)
        .send({ title: 'Unrelated course' });
      expect(withoutCategory.status).toBe(201);

      const categoryChange = await patchCourse(teacher, draft.id, {
        categoryId,
      });
      expect(categoryChange.status).toBe(409);
      expect(categoryChange.body.error.code).toBe(
        CATEGORY_ERRORS.CATEGORY_BUSY,
      );

      const titleChange = await patchCourse(teacher, draft.id, {
        title: 'Unrelated title change',
      });
      expect(titleChange.status).toBe(200);
      expect(titleChange.body.data.course.title).toBe('Unrelated title change');
    } finally {
      await categoryRepository.releaseLock(lease!.token);
    }
  });

  /**
   * Pauses publishing after it acquired the category tree lock. A concurrent
   * admin deactivation must see the lock and fail closed instead of hiding the
   * category while the course is being published.
   */
  class PausingCategoryService extends CategoryService {
    readonly publishStarted = createGate();
    readonly resumePublish = createGate();
    private paused = false;

    override async listReferenceCategories() {
      if (!this.paused) {
        this.paused = true;
        this.publishStarted.resolve();
        await this.resumePublish.promise;
      }
      return super.listReferenceCategories();
    }
  }

  /**
   * Pause just before the course operation enters the category lock. This lets
   * an admin category repair finish first and exposes a stale course snapshot.
   */
  class PausingBeforeCategoryLockService extends CategoryService {
    readonly lockPending = createGate();
    readonly resumeLock = createGate();
    private paused = false;

    override async withCategoryReferenceLock<T>(
      operation: (fence: CategoryMutationFence) => Promise<T>,
    ): Promise<T> {
      if (!this.paused) {
        this.paused = true;
        this.lockPending.resolve();
        await this.resumeLock.promise;
      }
      return super.withCategoryReferenceLock(operation);
    }
  }

  /**
   * Pause after a draft reference is committed to the category. Expiring the
   * category lease now must not let a delete remove the category: the durable
   * reference, not the lease, is the delete guard.
   */
  class PausingDraftReferenceService extends CategoryService {
    readonly referenceAdded = createGate();
    readonly resumeReference = createGate();
    private paused = false;

    override async addDraftCourseReference(
      params: Parameters<CategoryService['addDraftCourseReference']>[0],
    ): Promise<
      Awaited<ReturnType<CategoryService['addDraftCourseReference']>>
    > {
      const result = await super.addDraftCourseReference(params);
      if (!this.paused) {
        this.paused = true;
        this.referenceAdded.resolve();
        await this.resumeReference.promise;
      }
      return result;
    }
  }

  /**
   * Pause after protected references have been written to the category and all
   * ancestors. A later hide/move/delete must see those references even when the
   * original category lease has expired.
   */
  class PausingProtectedReferenceService extends CategoryService {
    readonly referenceAdded = createGate();
    readonly resumeReference = createGate();
    private paused = false;

    override async addProtectedCourseReferencePath(
      params: Parameters<
        CategoryService['addProtectedCourseReferencePath']
      >[0],
    ): Promise<
      Awaited<ReturnType<CategoryService['addProtectedCourseReferencePath']>>
    > {
      const result = await super.addProtectedCourseReferencePath(params);
      if (!this.paused) {
        this.paused = true;
        this.referenceAdded.resolve();
        await this.resumeReference.promise;
      }
      return result;
    }
  }

  it('holds the category lock through publishing so deactivation cannot race it', async () => {
    const teacher = await registerApprovedTeacher('publish-race@test.com');
    const admin = await createAdmin('publish-race-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Race Category',
      slug: 'race-category',
    });

    const course = await makeApprovedCourse(teacher, admin, { categoryId });

    const pausing = new PausingCategoryService();
    const raceService = new CourseService(
      courseRepository,
      sectionRepository,
      lessonRepository,
      videoRepository,
      userRepository,
      pausing,
    );
    const raceApp = createApp({ courseService: raceService });

    const settled = publish(teacher, course.id, raceApp).then(
      (res) => ({ res }),
      (error: unknown) => ({ error }),
    );

    await pausing.publishStarted.promise;

    const blocked = await patchCategory(admin, categoryId, { isActive: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_BUSY);

    pausing.resumePublish.resolve();
    const result = await settled;

    expect('error' in result).toBe(false);
    if ('res' in result) {
      expect(result.res.status).toBe(200);
      expect(result.res.body.data.course.status).toBe('published');
    }

    const storedCategory = await CategoryModel.findById(categoryId).exec();
    expect(storedCategory?.isActive).toBe(true);

    const deactivated = await patchCategory(admin, categoryId, {
      isActive: false,
    });
    expect(deactivated.status).toBe(409);
    expect(deactivated.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);
  });

  // ---------------------------------------------------------------------------
  // Approval category guard and administrative repair
  // ---------------------------------------------------------------------------

  it('refuses to approve a course without a category', async () => {
    const teacher = await registerApprovedTeacher('approve-no-category@test.com');
    const admin = await createAdmin('approve-no-category-admin@test.com');
    const course = await createCourse(teacher, 'No category course');
    await submitForReview(teacher, course.id);

    const res = await request(app)
      .post(`/api/admin/courses/${course.id}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_APPROVABLE);
    expect(res.body.error.details.reasons).toEqual([
      COURSE_PUBLISH_ISSUES.CATEGORY_REQUIRED,
    ]);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('pending_review');
  });

  it('refuses to approve under an inactive category or inactive ancestor', async () => {
    const teacher = await registerApprovedTeacher('approve-inactive@test.com');
    const admin = await createAdmin('approve-inactive-admin@test.com');
    const inactiveId = await seedCategory({
      name: 'Inactive Approval',
      slug: 'inactive-approval',
      isActive: false,
    });
    const hiddenRootId = await seedCategory({
      name: 'Hidden Approval Root',
      slug: 'hidden-approval-root',
      isActive: false,
    });
    const hiddenChildId = await seedCategory({
      name: 'Hidden Approval Child',
      slug: 'hidden-approval-child',
      parentId: hiddenRootId,
    });

    for (const categoryId of [inactiveId, hiddenChildId]) {
      const course = await createCourse(
        teacher,
        `Approval ${categoryId}`,
        categoryId,
      );
      await submitForReview(teacher, course.id);

      const res = await request(app)
        .post(`/api/admin/courses/${course.id}/approve`)
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf);

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_APPROVABLE);
      expect(res.body.error.details.reasons).toContain(
        COURSE_PUBLISH_ISSUES.CATEGORY_INACTIVE,
      );

      const stored = await CourseModel.findById(course.id).exec();
      expect(stored?.status).toBe('pending_review');
    }
  });

  it('fails approval closed when the category lease expires before protected references are written', async () => {
    const teacher = await registerApprovedTeacher('approve-expiry-before@test.com');
    const admin = await createAdmin('approve-expiry-before-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Expiry Before Ref',
      slug: 'expiry-before-ref',
    });
    const course = await createCourse(teacher, 'Expiry before ref', categoryId);
    await submitForReview(teacher, course.id);

    const pausing = new PausingCategoryService();
    const raceApp = createApp({
      courseService: makeCourseService(pausing),
    });

    const settled = request(raceApp)
      .post(`/api/admin/courses/${course.id}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .then(
        (res) => ({ res }),
        (error: unknown) => ({ error }),
      );

    await pausing.publishStarted.promise;
    await expireCategoryLease();

    const deactivated = await patchCategory(admin, categoryId, {
      isActive: false,
    });
    expect(deactivated.status).toBe(200);

    pausing.resumePublish.resolve();
    const result = await settled;

    expect('error' in result).toBe(false);
    if ('res' in result) {
      expect(result.res.status).toBe(422);
      expect(result.res.body.error.code).toBe(
        COURSE_ERRORS.COURSE_NOT_APPROVABLE,
      );
    }

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('pending_review');
    const storedCategory = await CategoryModel.findById(categoryId).exec();
    expect(storedCategory?.isActive).toBe(false);
  });

  it('keeps an approved course visible when deactivation or move races after lease expiry', async () => {
    const teacher = await registerApprovedTeacher('approve-expiry-after@test.com');
    const admin = await createAdmin('approve-expiry-after-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Expiry After Ref',
      slug: 'expiry-after-ref',
    });
    const hiddenRootId = await seedCategory({
      name: 'Hidden Move Target',
      slug: 'hidden-move-target',
      isActive: false,
    });
    const course = await createCourse(teacher, 'Expiry after ref', categoryId);
    await submitForReview(teacher, course.id);

    const pausing = new PausingProtectedReferenceService();
    const raceApp = createApp({
      courseService: makeCourseService(pausing),
    });

    const settled = request(raceApp)
      .post(`/api/admin/courses/${course.id}/approve`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .then(
        (res) => ({ res }),
        (error: unknown) => ({ error }),
      );

    await pausing.referenceAdded.promise;
    await expireCategoryLease();

    const deactivated = await patchCategory(admin, categoryId, {
      isActive: false,
    });
    expect(deactivated.status).toBe(409);
    expect(deactivated.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    const moved = await patchCategory(admin, categoryId, {
      parentId: hiddenRootId,
    });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    pausing.resumeReference.resolve();
    const result = await settled;

    expect('error' in result).toBe(false);
    if ('res' in result) {
      expect(result.res.status).toBe(200);
      expect(result.res.body.data.course.status).toBe('approved');
    }

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('approved');
    const storedCategory = await CategoryModel.findById(categoryId).exec();
    expect(storedCategory?.isActive).toBe(true);
    expect(storedCategory?.parentId).toBeUndefined();
  });

  it('lets an admin repair an approved course whose category was removed', async () => {
    const teacher = await registerApprovedTeacher('repair-category@test.com');
    const admin = await createAdmin('repair-category-admin@test.com');
    const oldCategoryId = await seedCategory({
      name: 'Old Repair Category',
      slug: 'old-repair-category',
    });
    const newCategoryId = await seedCategory({
      name: 'New Repair Category',
      slug: 'new-repair-category',
    });

    const course = await makeApprovedCourse(teacher, admin, {
      categoryId: oldCategoryId,
    });
    const before = await CourseModel.findById(course.id).lean().exec();
    expect(before?.reviewedAt).toBeInstanceOf(Date);

    // Simulate the legacy/historical dead-end: approved but no category.
    await CourseModel.updateOne(
      { _id: course.id },
      { $unset: { categoryId: 1 } },
    ).exec();

    const repaired = await assignCourseCategory(admin, course.id, {
      categoryId: newCategoryId,
    });

    expect(repaired.status).toBe(200);
    expect(repaired.body.data.course.categoryId).toBe(newCategoryId);
    expect(repaired.body.data.course.status).toBe('approved');
    expect(repaired.body.data.course.publishedAt).toBeUndefined();
    expect(repaired.body.data.course.sections).toHaveLength(1);
    expect(new Date(repaired.body.data.course.reviewedAt).getTime()).toBe(
      before!.reviewedAt!.getTime(),
    );
    expect(repaired.body.data.course.reviewedBy).toBe(
      before!.reviewedBy!.toString(),
    );

    const published = await publish(teacher, course.id);
    expect(published.status).toBe(200);
    expect(published.body.data.course.status).toBe('published');
  });

  it('changes only the category and releases the old protected reference', async () => {
    const teacher = await registerApprovedTeacher('move-category@test.com');
    const admin = await createAdmin('move-category-admin@test.com');
    const oldCategoryId = await seedCategory({
      name: 'Old Admin Category',
      slug: 'old-admin-category',
    });
    const newCategoryId = await seedCategory({
      name: 'New Admin Category',
      slug: 'new-admin-category',
    });

    const course = await makeApprovedCourse(teacher, admin, {
      categoryId: oldCategoryId,
    });
    const before = await CourseModel.findById(course.id).lean().exec();

    const assigned = await assignCourseCategory(admin, course.id, {
      categoryId: newCategoryId,
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.course.categoryId).toBe(newCategoryId);
    expect(assigned.body.data.course.status).toBe('approved');

    const after = await CourseModel.findById(course.id).lean().exec();
    expect(after?.title).toBe(before?.title);
    expect(after?.description).toBe(before?.description);
    expect(after?.reviewedAt?.getTime()).toBe(before?.reviewedAt?.getTime());

    const oldDeleted = await deleteCategory(admin, oldCategoryId);
    expect(oldDeleted.status).toBe(200);

    const newDeactivated = await patchCategory(admin, newCategoryId, {
      isActive: false,
    });
    expect(newDeactivated.status).toBe(409);
    expect(newDeactivated.body.error.code).toBe(
      CATEGORY_ERRORS.CATEGORY_IN_USE,
    );
  });

  it('protects admin category assignment with role, CSRF, scope and validation', async () => {
    const teacher = await registerApprovedTeacher('assign-guard@test.com');
    const admin = await createAdmin('assign-guard-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Assign Guard',
      slug: 'assign-guard',
    });
    const otherId = await seedCategory({
      name: 'Assign Guard Other',
      slug: 'assign-guard-other',
    });
    const inactiveId = await seedCategory({
      name: 'Assign Guard Inactive',
      slug: 'assign-guard-inactive',
      isActive: false,
    });

    const approved = await makeApprovedCourse(teacher, admin, { categoryId });
    const published = await makeApprovedCourse(teacher, admin, {
      categoryId,
      title: 'Published assignment target',
    });
    expect((await publish(teacher, published.id)).status).toBe(200);

    const pending = await createCourse(teacher, 'Pending assignment target', categoryId);
    await submitForReview(teacher, pending.id);

    const teacherAttempt = await request(app)
      .patch(`/api/admin/courses/${approved.id}/category`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ categoryId: otherId });
    expect(teacherAttempt.status).toBe(403);
    expect(teacherAttempt.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    const missingCsrf = await request(app)
      .patch(`/api/admin/courses/${approved.id}/category`)
      .set('Cookie', admin.cookies)
      .send({ categoryId: otherId });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body.error.code).toBe(
      AUTH_ERRORS.CSRF_TOKEN_MISSING,
    );

    const extraField = await assignCourseCategory(admin, approved.id, {
      categoryId: otherId,
      status: 'published',
    });
    expect(extraField.status).toBe(422);
    expect(extraField.body.error.code).toBe('VALIDATION_ERROR');

    const unknown = await assignCourseCategory(admin, approved.id, {
      categoryId: new Types.ObjectId().toString(),
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe(
      COURSE_ERRORS.COURSE_CATEGORY_NOT_FOUND,
    );

    const inactive = await assignCourseCategory(admin, approved.id, {
      categoryId: inactiveId,
    });
    expect(inactive.status).toBe(422);
    expect(inactive.body.error.code).toBe(
      COURSE_ERRORS.COURSE_CATEGORY_INACTIVE,
    );

    const pendingAttempt = await assignCourseCategory(admin, pending.id, {
      categoryId: otherId,
    });
    expect(pendingAttempt.status).toBe(409);
    expect(pendingAttempt.body.error.code).toBe(
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
    );

    const publishedAttempt = await assignCourseCategory(admin, published.id, {
      categoryId: otherId,
    });
    expect(publishedAttempt.status).toBe(409);
    expect(publishedAttempt.body.error.code).toBe(
      COURSE_ERRORS.COURSE_NOT_EDITABLE,
    );
  });

  it('blocks category delete, move and deactivation while admin assignment is paused after lease expiry', async () => {
    const teacher = await registerApprovedTeacher('assign-race@test.com');
    const admin = await createAdmin('assign-race-admin@test.com');
    const oldCategoryId = await seedCategory({
      name: 'Assign Race Old',
      slug: 'assign-race-old',
    });
    const newCategoryId = await seedCategory({
      name: 'Assign Race New',
      slug: 'assign-race-new',
    });
    const hiddenRootId = await seedCategory({
      name: 'Assign Race Hidden',
      slug: 'assign-race-hidden',
      isActive: false,
    });

    const course = await makeApprovedCourse(teacher, admin, {
      categoryId: oldCategoryId,
    });

    const pausing = new PausingProtectedReferenceService();
    const raceApp = createApp({
      courseService: makeCourseService(pausing),
    });

    const settled = assignCourseCategory(
      admin,
      course.id,
      { categoryId: newCategoryId },
      raceApp,
    ).then(
      (res) => ({ res }),
      (error: unknown) => ({ error }),
    );

    await pausing.referenceAdded.promise;
    await expireCategoryLease();

    const deleted = await deleteCategory(admin, newCategoryId);
    expect(deleted.status).toBe(409);
    expect(deleted.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    const deactivated = await patchCategory(admin, newCategoryId, {
      isActive: false,
    });
    expect(deactivated.status).toBe(409);
    expect(deactivated.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    const moved = await patchCategory(admin, newCategoryId, {
      parentId: hiddenRootId,
    });
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    pausing.resumeReference.resolve();
    const result = await settled;

    expect('error' in result).toBe(false);
    if ('res' in result) {
      expect(result.res.status).toBe(200);
      expect(result.res.body.data.course.categoryId).toBe(newCategoryId);
    }

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.categoryId?.toString()).toBe(newCategoryId);
    expect(stored?.status).toBe('approved');
  });

  it('blocks category deletion while a draft assignment is paused after lease expiry', async () => {
    const teacher = await registerApprovedTeacher('assign-draft-race@test.com');
    const admin = await createAdmin('assign-draft-race-admin@test.com');
    const oldCategoryId = await seedCategory({
      name: 'Draft Race Old',
      slug: 'draft-race-old',
    });
    const newCategoryId = await seedCategory({
      name: 'Draft Race New',
      slug: 'draft-race-new',
    });
    const course = await createCourse(teacher, 'Draft race', oldCategoryId);

    const pausing = new PausingDraftReferenceService();
    const raceApp = createApp({
      courseService: makeCourseService(pausing),
    });

    const settled = request(raceApp)
      .patch(`/api/teacher/courses/${course.id}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ categoryId: newCategoryId })
      .then(
        (res) => ({ res }),
        (error: unknown) => ({ error }),
      );

    await pausing.referenceAdded.promise;
    await expireCategoryLease();

    const blocked = await deleteCategory(admin, newCategoryId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    pausing.resumeReference.resolve();
    const result = await settled;

    expect('error' in result).toBe(false);
    if ('res' in result) {
      expect(result.res.status).toBe(200);
      expect(result.res.body.data.course.categoryId).toBe(newCategoryId);
    }

    const oldDeleted = await deleteCategory(admin, oldCategoryId);
    expect(oldDeleted.status).toBe(200);
  });

  it('blocks category deletion while course creation is paused after lease expiry', async () => {
    const teacher = await registerApprovedTeacher('create-race@test.com');
    const admin = await createAdmin('create-race-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Create Race',
      slug: 'create-race',
    });

    const pausing = new PausingDraftReferenceService();
    const raceApp = createApp({
      courseService: makeCourseService(pausing),
    });

    const settled = request(raceApp)
      .post('/api/teacher/courses')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Create race course', categoryId })
      .then(
        (res) => ({ res }),
        (error: unknown) => ({ error }),
      );

    await pausing.referenceAdded.promise;
    await expireCategoryLease();

    const blocked = await deleteCategory(admin, categoryId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    pausing.resumeReference.resolve();
    const result = await settled;

    expect('error' in result).toBe(false);
    if ('res' in result) {
      expect(result.res.status).toBe(201);
      expect(result.res.body.data.course.categoryId).toBe(categoryId);
    }
  });

  it('keeps publishing safe when deactivation races after lease expiry', async () => {
    const teacher = await registerApprovedTeacher('publish-expiry@test.com');
    const admin = await createAdmin('publish-expiry-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Publish Expiry',
      slug: 'publish-expiry',
    });
    const course = await makeApprovedCourse(teacher, admin, { categoryId });

    const pausing = new PausingProtectedReferenceService();
    const raceApp = createApp({
      courseService: makeCourseService(pausing),
    });

    const settled = publish(teacher, course.id, raceApp).then(
      (res) => ({ res }),
      (error: unknown) => ({ error }),
    );

    await pausing.referenceAdded.promise;
    await expireCategoryLease();

    const blocked = await patchCategory(admin, categoryId, {
      isActive: false,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    pausing.resumeReference.resolve();
    const result = await settled;

    expect('error' in result).toBe(false);
    if ('res' in result) {
      expect(result.res.status).toBe(200);
      expect(result.res.body.data.course.status).toBe('published');
    }

    const storedCategory = await CategoryModel.findById(categoryId).exec();
    expect(storedCategory?.isActive).toBe(true);
  });

  it('fails a publish whose category changed before it entered the category lock', async () => {
    const teacher = await registerApprovedTeacher('publish-stale-category@test.com');
    const admin = await createAdmin('publish-stale-category-admin@test.com');
    const oldCategoryId = await seedCategory({
      name: 'Publish Stale Old',
      slug: 'publish-stale-old',
    });
    const newCategoryId = await seedCategory({
      name: 'Publish Stale New',
      slug: 'publish-stale-new',
    });
    const course = await makeApprovedCourse(teacher, admin, {
      categoryId: oldCategoryId,
    });

    const pausing = new PausingBeforeCategoryLockService();
    const raceApp = createApp({
      courseService: makeCourseService(pausing),
    });

    const settled = publish(teacher, course.id, raceApp).then(
      (res) => ({ res }),
      (error: unknown) => ({ error }),
    );

    await pausing.lockPending.promise;

    const assigned = await assignCourseCategory(admin, course.id, {
      categoryId: newCategoryId,
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.course.categoryId).toBe(newCategoryId);

    pausing.resumeLock.resolve();
    const result = await settled;

    expect('error' in result).toBe(false);
    if ('res' in result) {
      expect(result.res.status).toBe(409);
      expect(result.res.body.error.code).toBe(
        COURSE_ERRORS.INVALID_STATUS_TRANSITION,
      );
    }

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.status).toBe('approved');
    expect(stored?.publishedAt).toBeUndefined();
    expect(stored?.categoryId?.toString()).toBe(newCategoryId);

    // The stale publish must not leave a protected reference on the old branch.
    const oldDeleted = await deleteCategory(admin, oldCategoryId);
    expect(oldDeleted.status).toBe(200);

    const retried = await publish(teacher, course.id);
    expect(retried.status).toBe(200);
    expect(retried.body.data.course.status).toBe('published');
  });

  it('rejects category changes on a published course', async () => {
    const teacher = await registerApprovedTeacher('published-freeze@test.com');
    const admin = await createAdmin('published-freeze-admin@test.com');
    const categoryId = await seedCategory({
      name: 'Frozen Category',
      slug: 'frozen-category',
    });
    const otherId = await seedCategory({
      name: 'Other Frozen',
      slug: 'other-frozen',
    });

    const course = await makeApprovedCourse(teacher, admin, { categoryId });
    const published = await publish(teacher, course.id);
    expect(published.status).toBe(200);

    const res = await patchCourse(teacher, course.id, { categoryId: otherId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(COURSE_ERRORS.COURSE_NOT_EDITABLE);

    const stored = await CourseModel.findById(course.id).exec();
    expect(stored?.categoryId?.toString()).toBe(categoryId);
  });

  it('keeps existing teacher authorization codes for category references', async () => {
    const teacher = await registerApprovedTeacher('authz-category@test.com');
    const student = await registerUser({
      email: 'authz-category-student@test.com',
      role: 'student',
    });
    const categoryId = await seedCategory({
      name: 'Authz Category',
      slug: 'authz-category',
    });

    const course = await createCourse(teacher, 'Authz course', categoryId);

    const res = await patchCourse(student, course.id, {
      categoryId: null,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);
  });
});
