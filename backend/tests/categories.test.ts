import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose, { Types } from 'mongoose';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { CourseModel } from '../src/modules/courses/course.model.js';
import { CategoryModel } from '../src/modules/categories/category.model.js';
import { CategoryLockModel } from '../src/modules/categories/category-lock.model.js';
import {
  CategoryRepository,
  type CategoryUpdate,
} from '../src/modules/categories/category.repository.js';
import { CategoryService } from '../src/modules/categories/category.service.js';
import type { CategoryMutationFence } from '../src/modules/categories/category.fence.js';
import type { CategoryDocument } from '../src/modules/categories/category.types.js';
import {
  CATEGORY_ERRORS,
  CATEGORY_LOCK_ID,
} from '../src/modules/categories/category.constants.js';
import { AUTH_ERRORS } from '../src/modules/auth/auth.constants.js';
import { CSRF_COOKIE_NAME } from '../src/middleware/csrf.js';
import type { AuthUser } from '../src/modules/users/user.types.js';

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

interface AdminCategoryDto {
  id: string;
  name: string;
  slug: string;
  description?: string;
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface PublicCategoryDto {
  id: string;
  name: string;
  slug: string;
  description?: string;
  parentId: string | null;
  children: PublicCategoryDto[];
}

function createGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Wraps the real repository so an integration test can pause a request
 * immediately before its fenced write. This is deterministic orchestration, not
 * a mock: both requests still use the real lock, category collection and
 * database-time fence.
 */
class PausingCategoryRepository extends CategoryRepository {
  readonly staleWriteStarted = createGate();
  readonly continueStaleWrite = createGate();

  override async updateById(
    id: string,
    update: CategoryUpdate,
    unset: string[] = [],
    fence: CategoryMutationFence,
  ): Promise<CategoryDocument | null> {
    if (update.name === 'Stale A') {
      this.staleWriteStarted.resolve();
      await this.continueStaleWrite.promise;
    }
    return super.updateById(id, update, unset, fence);
  }
}

/**
 * Pauses holder A immediately after it acquires the lock and before it copies
 * its fence onto category rows. Holder B can then acquire the expired lock and
 * install a newer generation before A resumes.
 */
class PausingRefreshCategoryRepository extends CategoryRepository {
  readonly refreshStarted = createGate();
  readonly continueRefresh = createGate();
  private pauseNextRefresh = true;

  protected override async refreshLease(
    fence: CategoryMutationFence,
  ): Promise<void> {
    if (this.pauseNextRefresh) {
      this.pauseNextRefresh = false;
      this.refreshStarted.resolve();
      await this.continueRefresh.promise;
    }
    await super.refreshLease(fence);
  }
}

/**
 * Applies the first lease refresh and then pauses that acquisition before its
 * ownership revalidation. This lets a test prove an older refresh actually
 * landed before the newer holder refreshes and takes over, the opposite of the
 * ordering covered by `PausingRefreshCategoryRepository`.
 */
class AfterRefreshPausingCategoryRepository extends CategoryRepository {
  readonly firstRefreshApplied = createGate();
  readonly continueFirstRefresh = createGate();
  private refreshCount = 0;

  protected override async refreshLease(
    fence: CategoryMutationFence,
  ): Promise<void> {
    this.refreshCount += 1;
    const current = this.refreshCount;

    await super.refreshLease(fence);

    if (current === 1) {
      this.firstRefreshApplied.resolve();
      await this.continueFirstRefresh.promise;
    }
  }
}

describe('Category Backend Foundation Integration Tests', () => {
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
    await CategoryLockModel.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    assertSafeTestDatabase();
    await UserModel.deleteMany({});
    await RefreshTokenModel.deleteMany({});
    await CourseModel.deleteMany({});
    await CategoryModel.deleteMany({});
    await CategoryLockModel.deleteMany({});
  });

  async function createSession(role: 'student' | 'teacher' | 'admin'): Promise<TestSession> {
    const email = `${role}-${new Types.ObjectId().toString()}@test.com`;
    const passwordHash = await bcrypt.hash('Password123!', 4);

    await UserModel.create({
      name: `Category ${role}`,
      email,
      passwordHash,
      role,
      teacherStatus: role === 'teacher' ? 'approved' : 'none',
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

  async function createCategory(
    admin: TestSession,
    body: Record<string, unknown>,
  ): Promise<AdminCategoryDto> {
    const res = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send(body);

    expect(res.status).toBe(201);
    return res.body.data.category as AdminCategoryDto;
  }

  async function listPublic(): Promise<PublicCategoryDto[]> {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    return res.body.data.categories as PublicCategoryDto[];
  }

  it('requires an admin for category management routes', async () => {
    const unauth = await request(app).get('/api/admin/categories');
    expect(unauth.status).toBe(401);
    expect(unauth.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);

    const student = await createSession('student');
    const teacher = await createSession('teacher');
    const admin = await createSession('admin');

    for (const session of [student, teacher]) {
      const list = await request(app)
        .get('/api/admin/categories')
        .set('Cookie', session.cookies);
      expect(list.status).toBe(403);

      const create = await request(app)
        .post('/api/admin/categories')
        .set('Cookie', session.cookies)
        .set('X-CSRF-Token', session.csrf)
        .send({ name: 'Forbidden' });
      expect(create.status).toBe(403);
    }

    const allowed = await request(app)
      .get('/api/admin/categories')
      .set('Cookie', admin.cookies);
    expect(allowed.status).toBe(200);
  });

  it('requires CSRF and valid input for admin writes', async () => {
    const admin = await createSession('admin');

    const noCsrf = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .send({ name: 'Programming' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_MISSING);

    const shortName = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'x' });
    expect(shortName.status).toBe(422);
    expect(shortName.body.error.code).toBe('VALIDATION_ERROR');

    const badParent = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'Child', parentId: 'not-an-object-id' });
    expect(badParent.status).toBe(422);

    const emptyUpdate = await request(app)
      .patch('/api/admin/categories/665f00000000000000000000')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({});
    expect(emptyUpdate.status).toBe(422);
  });

  it('creates a nested Programming → Frontend → React tree', async () => {
    const admin = await createSession('admin');
    const programming = await createCategory(admin, {
      name: 'Programming',
      description: 'Software development',
      sortOrder: 10,
    });
    const frontend = await createCategory(admin, {
      name: 'Frontend',
      parentId: programming.id,
      sortOrder: 5,
    });
    const react = await createCategory(admin, {
      name: 'React',
      parentId: frontend.id,
      sortOrder: 1,
    });

    expect(programming.slug).toBe('programming');
    expect(frontend.slug).toBe('frontend');
    expect(react.slug).toBe('react');
    expect(frontend.parentId).toBe(programming.id);
    expect(react.parentId).toBe(frontend.id);

    const tree = await listPublic();
    expect(tree).toHaveLength(1);
    expect(tree[0].slug).toBe('programming');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].slug).toBe('frontend');
    expect(tree[0].children[0].children[0].slug).toBe('react');

    const adminList = await request(app)
      .get('/api/admin/categories')
      .set('Cookie', admin.cookies);
    expect(adminList.status).toBe(200);
    expect(adminList.body.data.categories).toHaveLength(3);
  });

  it('keeps slugs unique and stable across renames', async () => {
    const admin = await createSession('admin');
    const first = await createCategory(admin, { name: 'Programming' });
    const second = await createCategory(admin, { name: 'Programming' });
    const third = await createCategory(admin, { name: 'Programming' });

    expect(first.slug).toBe('programming');
    expect(second.slug).toBe('programming-2');
    expect(third.slug).toBe('programming-3');

    const renamed = await request(app)
      .patch(`/api/admin/categories/${first.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'Software Engineering', description: null });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.category.name).toBe('Software Engineering');
    expect(renamed.body.data.category.slug).toBe('programming');
    expect(renamed.body.data.category.description).toBeUndefined();
  });

  it('rejects self-parenting and descendant-parenting', async () => {
    const admin = await createSession('admin');
    const root = await createCategory(admin, { name: 'Programming' });
    const child = await createCategory(admin, {
      name: 'Frontend',
      parentId: root.id,
    });
    const grandchild = await createCategory(admin, {
      name: 'React',
      parentId: child.id,
    });

    const self = await request(app)
      .patch(`/api/admin/categories/${root.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ parentId: root.id });
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_CYCLE);

    const descendant = await request(app)
      .patch(`/api/admin/categories/${root.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ parentId: grandchild.id });
    expect(descendant.status).toBe(409);
    expect(descendant.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_CYCLE);
  });

  it('enforces the maximum category depth', async () => {
    const admin = await createSession('admin');
    let parentId: string | null = null;
    let lastId = '';

    for (let depth = 0; depth <= 10; depth += 1) {
      const created = await createCategory(admin, {
        name: `Depth ${depth}`,
        parentId,
      });
      parentId = created.id;
      lastId = created.id;
    }

    const tooDeep = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'Depth 11', parentId: lastId });
    expect(tooDeep.status).toBe(422);
    expect(tooDeep.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_MAX_DEPTH);
  });

  it('validates the full depth of a moved subtree and supports higher/root moves', async () => {
    const admin = await createSession('admin');

    const source = await createCategory(admin, { name: 'Move Source' });
    const child = await createCategory(admin, {
      name: 'Move Child',
      parentId: source.id,
    });
    const grandchild = await createCategory(admin, {
      name: 'Move Grandchild',
      parentId: child.id,
    });

    // Move a node up to its grandparent and then to the root.
    const movedUp = await request(app)
      .patch(`/api/admin/categories/${grandchild.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ parentId: source.id });
    expect(movedUp.status).toBe(200);
    expect(movedUp.body.data.category.parentId).toBe(source.id);

    const movedToRoot = await request(app)
      .patch(`/api/admin/categories/${grandchild.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ parentId: null });
    expect(movedToRoot.status).toBe(200);
    expect(movedToRoot.body.data.category.parentId).toBeNull();

    const chain: string[] = [];
    let parentId: string | null = null;
    for (let depth = 0; depth <= 9; depth += 1) {
      const created = await createCategory(admin, {
        name: `Move Depth ${depth}`,
        parentId,
      });
      chain.push(created.id);
      parentId = created.id;
    }

    const branch = await createCategory(admin, { name: 'Moved Branch' });
    await createCategory(admin, {
      name: 'Moved Leaf',
      parentId: branch.id,
    });

    // Branch height 1 under depth 7 produces depths 8 and 9: allowed.
    const allowed = await request(app)
      .patch(`/api/admin/categories/${branch.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ parentId: chain[7] });
    expect(allowed.status).toBe(200);

    // Branch height 1 under depth 9 would produce depths 10 and 11: rejected.
    const tooDeep = await request(app)
      .patch(`/api/admin/categories/${branch.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ parentId: chain[9] });
    expect(tooDeep.status).toBe(422);
    expect(tooDeep.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_MAX_DEPTH);
  });

  it('normalizes uppercase ObjectIds for get, update, parent and delete', async () => {
    const admin = await createSession('admin');
    const root = await createCategory(admin, { name: 'Uppercase Root' });
    const other = await createCategory(admin, { name: 'Uppercase Other' });

    // parentId supplied with uppercase hex.
    const child = await createCategory(admin, {
      name: 'Uppercase Child',
      parentId: root.id.toUpperCase(),
    });
    expect(child.parentId).toBe(root.id);

    const get = await request(app)
      .get(`/api/admin/categories/${root.id.toUpperCase()}`)
      .set('Cookie', admin.cookies);
    expect(get.status).toBe(200);
    expect(get.body.data.category.id).toBe(root.id);

    const update = await request(app)
      .patch(`/api/admin/categories/${child.id.toUpperCase()}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'Uppercase Child Renamed', parentId: other.id.toUpperCase() });
    expect(update.status).toBe(200);
    expect(update.body.data.category.parentId).toBe(other.id);

    const removeChild = await request(app)
      .delete(`/api/admin/categories/${child.id.toUpperCase()}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf);
    expect(removeChild.status).toBe(200);

    const getDeleted = await request(app)
      .get(`/api/admin/categories/${child.id.toUpperCase()}`)
      .set('Cookie', admin.cookies);
    expect(getDeleted.status).toBe(404);

    for (const id of [root.id, other.id]) {
      const remove = await request(app)
        .delete(`/api/admin/categories/${id.toUpperCase()}`)
        .set('Cookie', admin.cookies)
        .set('X-CSRF-Token', admin.csrf);
      expect(remove.status).toBe(200);
    }
  });

  it('rejects unknown fields on create and update while keeping documented fields', async () => {
    const admin = await createSession('admin');

    const unknownCreate = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({
        name: 'Strict Category',
        slug: 'client-controlled-slug',
        createdAt: '2020-01-01T00:00:00.000Z',
      });
    expect(unknownCreate.status).toBe(422);
    expect(unknownCreate.body.error.code).toBe('VALIDATION_ERROR');

    const category = await createCategory(admin, { name: 'Strict Existing' });

    const unknownUpdate = await request(app)
      .patch(`/api/admin/categories/${category.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({
        name: 'Strict Renamed',
        slug: 'client-controlled-slug',
        createdAt: '2020-01-01T00:00:00.000Z',
      });
    expect(unknownUpdate.status).toBe(422);
    expect(unknownUpdate.body.error.code).toBe('VALIDATION_ERROR');

    const invalidIsActive = await request(app)
      .patch(`/api/admin/categories/${category.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ isActive: 'false' });
    expect(invalidIsActive.status).toBe(422);

    // isActive is a documented admin field; it must keep working as before.
    const allowed = await request(app)
      .patch(`/api/admin/categories/${category.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'Strict Renamed', isActive: false });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.category.name).toBe('Strict Renamed');
    expect(allowed.body.data.category.isActive).toBe(false);
  });

  it('rejects a non-existent parent and returns 404 for unknown categories', async () => {
    const admin = await createSession('admin');

    const missingParent = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({
        name: 'Child',
        parentId: new Types.ObjectId().toString(),
      });
    expect(missingParent.status).toBe(422);
    expect(missingParent.body.error.code).toBe(
      CATEGORY_ERRORS.CATEGORY_PARENT_NOT_FOUND,
    );

    const unknown = await request(app)
      .get(`/api/admin/categories/${new Types.ObjectId().toString()}`)
      .set('Cookie', admin.cookies);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_NOT_FOUND);
  });

  it('prevents deleting a category with children', async () => {
    const admin = await createSession('admin');
    const root = await createCategory(admin, { name: 'Programming' });
    await createCategory(admin, {
      name: 'Frontend',
      parentId: root.id,
    });

    const res = await request(app)
      .delete(`/api/admin/categories/${root.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_HAS_CHILDREN);
  });

  it('prevents deleting a category referenced by a course', async () => {
    const admin = await createSession('admin');
    const category = await createCategory(admin, { name: 'Referenced' });

    // The course-category relationship is introduced in the next phase. Insert
    // a raw reference to prove the deletion guard is already enforced.
    await CourseModel.collection.insertOne({
      ownerId: new Types.ObjectId(admin.userId),
      title: 'Referenced course',
      slug: `referenced-${new Types.ObjectId().toString()}`,
      status: 'draft',
      categoryId: new Types.ObjectId(category.id),
      editLocked: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .delete(`/api/admin/categories/${category.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);
  });

  it('deletes an unused leaf category', async () => {
    const admin = await createSession('admin');
    const category = await createCategory(admin, { name: 'Temporary' });

    const res = await request(app)
      .delete(`/api/admin/categories/${category.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf);
    expect(res.status).toBe(200);

    const get = await request(app)
      .get(`/api/admin/categories/${category.id}`)
      .set('Cookie', admin.cookies);
    expect(get.status).toBe(404);
  });

  it('hides inactive categories and their branches from the public tree', async () => {
    const admin = await createSession('admin');
    const root = await createCategory(admin, { name: 'Programming' });
    const activeChild = await createCategory(admin, {
      name: 'Frontend',
      parentId: root.id,
    });
    const inactiveChild = await createCategory(admin, {
      name: 'Legacy',
      parentId: root.id,
      isActive: false,
    });
    await createCategory(admin, {
      name: 'Old React',
      parentId: inactiveChild.id,
      isActive: true,
    });

    const tree = await listPublic();
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((node) => node.slug)).toEqual([
      activeChild.slug,
    ]);
    expect(tree[0].children[0].children).toEqual([]);

    const adminList = await request(app)
      .get('/api/admin/categories')
      .set('Cookie', admin.cookies);
    expect(adminList.body.data.categories).toHaveLength(4);

    const activated = await request(app)
      .patch(`/api/admin/categories/${inactiveChild.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ isActive: true });
    expect(activated.status).toBe(200);

    const expanded = await listPublic();
    expect(expanded[0].children).toHaveLength(2);
  });

  it('does not expose management fields in the public tree', async () => {
    const admin = await createSession('admin');
    await createCategory(admin, {
      name: 'Programming',
      sortOrder: 3,
    });

    const tree = await listPublic();
    expect(tree[0]).not.toHaveProperty('isActive');
    expect(tree[0]).not.toHaveProperty('sortOrder');
    expect(tree[0]).not.toHaveProperty('createdAt');
  });

  it('orders roots and children deterministically by sortOrder then name', async () => {
    const admin = await createSession('admin');
    await createCategory(admin, { name: 'Second', sortOrder: 20 });
    await createCategory(admin, { name: 'First', sortOrder: 10 });
    const root = await createCategory(admin, {
      name: 'Parent',
      sortOrder: 5,
    });
    await createCategory(admin, {
      name: 'Zulu',
      parentId: root.id,
      sortOrder: 2,
    });
    await createCategory(admin, {
      name: 'Alpha',
      parentId: root.id,
      sortOrder: 1,
    });

    const tree = await listPublic();
    expect(tree.map((node) => node.name)).toEqual([
      'Parent',
      'First',
      'Second',
    ]);
    expect(tree[0].children.map((node) => node.name)).toEqual([
      'Alpha',
      'Zulu',
    ]);
  });

  it('blocks writes while the category lock is held and recovers a stale lock', async () => {
    const admin = await createSession('admin');
    const now = new Date();

    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      {
        $set: {
          locked: true,
          token: 'held-by-another-request',
          lockedAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
        },
      },
      { upsert: true },
    ).exec();

    const busy = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'Blocked' });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_BUSY);

    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      {
        $set: {
          expiresAt: new Date(Date.now() - 1_000),
        },
      },
    ).exec();

    const recovered = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'Recovered' });
    expect(recovered.status).toBe(201);
  });

  it('recovers a legacy lock document that has no expiresAt field', async () => {
    const admin = await createSession('admin');

    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      {
        $set: {
          locked: true,
          token: 'legacy-lock-without-expiry',
          lockedAt: new Date(),
        },
      },
      { upsert: true },
    ).exec();

    const res = await request(app)
      .post('/api/admin/categories')
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: 'Recovered Legacy Lock' });
    expect(res.status).toBe(201);
  });

  it('lifts a lease above old fences when the lock document is recreated', async () => {
    const repo = new CategoryRepository();
    const category = await CategoryModel.create({
      name: 'Lost Lock Target',
      slug: 'lost-lock-target',
      isActive: true,
      sortOrder: 0,
    });
    const olderLease = await repo.acquireLock();
    expect(olderLease).not.toBeNull();

    const fenced = await CategoryModel.findById(category._id).exec();
    expect(fenced?.mutationToken).toBe(olderLease!.token);
    expect(fenced?.fenceGeneration).toBe(olderLease!.generation);

    // Simulate out-of-band loss of the singleton. Its recreated counter starts
    // from zero, below the fence already copied onto the committed row.
    await CategoryLockModel.deleteOne({ _id: CATEGORY_LOCK_ID }).exec();

    const newerLease = await repo.acquireLock();
    expect(newerLease).not.toBeNull();
    expect(newerLease!.generation).toBeGreaterThan(olderLease!.generation);

    const stored = await CategoryModel.findById(category._id).exec();
    expect(stored?.mutationToken).toBe(newerLease!.token);
    expect(stored?.fenceGeneration).toBe(newerLease!.generation);

    // The older holder still has a time-valid fence object, but its generation
    // was replaced on every row, so its write is fail-closed.
    const staleWrite = await repo.updateById(
      category._id.toString(),
      { name: 'Lost Lock Stale' },
      [],
      olderLease!,
    );
    expect(staleWrite).toBeNull();

    const freshWrite = await repo.updateById(
      category._id.toString(),
      { name: 'Lost Lock Fresh' },
      [],
      newerLease!,
    );
    expect(freshWrite?.name).toBe('Lost Lock Fresh');

    await repo.releaseLock(newerLease!.token);
    expect((await CategoryModel.findById(category._id).exec())?.name).toBe(
      'Lost Lock Fresh',
    );
  });

  it('revokes a staged create from a lost lock before it can commit', async () => {
    const repo = new CategoryRepository();
    await CategoryModel.create({
      name: 'Lost Lock Floor',
      slug: 'lost-lock-floor',
      isActive: true,
      sortOrder: 0,
    });
    const olderLease = await repo.acquireLock();
    expect(olderLease).not.toBeNull();
    const staged = await repo.create(
      {
        name: 'Lost Lock Staged',
        slug: 'lost-lock-staged',
      },
      olderLease!,
    );

    // Lose the singleton while the older holder still has a live staged row.
    await CategoryLockModel.deleteOne({ _id: CATEGORY_LOCK_ID }).exec();

    const newerLease = await repo.acquireLock();
    expect(newerLease).not.toBeNull();
    expect(newerLease!.generation).toBeGreaterThan(olderLease!.generation);

    // Acquisition revokes the older staged row, so its still-time-valid fence
    // cannot commit it.
    expect(await CategoryModel.findById(staged._id).exec()).toBeNull();
    const committed = await repo.commitCreated(
      staged._id.toString(),
      olderLease!,
    );
    expect(committed).toBeNull();

    const visible = await repo.listAll();
    expect(visible.some((item) => item.slug === 'lost-lock-staged')).toBe(
      false,
    );

    await repo.releaseLock(newerLease!.token);
  });

  it('revokes a same-generation staged row when a recreated lock collides', async () => {
    const repo = new CategoryRepository();
    const olderLease = await repo.acquireLock();
    expect(olderLease).not.toBeNull();
    const staged = await repo.create(
      {
        name: 'Collision Staged',
        slug: 'collision-staged',
      },
      olderLease!,
    );

    // With no committed row there is no generation floor, so a recreated
    // singleton starts at the same value and the new acquisition necessarily
    // collides with the older staged fence.
    await CategoryLockModel.deleteOne({ _id: CATEGORY_LOCK_ID }).exec();
    const newerLease = await repo.acquireLock();
    expect(newerLease).not.toBeNull();
    expect(newerLease!.generation).toBe(olderLease!.generation);

    // The token differs, so the same-generation foreign staged row is revoked.
    expect(await CategoryModel.findById(staged._id).exec()).toBeNull();
    expect(
      await repo.commitCreated(staged._id.toString(), olderLease!),
    ).toBeNull();

    await repo.releaseLock(newerLease!.token);
  });

  it('recovers a lock restored at an older generation without reviving old fences', async () => {
    const repo = new CategoryRepository();
    const category = await CategoryModel.create({
      name: 'Restored Lock Target',
      slug: 'restored-lock-target',
      isActive: true,
      sortOrder: 0,
    });

    // Advance the retained counter so the row fence is above 1.
    const bootstrap = await repo.acquireLock();
    expect(bootstrap).not.toBeNull();
    await repo.releaseLock(bootstrap!.token);

    const olderLease = await repo.acquireLock();
    expect(olderLease).not.toBeNull();
    expect(olderLease!.generation).toBeGreaterThan(1);

    const fenced = await CategoryModel.findById(category._id).exec();
    expect(fenced?.fenceGeneration).toBe(olderLease!.generation);

    // Simulate restoring an older copy of the singleton: the counter regresses
    // while committed rows still carry the newer fence.
    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      {
        $set: { locked: false, fenceGeneration: 1 },
        $unset: { token: 1, lockedAt: 1, expiresAt: 1 },
      },
    ).exec();

    const newerLease = await repo.acquireLock();
    expect(newerLease).not.toBeNull();
    expect(newerLease!.generation).toBeGreaterThan(olderLease!.generation);

    const stored = await CategoryModel.findById(category._id).exec();
    expect(stored?.mutationToken).toBe(newerLease!.token);
    expect(stored?.fenceGeneration).toBe(newerLease!.generation);

    const staleWrite = await repo.updateById(
      category._id.toString(),
      { name: 'Restored Stale' },
      [],
      olderLease!,
    );
    expect(staleWrite).toBeNull();

    const freshWrite = await repo.updateById(
      category._id.toString(),
      { name: 'Restored Fresh' },
      [],
      newerLease!,
    );
    expect(freshWrite?.name).toBe('Restored Fresh');

    await repo.releaseLock(newerLease!.token);
  });

  it('allows only one of two concurrent lock acquisitions', async () => {
    const repo = new CategoryRepository();
    const leases = await Promise.all([repo.acquireLock(), repo.acquireLock()]);
    const winners = leases.filter((lease) => lease !== null);

    expect(winners).toHaveLength(1);
    if (winners[0]) {
      await repo.releaseLock(winners[0].token);
    }
  });

  it('does not let a stale release clear a newer lease, fences or staged rows', async () => {
    const repo = new CategoryRepository();
    const category = await CategoryModel.create({
      name: 'Lease Target',
      slug: 'lease-target',
      isActive: true,
      sortOrder: 0,
    });
    const first = await repo.acquireLock();
    expect(first).not.toBeNull();

    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    ).exec();

    const second = await repo.acquireLock();
    expect(second).not.toBeNull();
    const newerStage = await repo.create(
      {
        name: 'Newer Staged',
        slug: 'newer-staged',
      },
      second!,
    );

    // The old holder has returned and its finally-block release runs late.
    await repo.releaseLock(first!.token);

    const lock = await CategoryLockModel.findById(CATEGORY_LOCK_ID).exec();
    expect(lock?.locked).toBe(true);
    expect(lock?.token).toBe(second!.token);

    const storedCategory = await CategoryModel.findById(category._id).exec();
    expect(storedCategory?.mutationToken).toBe(second!.token);
    expect(storedCategory?.fenceGeneration).toBe(second!.generation);
    expect(storedCategory?.leaseExpiresAt).toBeInstanceOf(Date);

    const storedStage = await CategoryModel.findById(newerStage._id).exec();
    expect(storedStage?.committed).toBe(false);
    expect(storedStage?.mutationToken).toBe(second!.token);

    await repo.releaseLock(second!.token);
    expect(await CategoryModel.findById(newerStage._id).exec()).toBeNull();
  });

  it('does not let a paused older refresh overwrite a newer holder fence', async () => {
    const category = await CategoryModel.create({
      name: 'Refresh Target',
      slug: 'refresh-target',
      isActive: true,
      sortOrder: 0,
    });
    const repo = new PausingRefreshCategoryRepository();

    // Holder A owns the lock but is paused before refreshing category fences.
    const olderAcquisition = repo.acquireLock();
    await repo.refreshStarted.promise;

    const olderLock = await CategoryLockModel.findById(
      CATEGORY_LOCK_ID,
    ).exec();
    expect(olderLock?.fenceGeneration).toBeTypeOf('number');
    const olderGeneration = olderLock?.fenceGeneration as number;

    // Let the lock expire and let holder B acquire and install a newer fence.
    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    ).exec();
    const newerLease = await repo.acquireLock();
    expect(newerLease).not.toBeNull();
    expect(newerLease!.generation).toBeGreaterThan(olderGeneration);

    // A resumes after B's refresh. Its stale refresh must not overwrite B's
    // generation/token, and A must not receive a usable fence.
    repo.continueRefresh.resolve();
    const staleLease = await olderAcquisition;
    expect(staleLease).toBeNull();

    const updated = await repo.updateById(
      category._id.toString(),
      { name: 'Fresh B' },
      [],
      newerLease!,
    );
    expect(updated?.name).toBe('Fresh B');

    const stored = await CategoryModel.findById(category._id).exec();
    expect(stored?.mutationToken).toBe(newerLease!.token);
    expect(stored?.fenceGeneration).toBe(newerLease!.generation);

    await repo.releaseLock(newerLease!.token);
  });

  it('lets the newer holder win when the older refresh lands first', async () => {
    const category = await CategoryModel.create({
      name: 'Refresh Order Target',
      slug: 'refresh-order-target',
      isActive: true,
      sortOrder: 0,
    });
    const repo = new AfterRefreshPausingCategoryRepository();

    // Holder A (older) applies its refresh first, then pauses before ownership
    // revalidation so its fence is observable on the row.
    const olderAcquisition = repo.acquireLock();
    await repo.firstRefreshApplied.promise;

    const olderLock = await CategoryLockModel.findById(
      CATEGORY_LOCK_ID,
    ).exec();
    expect(olderLock?.fenceGeneration).toBeTypeOf('number');
    const olderGeneration = olderLock?.fenceGeneration as number;

    const afterOlderRefresh = await CategoryModel.findById(category._id).exec();
    expect(afterOlderRefresh?.mutationToken).toBe(olderLock?.token);
    expect(afterOlderRefresh?.fenceGeneration).toBe(olderGeneration);

    // Make the lock reclaimable and let holder B acquire. B refreshes second
    // and receives a usable lease while A is still paused.
    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    ).exec();
    const newerLease = await repo.acquireLock();
    expect(newerLease).not.toBeNull();
    expect(newerLease!.generation).toBeGreaterThan(olderGeneration);

    const afterNewerRefresh = await CategoryModel.findById(category._id).exec();
    expect(afterNewerRefresh?.mutationToken).toBe(newerLease!.token);
    expect(afterNewerRefresh?.fenceGeneration).toBe(newerLease!.generation);

    // A resumes, fails ownership revalidation and returns no fence. Its
    // token-scoped release must not clear B's newer fence.
    repo.continueFirstRefresh.resolve();
    const staleLease = await olderAcquisition;
    expect(staleLease).toBeNull();

    const afterStaleRelease = await CategoryModel.findById(category._id).exec();
    expect(afterStaleRelease?.mutationToken).toBe(newerLease!.token);
    expect(afterStaleRelease?.fenceGeneration).toBe(newerLease!.generation);

    const updated = await repo.updateById(
      category._id.toString(),
      { name: 'Newer Wins' },
      [],
      newerLease!,
    );
    expect(updated?.name).toBe('Newer Wins');

    // The stale older fence cannot write even though it refreshed first.
    const staleFence = await repo.updateById(
      category._id.toString(),
      { name: 'Older Loses' },
      [],
      {
        token: olderLock!.token!,
        generation: olderGeneration,
        expiresAt: olderLock!.expiresAt!,
      },
    );
    expect(staleFence).toBeNull();

    await repo.releaseLock(newerLease!.token);
  });

  it('rejects an update when the token matches but the database lease has expired', async () => {
    const repo = new CategoryRepository();
    const category = await CategoryModel.create({
      name: 'Expired Update Target',
      slug: 'expired-update-target',
      isActive: true,
      sortOrder: 0,
    });
    const lease = await repo.acquireLock();
    expect(lease).not.toBeNull();

    const fenced = await CategoryModel.findById(category._id).exec();
    expect(fenced?.mutationToken).toBe(lease!.token);
    expect(fenced?.fenceGeneration).toBe(lease!.generation);

    // The same token/generation works while the database lease is live.
    const liveUpdate = await repo.updateById(
      category._id.toString(),
      { sortOrder: 7 },
      [],
      lease!,
    );
    expect(liveUpdate?.sortOrder).toBe(7);

    // Only the database-time expiry changes. The write must now be rejected by
    // the expiry clause, not merely by token/generation replacement.
    await CategoryModel.updateOne(
      { _id: category._id },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
      { timestamps: false },
    ).exec();

    const updated = await repo.updateById(
      category._id.toString(),
      { name: 'Should Not Land' },
      [],
      lease!,
    );
    expect(updated).toBeNull();

    const stored = await CategoryModel.findById(category._id).exec();
    expect(stored?.name).toBe('Expired Update Target');

    await repo.releaseLock(lease!.token);
  });

  it('rejects a delete when the token matches but the database lease has expired', async () => {
    const repo = new CategoryRepository();
    const liveCategory = await CategoryModel.create({
      name: 'Live Delete Target',
      slug: 'live-delete-target',
      isActive: true,
      sortOrder: 0,
    });
    const category = await CategoryModel.create({
      name: 'Expired Delete Target',
      slug: 'expired-delete-target',
      isActive: true,
      sortOrder: 0,
    });
    const lease = await repo.acquireLock();
    expect(lease).not.toBeNull();

    const fenced = await CategoryModel.findById(category._id).exec();
    expect(fenced?.mutationToken).toBe(lease!.token);
    expect(fenced?.fenceGeneration).toBe(lease!.generation);

    // The same token/generation can delete while the database lease is live.
    expect(
      await repo.deleteById(liveCategory._id.toString(), lease!),
    ).toBe(true);

    // Only the database-time expiry changes. The delete must now be rejected.
    await CategoryModel.updateOne(
      { _id: category._id },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
      { timestamps: false },
    ).exec();

    const deleted = await repo.deleteById(category._id.toString(), lease!);
    expect(deleted).toBe(false);
    expect(await CategoryModel.findById(category._id).exec()).not.toBeNull();

    await repo.releaseLock(lease!.token);
  });

  it('cleans up staged rows left by a request that stopped before commit', async () => {
    const repo = new CategoryRepository();
    const staleLease = await repo.acquireLock();
    expect(staleLease).not.toBeNull();
    const staged = await repo.create(
      {
        name: 'Interrupted Staged',
        slug: 'interrupted-staged',
      },
      staleLease!,
    );

    // Simulate the process stopping and its lock/staged expiry passing.
    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    ).exec();
    await CategoryModel.updateOne(
      { _id: staged._id },
      { $set: { leaseExpiresAt: new Date(Date.now() - 1_000) } },
      { timestamps: false },
    ).exec();

    const freshLease = await repo.acquireLock();
    expect(freshLease).not.toBeNull();
    expect(await CategoryModel.findById(staged._id).exec()).toBeNull();

    await repo.releaseLock(freshLease!.token);
  });

  it('does not clean up a newer staged row while its lease is still valid', async () => {
    const repo = new CategoryRepository();
    const holder = await repo.acquireLock();
    expect(holder).not.toBeNull();
    const staged = await repo.create(
      {
        name: 'Live Newer Staged',
        slug: 'live-newer-staged',
      },
      holder!,
    );

    // Represent a newer holder whose staged row is still inside its valid
    // lease while the singleton becomes reclaimable.
    const liveExpiry = new Date(Date.now() + 60_000);
    await CategoryModel.updateOne(
      { _id: staged._id },
      {
        $set: {
          fenceGeneration: holder!.generation + 10,
          leaseExpiresAt: liveExpiry,
        },
      },
      { timestamps: false },
    ).exec();
    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    ).exec();

    // Acquisition runs expired-staging cleanup before it can be used.
    const freshLease = await repo.acquireLock();
    expect(freshLease).not.toBeNull();

    const stored = await CategoryModel.findById(staged._id).exec();
    expect(stored).not.toBeNull();
    expect(stored?.committed).toBe(false);
    expect(stored?.fenceGeneration).toBe(holder!.generation + 10);

    await repo.releaseLock(freshLease!.token);
    expect(await CategoryModel.findById(staged._id).exec()).not.toBeNull();
  });

  it('prevents an expired writer from changing a category after a newer writer takes over', async () => {
    const admin = await createSession('admin');
    const category = await createCategory(admin, { name: 'Fence Original' });
    const repo = new PausingCategoryRepository();
    const service = new CategoryService(repo);
    const requester: AuthUser = {
      id: admin.userId,
      email: 'fence-admin@test.com',
      role: 'admin',
      teacherStatus: 'none',
      isActive: true,
    };

    const staleUpdate = service.updateCategory({
      categoryId: category.id,
      requester,
      input: { name: 'Stale A' },
    });

    // A has validated the tree and is paused immediately before its fenced
    // write. Force the lease to be reclaimable, then let B run for real.
    await repo.staleWriteStarted.promise;
    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    ).exec();

    try {
      const fresh = await service.updateCategory({
        categoryId: category.id,
        requester,
        input: { name: 'Fresh B' },
      });
      expect(fresh.name).toBe('Fresh B');
    } finally {
      repo.continueStaleWrite.resolve();
    }

    const staleResult = await staleUpdate
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) {
      expect(staleResult.error).toMatchObject({
        statusCode: 409,
        code: CATEGORY_ERRORS.CATEGORY_BUSY,
      });
    }

    const stored = await CategoryModel.findById(category.id).exec();
    expect(stored?.name).toBe('Fresh B');
  });

  it('keeps creates from an expired lease staged and invisible', async () => {
    const repo = new CategoryRepository();
    const staleLease = await repo.acquireLock();
    expect(staleLease).not.toBeNull();

    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    ).exec();

    const newerLease = await repo.acquireLock();
    expect(newerLease).not.toBeNull();

    const staleFence: CategoryMutationFence = {
      token: staleLease!.token,
      generation: staleLease!.generation,
      expiresAt: new Date(Date.now() - 1_000),
    };
    const staged = await repo.create(
      {
        name: 'Stale Staged',
        slug: 'stale-staged',
      },
      staleFence,
    );
    const committed = await repo.commitCreated(
      staged._id.toString(),
      staleFence,
    );
    expect(committed).toBeNull();

    const visible = await repo.listAll();
    expect(visible.some((item) => item.slug === 'stale-staged')).toBe(false);

    await repo.deleteStaged(staged._id.toString());
    if (newerLease) {
      await repo.releaseLock(newerLease.token);
    }
    await repo.releaseLock(staleLease!.token);
  });

  it('does not hide an approved course by deactivating a branch', async () => {
    const admin = await createSession('admin');
    const root = await createCategory(admin, { name: 'Programming' });
    const child = await createCategory(admin, {
      name: 'Frontend',
      parentId: root.id,
    });

    await CourseModel.collection.insertOne({
      ownerId: new Types.ObjectId(admin.userId),
      title: 'Approved course',
      slug: `approved-${new Types.ObjectId().toString()}`,
      status: 'approved',
      categoryId: new Types.ObjectId(child.id),
      editLocked: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .patch(`/api/admin/categories/${root.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);
  });

  it('blocks hiding a branch with a published course by deactivation or a hidden-parent move', async () => {
    const admin = await createSession('admin');
    const visibleParent = await createCategory(admin, {
      name: 'Visible Parent',
    });
    const hiddenParent = await createCategory(admin, {
      name: 'Hidden Parent',
      isActive: false,
    });
    const branch = await createCategory(admin, {
      name: 'Published Branch',
      parentId: visibleParent.id,
    });
    const child = await createCategory(admin, {
      name: 'Published Child',
      parentId: branch.id,
    });

    await CourseModel.collection.insertOne({
      ownerId: new Types.ObjectId(admin.userId),
      title: 'Published course',
      slug: `published-${new Types.ObjectId().toString()}`,
      status: 'published',
      categoryId: new Types.ObjectId(child.id),
      editLocked: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const deactivate = await request(app)
      .patch(`/api/admin/categories/${branch.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ isActive: false });
    expect(deactivate.status).toBe(409);
    expect(deactivate.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);

    const hideByMove = await request(app)
      .patch(`/api/admin/categories/${branch.id}`)
      .set('Cookie', admin.cookies)
      .set('X-CSRF-Token', admin.csrf)
      .send({ parentId: hiddenParent.id });
    expect(hideByMove.status).toBe(409);
    expect(hideByMove.body.error.code).toBe(CATEGORY_ERRORS.CATEGORY_IN_USE);
  });

  it('is cycle-safe when corrupt data is inserted directly', async () => {
    const admin = await createSession('admin');
    const a = await createCategory(admin, { name: 'Corrupt A' });
    const b = await createCategory(admin, { name: 'Corrupt B' });

    await CategoryModel.updateOne(
      { _id: a.id },
      { $set: { parentId: new Types.ObjectId(b.id) } },
    ).exec();
    await CategoryModel.updateOne(
      { _id: b.id },
      { $set: { parentId: new Types.ObjectId(a.id) } },
    ).exec();

    const tree = await listPublic();
    expect(tree).toEqual([]);

    const adminList = await request(app)
      .get('/api/admin/categories')
      .set('Cookie', admin.cookies);
    expect(adminList.status).toBe(200);
    expect(adminList.body.data.categories).toHaveLength(2);
  });
});
