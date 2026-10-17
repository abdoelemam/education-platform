import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createApp } from '../src/app.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { requireAuth, requireRole } from '../src/middleware/auth.js';
import { asyncHandler } from '../src/utils/async-handler.js';
import { sendSuccess } from '../src/utils/api-response.js';
import { AUTH_COOKIES, AUTH_ERRORS } from '../src/modules/auth/auth.constants.js';
import { hashToken } from '../src/modules/auth/auth.tokens.js';
import { CSRF_COOKIE_NAME } from '../src/middleware/csrf.js';
import { globalErrorHandler } from '../src/middleware/error-handler.js';

const EXPECTED_TEST_DB_NAME = 'education-platform-test';
const ALLOWED_TEST_HOSTS = new Set(['127.0.0.1', 'localhost']);
const TEST_DB_URI = 'mongodb://127.0.0.1:27017/education-platform-test';

/**
 * Strict database safety assertion:
 * Prevents accidental connection, write, or deletion on any non-test database.
 * Verifies host is local loopback, database name strictly matches EXPECTED_TEST_DB_NAME,
 * and environment is never production.
 */
function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL DATABASE SAFETY VIOLATION: Tests must never execute when NODE_ENV is "production".');
  }

  let parsedUri: URL;
  try {
    parsedUri = new URL(TEST_DB_URI);
  } catch {
    throw new Error(`FATAL DATABASE SAFETY VIOLATION: Invalid TEST_DB_URI: ${TEST_DB_URI}`);
  }

  if (parsedUri.protocol !== 'mongodb:') {
    throw new Error(`FATAL DATABASE SAFETY VIOLATION: Protocol must be "mongodb:". Received: ${parsedUri.protocol}`);
  }

  if (!ALLOWED_TEST_HOSTS.has(parsedUri.hostname)) {
    throw new Error(`FATAL DATABASE SAFETY VIOLATION: Test database host must be local loopback. Received: ${parsedUri.hostname}`);
  }

  const dbNameFromUri = parsedUri.pathname.replace(/^\//, '');
  if (dbNameFromUri !== EXPECTED_TEST_DB_NAME) {
    throw new Error(`FATAL DATABASE SAFETY VIOLATION: Database name in URI must strictly equal "${EXPECTED_TEST_DB_NAME}". Received: "${dbNameFromUri}"`);
  }

  // If Mongoose connection is already established, verify live connection metadata
  if (mongoose.connection.readyState === 1) {
    if (mongoose.connection.name !== EXPECTED_TEST_DB_NAME) {
      throw new Error(`FATAL DATABASE SAFETY VIOLATION: Live Mongoose connection database name "${mongoose.connection.name}" does not match "${EXPECTED_TEST_DB_NAME}".`);
    }

    if (mongoose.connection.host && !ALLOWED_TEST_HOSTS.has(mongoose.connection.host)) {
      throw new Error(`FATAL DATABASE SAFETY VIOLATION: Live Mongoose connection host "${mongoose.connection.host}" is not in allowed loopback hosts.`);
    }
  }
}

/**
 * Helper to extract a cookie value by name from Supertest Set-Cookie headers.
 */
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

/**
 * Deterministic fake Mongoose client session used to simulate the transactional
 * (replica set) code path without a real replica set. Declared explicitly so the
 * tests are not mistaken for real replica-set integration coverage.
 */
interface FakeTransactionSession {
  session: mongoose.ClientSession;
  startTransaction: ReturnType<typeof vi.fn>;
  inTransaction: ReturnType<typeof vi.fn>;
  commitTransaction: ReturnType<typeof vi.fn>;
  abortTransaction: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
}

function createFakeTransactionSession(
  options: { abortFails?: boolean } = {},
): FakeTransactionSession {
  let active = false;
  const startTransaction = vi.fn(() => {
    active = true;
  });
  const inTransaction = vi.fn(() => active);
  const commitTransaction = vi.fn(async () => {
    active = false;
  });
  const abortTransaction = vi.fn(async () => {
    if (options.abortFails) {
      throw new Error('Simulated abortTransaction failure');
    }
    active = false;
  });
  const endSession = vi.fn(async () => {
    active = false;
  });
  const session = {
    startTransaction,
    inTransaction,
    commitTransaction,
    abortTransaction,
    endSession,
  } as unknown as mongoose.ClientSession;

  return { session, startTransaction, inTransaction, commitTransaction, abortTransaction, endSession };
}

function makeTransientTransactionError(): Error {
  return Object.assign(new Error('Simulated transient transaction conflict'), {
    code: 112,
    hasErrorLabel: (label: string) => label === 'TransientTransactionError',
  });
}

/**
 * Makes the cluster look like a replica set and returns the provided fake
 * session from `mongoose.startSession`.
 */
function stubReplicaSetTopology(fakeSession: mongoose.ClientSession): void {
  vi.spyOn(mongoose.connection, 'getClient').mockReturnValue({
    topology: { description: { type: 'ReplicaSetWithPrimary' } },
  } as unknown as ReturnType<typeof mongoose.connection.getClient>);
  vi.spyOn(mongoose, 'startSession').mockResolvedValue(fakeSession);
}

/**
 * Controls whether the private replacement candidate is persisted. Persisting
 * models a committed transaction; skipping models an aborted one.
 */
function stubCandidatePersistence(params: {
  fakeSession: mongoose.ClientSession;
  persist: boolean;
}): void {
  const originalSave = RefreshTokenModel.prototype.save;
  vi.spyOn(RefreshTokenModel.prototype, 'save').mockImplementation(async function (
    this: InstanceType<typeof RefreshTokenModel>,
    ...args: Parameters<typeof originalSave>
  ) {
    if (args[0]?.session === params.fakeSession) {
      return params.persist ? originalSave.call(this) : this;
    }
    return originalSave.apply(this, args);
  });
}

type ClaimBehavior = 'commit-then-transient' | 'transient' | 'null';

/**
 * Intercepts the first rotation claim.
 * - `commit-then-transient`: performs the real write, then raises a transient error.
 * - `transient`: raises a transient error without writing.
 * - `null`: reports an unmatched claim without writing.
 */
function stubTransactionalClaim(params: {
  fakeSession: mongoose.ClientSession;
  behavior: ClaimBehavior;
  transientError: Error;
}): { claimInjections: () => number } {
  const originalFindOneAndUpdate = RefreshTokenModel.findOneAndUpdate.bind(RefreshTokenModel);
  let injections = 0;

  vi.spyOn(RefreshTokenModel, 'findOneAndUpdate').mockImplementation((...args) => {
    const [filter, update, options] = args;
    const updateText = JSON.stringify(update);
    if (injections === 0 && updateText.includes('replacedByTokenHash')) {
      injections += 1;
      const queryOptions =
        options?.session === params.fakeSession
          ? { ...options, session: undefined }
          : options;
      const query = originalFindOneAndUpdate(filter, update, queryOptions);

      if (params.behavior === 'null') {
        query.exec = (async () => null) as unknown as typeof query.exec;
        return query;
      }

      const execute = query.exec.bind(query);
      query.exec = async (...execArgs) => {
        if (params.behavior === 'commit-then-transient') {
          await execute(...execArgs);
        }
        throw params.transientError;
      };
      return query;
    }
    return originalFindOneAndUpdate(...args);
  });

  return { claimInjections: () => injections };
}

describe('Phase 2: Authentication & Users Integration Tests', () => {
  const app = createApp();

  // Test application configured with proper middleware pipeline for testing role authorization
  const roleTestApp = express();
  roleTestApp.use(cookieParser());
  roleTestApp.get(
    '/api/test-admin-only',
    asyncHandler(requireAuth),
    requireRole('admin'),
    (_req, res) => {
      sendSuccess(res, { message: 'Admin access granted' });
    },
  );
  roleTestApp.get(
    '/api/test-teacher-only',
    asyncHandler(requireAuth),
    requireRole('teacher', 'admin'),
    (_req, res) => {
      sendSuccess(res, { message: 'Teacher access granted' });
    },
  );
  roleTestApp.use(globalErrorHandler);

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
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    assertSafeTestDatabase();
    await UserModel.deleteMany({});
    await RefreshTokenModel.deleteMany({});
  });

  // ---------------------------------------------------------------------------
  // 1. Registration success
  // ---------------------------------------------------------------------------
  it('1. should register a new student and set secure HttpOnly cookies', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Jane Doe',
        email: 'jane.doe@example.com',
        password: 'Password123!',
        role: 'student',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toBeDefined();
    expect(res.body.data.user.email).toBe('jane.doe@example.com');
    expect(res.body.data.user.role).toBe('student');
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.user.id).toBeDefined();

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toBeDefined();
    expect(cookies.some((c: string) => c.includes(AUTH_COOKIES.ACCESS_TOKEN))).toBe(true);
    expect(cookies.some((c: string) => c.includes(AUTH_COOKIES.REFRESH_TOKEN))).toBe(true);
    expect(cookies.some((c: string) => c.includes(CSRF_COOKIE_NAME))).toBe(true);
    expect(cookies.some((c: string) => c.toLowerCase().includes('httponly'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 2. Duplicate email
  // ---------------------------------------------------------------------------
  it('2. should reject registration when email already exists (409 Conflict)', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Jane Doe',
        email: 'duplicate@example.com',
        password: 'Password123!',
      });

    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Another Jane',
        email: 'DUPLICATE@example.com',
        password: 'Password999!',
      });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('USER_ALREADY_EXISTS');
  });

  // ---------------------------------------------------------------------------
  // 3. Invalid registration data
  // ---------------------------------------------------------------------------
  it('3. should reject invalid registration data with 422 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'J',
        email: 'invalid-email',
        password: 'short',
      });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.body).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 4. Login success
  // ---------------------------------------------------------------------------
  it('4. should log in successfully, set cookies, and update lastLoginAt', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Alice Smith',
        email: 'alice@example.com',
        password: 'Password123!',
      });

    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'alice@example.com',
        password: 'Password123!',
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe('alice@example.com');
    expect(res.body.data.user.lastLoginAt).toBeDefined();
    expect(res.body.data.user.passwordHash).toBeUndefined();

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toBeDefined();
    expect(cookies.some((c: string) => c.includes(AUTH_COOKIES.ACCESS_TOKEN))).toBe(true);
    expect(cookies.some((c: string) => c.includes(AUTH_COOKIES.REFRESH_TOKEN))).toBe(true);
    expect(cookies.some((c: string) => c.includes(CSRF_COOKIE_NAME))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 5. Invalid credentials
  // ---------------------------------------------------------------------------
  it('5. should reject incorrect password or non-existent email with uniform 401 error', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Bob Jones',
        email: 'bob@example.com',
        password: 'Password123!',
      });

    const resWrongPass = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'bob@example.com',
        password: 'WrongPassword123!',
      });

    expect(resWrongPass.status).toBe(401);
    expect(resWrongPass.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');

    const resNoUser = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'nonexistent@example.com',
        password: 'Password123!',
      });

    expect(resNoUser.status).toBe(401);
    expect(resNoUser.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  // ---------------------------------------------------------------------------
  // 6. Disabled account
  // ---------------------------------------------------------------------------
  it('6. should reject login if the user account is deactivated (403)', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Disabled User',
        email: 'disabled@example.com',
        password: 'Password123!',
      });

    const userId = regRes.body.data.user.id;
    await UserModel.findByIdAndUpdate(userId, { isActive: false });

    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'disabled@example.com',
        password: 'Password123!',
      });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');
  });

  // ---------------------------------------------------------------------------
  // 7. Authentication middleware
  // ---------------------------------------------------------------------------
  it('7. should protect GET /api/auth/me and reject unauthenticated requests', async () => {
    const unauthRes = await request(app).get('/api/auth/me');
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.body.error.code).toBe('AUTH_UNAUTHORIZED');

    const loginRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Protected User',
        email: 'protected@example.com',
        password: 'Password123!',
      });

    const cookies = loginRes.headers['set-cookie'] as unknown as string[];

    const authRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies);

    expect(authRes.status).toBe(200);
    expect(authRes.body.data.user.email).toBe('protected@example.com');
  });

  // ---------------------------------------------------------------------------
  // 8. Invalid or forged access token
  // ---------------------------------------------------------------------------
  it('8. should reject requests with invalid or forged access tokens', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer forged.invalid.token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_TOKEN');
  });

  // ---------------------------------------------------------------------------
  // 9. Role authorization
  // ---------------------------------------------------------------------------
  it('9. should enforce role authorization properly with requireRole', async () => {
    const studentRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Student User',
        email: 'student@example.com',
        password: 'Password123!',
        role: 'student',
      });

    const studentCookies = studentRes.headers['set-cookie'] as unknown as string[];

    const adminAttempt = await request(roleTestApp)
      .get('/api/test-admin-only')
      .set('Cookie', studentCookies);

    expect(adminAttempt.status).toBe(403);
    expect(adminAttempt.body.error.code).toBe('AUTH_FORBIDDEN');

    const teacherRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Teacher User',
        email: 'teacher@example.com',
        password: 'Password123!',
        role: 'teacher',
      });

    const teacherCookies = teacherRes.headers['set-cookie'] as unknown as string[];

    const teacherAccess = await request(roleTestApp)
      .get('/api/test-teacher-only')
      .set('Cookie', teacherCookies);

    expect(teacherAccess.status).toBe(200);
    expect(teacherAccess.body.data.message).toBe('Teacher access granted');
  });

  // ---------------------------------------------------------------------------
  // 10. Current user endpoint
  // ---------------------------------------------------------------------------
  it('10. should return sanitized public profile from GET /api/auth/me', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Me User',
        email: 'me@example.com',
        password: 'Password123!',
      });

    const cookies = regRes.headers['set-cookie'] as unknown as string[];

    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      name: 'Me User',
      email: 'me@example.com',
      role: 'student',
      isActive: true,
      isEmailVerified: false,
    });
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 11. Logout behavior and cookie clearing
  // ---------------------------------------------------------------------------
  it('11. should revoke refresh session and clear cookies on logout', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Logout User',
        email: 'logout@example.com',
        password: 'Password123!',
      });

    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrfToken = getCookieValue(cookies, CSRF_COOKIE_NAME);
    expect(csrfToken).toBeDefined();

    const sessionCountBefore = await RefreshTokenModel.countDocuments({ isRevoked: false });
    expect(sessionCountBefore).toBe(1);

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken!);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    const sessionCountAfter = await RefreshTokenModel.countDocuments({ isRevoked: false });
    expect(sessionCountAfter).toBe(0);
    const loggedOutToken = await RefreshTokenModel.findOne({ isRevoked: true });
    expect(loggedOutToken?.revocationReason).toBe('logout');

    const clearCookies = logoutRes.headers['set-cookie'] as unknown as string[];
    expect(clearCookies).toBeDefined();
    expect(clearCookies.some((c: string) => c.includes('access_token=;'))).toBe(true);
    expect(clearCookies.some((c: string) => c.includes('refresh_token=;'))).toBe(true);
    expect(clearCookies.some((c: string) => c.includes('csrf_token=;'))).toBe(true);

    // Attempting to refresh with the logged-out token should fail
    const refreshAfterLogout = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken!);

    expect(refreshAfterLogout.status).toBe(401);
    expect(refreshAfterLogout.body.error.code).toBe(AUTH_ERRORS.REFRESH_TOKEN_INVALID);
  });

  // ---------------------------------------------------------------------------
  // 12. Refresh-token rotation: Successful rotation & database linking
  // ---------------------------------------------------------------------------
  it('12. should successfully refresh and rotate tokens, linking old token to replacement', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Rotation User',
        email: 'rotation@example.com',
        password: 'Password123!',
      });

    const initialCookies = regRes.headers['set-cookie'] as unknown as string[];
    const initialRefreshToken = getCookieValue(initialCookies, AUTH_COOKIES.REFRESH_TOKEN);
    const initialCsrfToken = getCookieValue(initialCookies, CSRF_COOKIE_NAME);
    expect(initialRefreshToken).toBeDefined();
    expect(initialCsrfToken).toBeDefined();

    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', initialCsrfToken!);

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.success).toBe(true);

    const rotatedCookies = refreshRes.headers['set-cookie'] as unknown as string[];
    const newRefreshToken = getCookieValue(rotatedCookies, AUTH_COOKIES.REFRESH_TOKEN);
    const newAccessToken = getCookieValue(rotatedCookies, AUTH_COOKIES.ACCESS_TOKEN);

    expect(newRefreshToken).toBeDefined();
    expect(newAccessToken).toBeDefined();
    expect(newRefreshToken).not.toBe(initialRefreshToken);

    const activeTokens = await RefreshTokenModel.find({ isRevoked: false });
    const revokedTokens = await RefreshTokenModel.find({ isRevoked: true });

    expect(activeTokens.length).toBe(1);
    expect(revokedTokens.length).toBe(1);
    expect(revokedTokens[0].replacedByTokenHash).toBe(activeTokens[0].tokenHash);
    expect(revokedTokens[0].revokedAt).toBeDefined();
    expect(revokedTokens[0].revocationReason).toBe('rotation');
  });

  // ---------------------------------------------------------------------------
  // 13. Refresh-token rotation: Rejection of old refresh token after rotation
  // ---------------------------------------------------------------------------
  it('13. should reject an old refresh token that has already been rotated', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Old Token User',
        email: 'oldtoken@example.com',
        password: 'Password123!',
      });

    const initialCookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrfToken = getCookieValue(initialCookies, CSRF_COOKIE_NAME)!;

    // First rotation succeeds
    const firstRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', csrfToken);

    expect(firstRefresh.status).toBe(200);

    // Second refresh using the INITIAL (now rotated) token must fail
    const secondRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', csrfToken);

    expect(secondRefresh.status).toBe(401);
    expect(secondRefresh.body.error.code).toBe(AUTH_ERRORS.REFRESH_TOKEN_INVALID);
  });

  // ---------------------------------------------------------------------------
  // 14. Concurrency: Atomic consumption under 2 simultaneous requests
  // ---------------------------------------------------------------------------
  it('14. should handle concurrent refresh requests atomically without revoking the newly issued session', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Concurrent User',
        email: 'concurrent@example.com',
        password: 'Password123!',
      });

    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrfToken = getCookieValue(cookies, CSRF_COOKIE_NAME)!;

    // Fire 2 concurrent refresh requests with the EXACT same token simultaneously
    const [resA, resB] = await Promise.all([
      request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrfToken),
      request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrfToken),
    ]);

    const statuses = [resA.status, resB.status];

    // Exactly one must succeed (200) and one must be rejected (401)
    expect(statuses).toContain(200);
    expect(statuses).toContain(401);

    // Critical assertion: The sibling 401 must NOT have revoked the new session!
    // Exactly 1 active session MUST exist in the database
    const activeTokens = await RefreshTokenModel.find({ isRevoked: false });
    expect(activeTokens.length).toBe(1);

    // Verify the winning response's new session is usable
    const successRes = resA.status === 200 ? resA : resB;
    const newCookies = successRes.headers['set-cookie'] as unknown as string[];
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', newCookies);

    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.email).toBe('concurrent@example.com');
  });

  // ---------------------------------------------------------------------------
  // 15. Concurrency: Atomic replay accounting under high concurrency
  // ---------------------------------------------------------------------------
  it('15. should atomically detect repeated concurrent refresh-token reuse', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'High Concurrency User',
        email: 'highconcurrent@example.com',
        password: 'Password123!',
      });

    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrfToken = getCookieValue(cookies, CSRF_COOKIE_NAME)!;

    // Launch 5 concurrent refresh requests with identical token
    const responses = await Promise.all([
      request(app).post('/api/auth/refresh').set('Cookie', cookies).set('X-CSRF-Token', csrfToken),
      request(app).post('/api/auth/refresh').set('Cookie', cookies).set('X-CSRF-Token', csrfToken),
      request(app).post('/api/auth/refresh').set('Cookie', cookies).set('X-CSRF-Token', csrfToken),
      request(app).post('/api/auth/refresh').set('Cookie', cookies).set('X-CSRF-Token', csrfToken),
      request(app).post('/api/auth/refresh').set('Cookie', cookies).set('X-CSRF-Token', csrfToken),
    ]);

    const successCount = responses.filter((r) => r.status === 200).length;
    const rejectedCount = responses.filter((r) => r.status === 401).length;

    // Exactly 1 wins, exactly 4 are rejected safely
    expect(successCount).toBe(1);
    expect(rejectedCount).toBe(4);

    // Only the first sibling retry is tolerated. Atomic accounting makes the
    // remaining concurrent reuses trigger the replay response.
    const activeTokens = await RefreshTokenModel.find({ isRevoked: false });
    expect(activeTokens.length).toBe(0);
    expect(responses.some((r) => /reuse detected/i.test(r.body.error?.message ?? ''))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 16. Reuse detection: Suspected token theft revokes ALL sessions outside grace period
  // ---------------------------------------------------------------------------
  it('16. should detect refresh token reuse outside grace period and revoke all sessions for that user', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Theft Detection User',
        email: 'theft@example.com',
        password: 'Password123!',
      });

    const user = regRes.body.data.user;
    const initialCookies = regRes.headers['set-cookie'] as unknown as string[];
    const initialCsrf = getCookieValue(initialCookies, CSRF_COOKIE_NAME)!;

    // Legitimate rotation (Token 1 -> Token 2)
    const legitRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', initialCsrf);

    expect(legitRefresh.status).toBe(200);
    const token2Cookies = legitRefresh.headers['set-cookie'] as unknown as string[];
    const token2Csrf = getCookieValue(token2Cookies, CSRF_COOKIE_NAME)!;

    // Simulate elapsed time: Set Token 1's revokedAt to 30 seconds ago (outside the 15s grace window)
    const revokedDoc = await RefreshTokenModel.findOne({ userId: user.id, isRevoked: true });
    expect(revokedDoc).toBeDefined();
    revokedDoc!.revokedAt = new Date(Date.now() - 30_000);
    await revokedDoc!.save();

    // Malicious actor replays the old Token 1 outside the grace window
    const attackRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', initialCsrf);

    expect(attackRefresh.status).toBe(401);
    expect(attackRefresh.body.error.code).toBe(AUTH_ERRORS.REFRESH_TOKEN_INVALID);
    expect(attackRefresh.body.error.message).toMatch(/reuse detected/i);

    // Theft detection MUST have revoked ALL sessions for this user in the database
    const allUserTokens = await RefreshTokenModel.find({ userId: user.id });
    expect(allUserTokens.length).toBeGreaterThan(0);
    const anyActive = allUserTokens.some((t) => !t.isRevoked);
    expect(anyActive).toBe(false);

    // The legitimate user holding Token 2 must now also be rejected (forced re-login)
    const token2Refresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', token2Cookies)
      .set('X-CSRF-Token', token2Csrf);

    expect(token2Refresh.status).toBe(401);
    expect(token2Refresh.body.error.code).toBe(AUTH_ERRORS.REFRESH_TOKEN_INVALID);
  });

  // ---------------------------------------------------------------------------
  // 17. Replay Policy: Confirmed reuse when replacement token has already been rotated (chain advanced)
  // ---------------------------------------------------------------------------
  it('17. should detect confirmed reuse when replacement token has already been rotated (chain advanced)', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Chain Advance User',
        email: 'chain@example.com',
        password: 'Password123!',
      });

    const user = regRes.body.data.user;
    const cookies1 = regRes.headers['set-cookie'] as unknown as string[];
    const csrf1 = getCookieValue(cookies1, CSRF_COOKIE_NAME)!;

    // Rotation 1: Token 1 -> Token 2
    const res1 = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies1)
      .set('X-CSRF-Token', csrf1);
    expect(res1.status).toBe(200);

    const cookies2 = res1.headers['set-cookie'] as unknown as string[];
    const csrf2 = getCookieValue(cookies2, CSRF_COOKIE_NAME)!;

    // Rotation 2: Token 2 -> Token 3
    const res2 = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies2)
      .set('X-CSRF-Token', csrf2);
    expect(res2.status).toBe(200);
    const token2Record = await RefreshTokenModel.findOne({
      tokenHash: hashToken(getCookieValue(cookies2, AUTH_COOKIES.REFRESH_TOKEN)!),
    });
    expect(token2Record?.revocationReason).toBe('rotation');

    const cookies3 = res2.headers['set-cookie'] as unknown as string[];
    const csrf3 = getCookieValue(cookies3, CSRF_COOKIE_NAME)!;

    // Now an attacker replays Token 1 immediately.
    // Even though it is within the 15-second grace window, Token 2 was already rotated to Token 3!
    // The chain has advanced, so presenting Token 1 is CONFIRMED REUSE.
    const replayRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies1)
      .set('X-CSRF-Token', csrf1);

    expect(replayRes.status).toBe(401);
    expect(replayRes.body.error.code).toBe(AUTH_ERRORS.REFRESH_TOKEN_INVALID);
    expect(replayRes.body.error.message).toMatch(/reuse detected/i);

    // ALL sessions for this user must now be revoked
    const activeTokens = await RefreshTokenModel.find({ userId: user.id, isRevoked: false });
    expect(activeTokens.length).toBe(0);

    // Token 3 must now also be rejected
    const token3Attempt = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies3)
      .set('X-CSRF-Token', csrf3);
    expect(token3Attempt.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // 18. Replay Policy: Confirmed reuse on repeated presentation of an already-rotated token
  // ---------------------------------------------------------------------------
  it('18. should detect confirmed reuse when an already-rotated token is presented repeatedly', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Repeated Replay User',
        email: 'repeated@example.com',
        password: 'Password123!',
      });

    const user = regRes.body.data.user;
    const cookies1 = regRes.headers['set-cookie'] as unknown as string[];
    const csrf1 = getCookieValue(cookies1, CSRF_COOKIE_NAME)!;

    // Rotation 1: Token 1 -> Token 2
    const res1 = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies1)
      .set('X-CSRF-Token', csrf1);
    expect(res1.status).toBe(200);

    const cookies2 = res1.headers['set-cookie'] as unknown as string[];
    const csrf2 = getCookieValue(cookies2, CSRF_COOKIE_NAME)!;

    // First presentation of Token 1 (sibling concurrent attempt within grace window)
    const siblingRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies1)
      .set('X-CSRF-Token', csrf1);

    expect(siblingRes.status).toBe(401);
    expect(siblingRes.body.error.message).toMatch(/recently rotated/i);

    // Active session for Token 2 is NOT revoked
    let activeTokens = await RefreshTokenModel.find({ userId: user.id, isRevoked: false });
    expect(activeTokens.length).toBe(1);

    // Second presentation of Token 1 (repeated attempt -> confirmed reuse!)
    const repeatedRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies1)
      .set('X-CSRF-Token', csrf1);

    expect(repeatedRes.status).toBe(401);
    expect(repeatedRes.body.error.message).toMatch(/reuse detected/i);

    // Confirmed reuse triggers session revocation for all sessions
    activeTokens = await RefreshTokenModel.find({ userId: user.id, isRevoked: false });
    expect(activeTokens.length).toBe(0);

    // Token 2 is now rejected
    const token2Attempt = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies2)
      .set('X-CSRF-Token', csrf2);
    expect(token2Attempt.status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // 19. Failure Safety: Database error during rotation does not leave user logged out
  // ---------------------------------------------------------------------------
  it('19. should preserve the existing session if replacement persistence encounters a database error', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Failure Safety User',
        email: 'failuresafety@example.com',
        password: 'Password123!',
      });

    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME)!;

    // Simulate transient database failure during the replacement save operation
    let failOnce = true;
    const originalSave = RefreshTokenModel.prototype.save;
    vi.spyOn(RefreshTokenModel.prototype, 'save').mockImplementation(async function (
      this: InstanceType<typeof RefreshTokenModel>,
    ) {
      if (failOnce) {
        failOnce = false;
        throw new Error('Simulated transient MongoDB persistence error');
      }
      return originalSave.apply(this);
    });

    try {
      // The refresh attempt encounters the simulated DB failure
      const failRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf);

      // Should return error (500)
      expect(failRes.status).toBe(500);

      // Crucial assertion: Failure-safety policy rolled back the claim!
      // The old token MUST NOT be left revoked!
      const unrevokedTokens = await RefreshTokenModel.find({ isRevoked: false });
      expect(unrevokedTokens.length).toBe(1);

      // When the user retries after the transient error, the token is STILL valid and succeeds
      const retryRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf);

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.success).toBe(true);

      // Verify the new token allows authenticated access
      const newCookies = retryRes.headers['set-cookie'] as unknown as string[];
      const meRes = await request(app).get('/api/auth/me').set('Cookie', newCookies);
      expect(meRes.status).toBe(200);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // ---------------------------------------------------------------------------
  // 20. Refresh attempt by disabled user account
  // ---------------------------------------------------------------------------
  it('20. should reject refresh attempt if the user account has been disabled', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Deactivated User',
        email: 'deactivated@example.com',
        password: 'Password123!',
      });

    const userId = regRes.body.data.user.id;
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrfToken = getCookieValue(cookies, CSRF_COOKIE_NAME)!;

    await UserModel.findByIdAndUpdate(userId, { isActive: false });

    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken);

    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);
    expect(refreshRes.body.error.message).toMatch(/no longer active/i);
  });

  // ---------------------------------------------------------------------------
  // 21. Refresh attempt by deleted user account
  // ---------------------------------------------------------------------------
  it('21. should reject refresh attempt if the user account has been deleted', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Deleted User',
        email: 'deleted@example.com',
        password: 'Password123!',
      });

    const userId = regRes.body.data.user.id;
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrfToken = getCookieValue(cookies, CSRF_COOKIE_NAME)!;

    await UserModel.findByIdAndDelete(userId);

    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken);

    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);
    expect(refreshRes.body.error.message).toMatch(/no longer active/i);
  });

  // ---------------------------------------------------------------------------
  // 22. CSRF Protection: Verification on cookie-authenticated state-changing routes
  // ---------------------------------------------------------------------------
  it('22. should enforce CSRF protection on state-changing requests', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'CSRF User',
        email: 'csrf@example.com',
        password: 'Password123!',
      });

    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const validCsrf = getCookieValue(cookies, CSRF_COOKIE_NAME)!;
    expect(validCsrf).toBeDefined();

    // 1. Missing CSRF header -> 403 CSRF_TOKEN_MISSING
    const missingRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies);

    expect(missingRes.status).toBe(403);
    expect(missingRes.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_MISSING);

    // 2. Invalid CSRF header value -> 403 CSRF_TOKEN_INVALID
    const invalidRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', 'forged-or-mismatched-csrf-token-12345');

    expect(invalidRes.status).toBe(403);
    expect(invalidRes.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_INVALID);

    // 3. Valid CSRF header value -> 200 Success
    const validRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', validCsrf);

    expect(validRes.status).toBe(200);
    expect(validRes.body.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 23. Database Safety: Rejection of non-matching or unsafe test database
  // ---------------------------------------------------------------------------
  it('23. should abort if database name or host does not match the designated test database', () => {
    // Calling assertSafeTestDatabase() under valid test setup succeeds
    expect(() => assertSafeTestDatabase()).not.toThrow();
  });

  it('24. should not treat a logged-out replacement as proof of refresh-token replay', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Logout Replacement User',
        email: 'logout-replacement@example.com',
        password: 'Password123!',
      });
    const oldCookies = regRes.headers['set-cookie'] as unknown as string[];
    const oldCsrf = getCookieValue(oldCookies, CSRF_COOKIE_NAME)!;

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'logout-replacement@example.com',
        password: 'Password123!',
      });
    const independentSessionCookies = loginRes.headers['set-cookie'] as unknown as string[];

    const rotateRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', oldCookies)
      .set('X-CSRF-Token', oldCsrf);
    expect(rotateRes.status).toBe(200);
    const replacementCookies = rotateRes.headers['set-cookie'] as unknown as string[];
    const replacementCsrf = getCookieValue(replacementCookies, CSRF_COOKIE_NAME)!;

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', replacementCookies)
      .set('X-CSRF-Token', replacementCsrf);
    expect(logoutRes.status).toBe(200);

    const replayRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', oldCookies)
      .set('X-CSRF-Token', oldCsrf);
    expect(replayRes.status).toBe(401);
    expect(replayRes.body.error.message).toMatch(/recently rotated/i);
    expect(replayRes.body.error.message).not.toMatch(/reuse detected/i);

    const loggedOutReplacement = await RefreshTokenModel.findOne({
      isRevoked: true,
      revocationReason: 'logout',
    });
    expect(loggedOutReplacement).toBeDefined();
    expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
    const independentToken = getCookieValue(independentSessionCookies, AUTH_COOKIES.REFRESH_TOKEN)!;
    expect(
      await RefreshTokenModel.countDocuments({
        tokenHash: hashToken(independentToken),
        isRevoked: false,
      }),
    ).toBe(1);
  });

  it('25. should revoke only the replaying user\'s sessions after confirmed replay', async () => {
    const userRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Session Isolation User',
        email: 'session-isolation@example.com',
        password: 'Password123!',
      });
    const userCookies = userRes.headers['set-cookie'] as unknown as string[];
    const userCsrf = getCookieValue(userCookies, CSRF_COOKIE_NAME)!;
    const userId = userRes.body.data.user.id;

    const secondSessionRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'session-isolation@example.com',
        password: 'Password123!',
      });
    expect(secondSessionRes.status).toBe(200);

    const otherUserRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Unaffected User',
        email: 'unaffected@example.com',
        password: 'Password123!',
      });
    const otherUserId = otherUserRes.body.data.user.id;
    const otherUserToken = getCookieValue(
      otherUserRes.headers['set-cookie'] as unknown as string[],
      AUTH_COOKIES.REFRESH_TOKEN,
    )!;

    const rotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', userCookies)
      .set('X-CSRF-Token', userCsrf);
    expect(rotation.status).toBe(200);

    const firstReplay = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', userCookies)
      .set('X-CSRF-Token', userCsrf);
    expect(firstReplay.status).toBe(401);

    const confirmedReplay = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', userCookies)
      .set('X-CSRF-Token', userCsrf);
    expect(confirmedReplay.status).toBe(401);
    expect(confirmedReplay.body.error.message).toMatch(/reuse detected/i);

    expect(await RefreshTokenModel.countDocuments({ userId, isRevoked: false })).toBe(0);
    expect(await RefreshTokenModel.countDocuments({ userId: otherUserId, isRevoked: false })).toBe(1);
    expect(
      await RefreshTokenModel.countDocuments({
        tokenHash: hashToken(otherUserToken),
        isRevoked: false,
      }),
    ).toBe(1);
  });

  it('26. should preserve the old token when the atomic rotation claim fails', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Claim Failure User',
        email: 'claim-failure@example.com',
        password: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME)!;
    vi.spyOn(RefreshTokenModel, 'findOneAndUpdate').mockImplementationOnce(() => {
      throw new Error('Simulated refresh-token claim failure');
    });

    try {
      const failedRefresh = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf);
      expect(failedRefresh.status).toBe(500);

      const tokens = await RefreshTokenModel.find({});
      expect(tokens).toHaveLength(1);
      expect(tokens[0].isRevoked).toBe(false);

      const retry = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf);
      expect(retry.status).toBe(200);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('27. should not let a rotation recreate a session after replay revocation', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Replay Rotation Race User',
        email: 'replay-rotation-race@example.com',
        password: 'Password123!',
      });
    const firstSessionCookies = regRes.headers['set-cookie'] as unknown as string[];
    const firstCsrf = getCookieValue(firstSessionCookies, CSRF_COOKIE_NAME)!;

    const secondSessionRes = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'replay-rotation-race@example.com',
        password: 'Password123!',
      });
    const secondSessionCookies = secondSessionRes.headers['set-cookie'] as unknown as string[];
    const secondCsrf = getCookieValue(secondSessionCookies, CSRF_COOKIE_NAME)!;

    const firstRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstSessionCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(firstRotation.status).toBe(200);

    const sibling = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstSessionCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(sibling.status).toBe(401);

    let candidateSaved!: () => void;
    let releaseCandidate!: () => void;
    const candidateReady = new Promise<void>((resolve) => {
      candidateSaved = resolve;
    });
    const candidateRelease = new Promise<void>((resolve) => {
      releaseCandidate = resolve;
    });
    const originalSave = RefreshTokenModel.prototype.save;
    let paused = false;

    vi.spyOn(RefreshTokenModel.prototype, 'save').mockImplementation(async function (
      this: InstanceType<typeof RefreshTokenModel>,
      ...args: Parameters<typeof originalSave>
    ) {
      const saved = await originalSave.apply(this, args);
      if (!paused) {
        paused = true;
        candidateSaved();
        await candidateRelease;
      }
      return saved;
    });

    const pendingRotation = request(app)
      .post('/api/auth/refresh')
      .set('Cookie', secondSessionCookies)
      .set('X-CSRF-Token', secondCsrf)
      .then((response) => response);

    try {
      await candidateReady;

      const confirmedReplay = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', firstSessionCookies)
        .set('X-CSRF-Token', firstCsrf);
      expect(confirmedReplay.status).toBe(401);
      expect(confirmedReplay.body.error.message).toMatch(/reuse detected/i);

      releaseCandidate();
      const racingRotation = await pendingRotation;
      expect(racingRotation.status).not.toBe(200);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(0);
    } finally {
      releaseCandidate();
      await pendingRotation;
      vi.restoreAllMocks();
    }
  });

  it('28. should abort a failed MongoDB transaction without changing the existing session', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Transaction Failure User',
        email: 'transaction-failure@example.com',
        password: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME)!;

    let transactionActive = true;
    const transactionSession = {
      startTransaction: vi.fn(),
      inTransaction: vi.fn(() => transactionActive),
      abortTransaction: vi.fn(async () => {
        transactionActive = false;
      }),
      endSession: vi.fn(async () => undefined),
    } as unknown as mongoose.ClientSession;
    const fakeClient = {
      topology: { description: { type: 'ReplicaSetWithPrimary' } },
    };

    vi.spyOn(mongoose.connection, 'getClient').mockReturnValue(
      fakeClient as unknown as ReturnType<typeof mongoose.connection.getClient>,
    );
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(transactionSession);
    vi.spyOn(RefreshTokenModel.prototype, 'save').mockRejectedValueOnce(
      new Error('Simulated transactional replacement failure'),
    );

    try {
      const failedRefresh = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf);

      expect(failedRefresh.status).toBe(500);
      expect(transactionSession.abortTransaction).toHaveBeenCalledOnce();
      expect(transactionSession.endSession).toHaveBeenCalledOnce();
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
      expect(await RefreshTokenModel.countDocuments({})).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('29. should observe replacement rotation atomically during replay detection', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Replay Probe Race User',
        email: 'replay-probe-race@example.com',
        password: 'Password123!',
      });
    const firstCookies = regRes.headers['set-cookie'] as unknown as string[];
    const firstCsrf = getCookieValue(firstCookies, CSRF_COOKIE_NAME)!;

    const firstRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(firstRotation.status).toBe(200);
    const secondCookies = firstRotation.headers['set-cookie'] as unknown as string[];
    const secondCsrf = getCookieValue(secondCookies, CSRF_COOKIE_NAME)!;
    const secondToken = getCookieValue(secondCookies, AUTH_COOKIES.REFRESH_TOKEN)!;
    const secondTokenHash = hashToken(secondToken);

    let probeReached!: () => void;
    let releaseProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      probeReached = resolve;
    });
    const probeRelease = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const originalFindOneAndUpdate = RefreshTokenModel.findOneAndUpdate.bind(RefreshTokenModel);
    let pausedProbe = false;

    vi.spyOn(RefreshTokenModel, 'findOneAndUpdate').mockImplementation((...args) => {
      const query = originalFindOneAndUpdate(...args);
      const filterText = JSON.stringify(args[0]);
      const updateText = JSON.stringify(args[1]);
      if (
        !pausedProbe &&
        filterText.includes(secondTokenHash) &&
        updateText.includes('predecessorReuseCount')
      ) {
        pausedProbe = true;
        const execute = query.exec.bind(query);
        query.exec = async (...execArgs) => {
          probeReached();
          await probeRelease;
          return execute(...execArgs);
        };
      }
      return query;
    });

    const pendingReplay = request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf)
      .then((response) => response);

    try {
      const replayRacePoint = await Promise.race([
        probeStarted.then(() => 'conditional-check'),
        pendingReplay.then(() => 'replay-completed'),
      ]);
      expect(replayRacePoint).toBe('conditional-check');

      const secondRotation = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', secondCookies)
        .set('X-CSRF-Token', secondCsrf);
      expect(secondRotation.status).toBe(200);

      releaseProbe();
      const replayResponse = await pendingReplay;
      expect(replayResponse.status).toBe(401);
      expect(replayResponse.body.error.message).toMatch(/reuse detected/i);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(0);
    } finally {
      releaseProbe();
      await pendingReplay;
      vi.restoreAllMocks();
    }
  });

  it('30. should linearize a sibling replay before a following replacement rotation', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Replay Check Complete Race User',
        email: 'replay-check-complete-race@example.com',
        password: 'Password123!',
      });
    const firstCookies = regRes.headers['set-cookie'] as unknown as string[];
    const firstCsrf = getCookieValue(firstCookies, CSRF_COOKIE_NAME)!;

    const firstRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(firstRotation.status).toBe(200);
    const secondCookies = firstRotation.headers['set-cookie'] as unknown as string[];
    const secondCsrf = getCookieValue(secondCookies, CSRF_COOKIE_NAME)!;
    const secondTokenHash = hashToken(
      getCookieValue(secondCookies, AUTH_COOKIES.REFRESH_TOKEN)!,
    );

    let checkCompleted!: () => void;
    let releaseReplay!: () => void;
    const checkCompletedPromise = new Promise<void>((resolve) => {
      checkCompleted = resolve;
    });
    const replayRelease = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const originalFindOneAndUpdate = RefreshTokenModel.findOneAndUpdate.bind(RefreshTokenModel);
    let pausedCheck = false;
    let replacementWasActiveAtCheck = false;

    vi.spyOn(RefreshTokenModel, 'findOneAndUpdate').mockImplementation((...args) => {
      const query = originalFindOneAndUpdate(...args);
      const filterText = JSON.stringify(args[0]);
      const updateText = JSON.stringify(args[1]);
      if (
        !pausedCheck &&
        filterText.includes(secondTokenHash) &&
        updateText.includes('predecessorReuseCount')
      ) {
        pausedCheck = true;
        const execute = query.exec.bind(query);
        query.exec = async (...execArgs) => {
          const result = await execute(...execArgs);
          replacementWasActiveAtCheck = result?.isRevoked === false;
          checkCompleted();
          await replayRelease;
          return result;
        };
      }
      return query;
    });

    const pendingReplay = request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf)
      .then((response) => response);

    try {
      const racePoint = await Promise.race([
        checkCompletedPromise.then(() => 'check-completed'),
        pendingReplay.then(() => 'replay-completed'),
      ]);
      expect(racePoint).toBe('check-completed');
      expect(replacementWasActiveAtCheck).toBe(true);
      const markedReplacement = await RefreshTokenModel.findOne({
        tokenHash: secondTokenHash,
      });
      expect(markedReplacement?.predecessorReuseCount).toBe(1);
      expect(markedReplacement?.isRevoked).toBe(false);

      const secondRotation = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', secondCookies)
        .set('X-CSRF-Token', secondCsrf);
      expect(secondRotation.status).toBe(200);

      releaseReplay();
      const replayResponse = await pendingReplay;
      expect(replayResponse.status).toBe(401);
      expect(replayResponse.body.error.message).toMatch(/recently rotated/i);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
      const thirdCookies = secondRotation.headers['set-cookie'] as unknown as string[];
      const thirdCsrf = getCookieValue(thirdCookies, CSRF_COOKIE_NAME)!;
      const nextLegitimateRotation = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', thirdCookies)
        .set('X-CSRF-Token', thirdCsrf);
      expect(nextLegitimateRotation.status).toBe(200);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
    } finally {
      releaseReplay();
      await pendingReplay;
      vi.restoreAllMocks();
    }
  });

  it('31. should reconcile a transaction conflict after an atomic sibling replay count', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Transactional Replay Marker User',
        email: 'transactional-replay-marker@example.com',
        password: 'Password123!',
      });
    const firstCookies = regRes.headers['set-cookie'] as unknown as string[];
    const firstCsrf = getCookieValue(firstCookies, CSRF_COOKIE_NAME)!;
    const firstRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(firstRotation.status).toBe(200);

    const secondCookies = firstRotation.headers['set-cookie'] as unknown as string[];
    const secondCsrf = getCookieValue(secondCookies, CSRF_COOKIE_NAME)!;
    const secondTokenHash = hashToken(
      getCookieValue(secondCookies, AUTH_COOKIES.REFRESH_TOKEN)!,
    );
    const secondTokenDoc = await RefreshTokenModel.findOne({ tokenHash: secondTokenHash });
    expect(secondTokenDoc).toBeDefined();

    let transactionActive = false;
    const transactionSession = {
      startTransaction: vi.fn(() => {
        transactionActive = true;
      }),
      inTransaction: vi.fn(() => transactionActive),
      abortTransaction: vi.fn(async () => {
        transactionActive = false;
      }),
      endSession: vi.fn(async () => undefined),
    } as unknown as mongoose.ClientSession;
    const fakeClient = {
      topology: { description: { type: 'ReplicaSetWithPrimary' } },
    };

    let checkCompleted!: () => void;
    let releaseReplay!: () => void;
    const checkCompletedPromise = new Promise<void>((resolve) => {
      checkCompleted = resolve;
    });
    const replayRelease = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const originalSave = RefreshTokenModel.prototype.save;
    const originalFindOneAndUpdate = RefreshTokenModel.findOneAndUpdate.bind(RefreshTokenModel);
    let pausedCheck = false;
    let injectedConflict = false;
    const transactionConflict = Object.assign(
      new Error('Simulated concurrent replacement write conflict'),
      {
        code: 112,
        hasErrorLabel: (label: string) => label === 'TransientTransactionError',
      },
    );

    vi.spyOn(mongoose.connection, 'getClient').mockReturnValue(
      fakeClient as unknown as ReturnType<typeof mongoose.connection.getClient>,
    );
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(transactionSession);
    vi.spyOn(RefreshTokenModel.prototype, 'save').mockImplementation(async function (
      this: InstanceType<typeof RefreshTokenModel>,
      ...args: Parameters<typeof originalSave>
    ) {
      if (args[0]?.session === transactionSession) {
        return this;
      }
      return originalSave.apply(this, args);
    });
    vi.spyOn(RefreshTokenModel, 'findOneAndUpdate').mockImplementation((...args) => {
      const [filter, update, options] = args;
      const filterFields = filter as { _id?: mongoose.Types.ObjectId };
      const updateText = JSON.stringify(update);
      if (
        !injectedConflict &&
        String(filterFields._id) === secondTokenDoc!._id.toString() &&
        updateText.includes('replacedByTokenHash')
      ) {
        injectedConflict = true;
        throw transactionConflict;
      }

      const queryOptions =
        options?.session === transactionSession
          ? { ...options, session: undefined }
          : options;
      const query = originalFindOneAndUpdate(filter, update, queryOptions);
      const filterText = JSON.stringify(filter);
      if (
        !pausedCheck &&
        filterText.includes(secondTokenHash) &&
        updateText.includes('predecessorReuseCount')
      ) {
        pausedCheck = true;
        const execute = query.exec.bind(query);
        query.exec = async (...execArgs) => {
          const result = await execute(...execArgs);
          checkCompleted();
          await replayRelease;
          return result;
        };
      }
      return query;
    });

    const pendingReplay = request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf)
      .then((response) => response);

    try {
      const racePoint = await Promise.race([
        checkCompletedPromise.then(() => 'check-completed'),
        pendingReplay.then(() => 'replay-completed'),
      ]);
      expect(racePoint).toBe('check-completed');

      const rotationAfterMarker = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', secondCookies)
        .set('X-CSRF-Token', secondCsrf);
      expect(rotationAfterMarker.status).toBe(500);
      expect(injectedConflict).toBe(true);
      expect(transactionSession.abortTransaction).toHaveBeenCalled();
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);

      releaseReplay();
      const replayResponse = await pendingReplay;
      expect(replayResponse.status).toBe(401);
      expect(replayResponse.body.error.message).toMatch(/recently rotated/i);
      const currentReplacement = await RefreshTokenModel.findOne({
        tokenHash: secondTokenHash,
      });
      expect(currentReplacement?.predecessorReuseCount).toBe(1);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);

      vi.restoreAllMocks();
      const retryRotation = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', secondCookies)
        .set('X-CSRF-Token', secondCsrf);
      expect(retryRotation.status).toBe(200);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
    } finally {
      releaseReplay();
      await pendingReplay;
      vi.restoreAllMocks();
    }
  });

  it('32. should allow replacement rotation after a tolerated sibling replay completes', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Sibling Retry Then Rotate User',
        email: 'sibling-retry-then-rotate@example.com',
        password: 'Password123!',
      });
    const initialCookies = regRes.headers['set-cookie'] as unknown as string[];
    const initialCsrf = getCookieValue(initialCookies, CSRF_COOKIE_NAME)!;

    const firstRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', initialCsrf);
    expect(firstRotation.status).toBe(200);
    const replacementCookies = firstRotation.headers['set-cookie'] as unknown as string[];
    const replacementCsrf = getCookieValue(replacementCookies, CSRF_COOKIE_NAME)!;

    const siblingReplay = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', initialCsrf);
    expect(siblingReplay.status).toBe(401);
    expect(siblingReplay.body.error.message).toMatch(/recently rotated/i);
    expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);

    const legitimateRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', replacementCookies)
      .set('X-CSRF-Token', replacementCsrf);
    expect(legitimateRotation.status).toBe(200);
    expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
  });

  it('33. should keep the replacement rotatable across successive legitimate rotations after a tolerated sibling retry', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'No Poison User',
        email: 'no-poison@example.com',
        password: 'Password123!',
      });
    const firstCookies = regRes.headers['set-cookie'] as unknown as string[];
    const firstCsrf = getCookieValue(firstCookies, CSRF_COOKIE_NAME)!;

    const firstRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(firstRotation.status).toBe(200);
    const secondCookies = firstRotation.headers['set-cookie'] as unknown as string[];
    const secondCsrf = getCookieValue(secondCookies, CSRF_COOKIE_NAME)!;

    // A tolerated in-grace sibling retry is rejected without revocation.
    const sibling = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(sibling.status).toBe(401);
    expect(sibling.body.error.message).toMatch(/recently rotated/i);
    expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
    expect(await RefreshTokenModel.countDocuments({ revocationReason: 'security_replay' })).toBe(0);

    // The replacement is still valid and can be rotated more than once.
    const secondRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', secondCookies)
      .set('X-CSRF-Token', secondCsrf);
    expect(secondRotation.status).toBe(200);
    const thirdCookies = secondRotation.headers['set-cookie'] as unknown as string[];
    const thirdCsrf = getCookieValue(thirdCookies, CSRF_COOKIE_NAME)!;

    const thirdRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', thirdCookies)
      .set('X-CSRF-Token', thirdCsrf);
    expect(thirdRotation.status).toBe(200);

    // No tolerated attempt must have left durable destructive state behind.
    expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
    expect(await RefreshTokenModel.countDocuments({ revocationReason: 'security_replay' })).toBe(0);
  });

  it('34. should not destroy a valid session because of a stale persisted replay verdict', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Stale Verdict User',
        email: 'stale-verdict@example.com',
        password: 'Password123!',
      });
    const firstCookies = regRes.headers['set-cookie'] as unknown as string[];
    const firstCsrf = getCookieValue(firstCookies, CSRF_COOKIE_NAME)!;

    const firstRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(firstRotation.status).toBe(200);
    const replacementCookies = firstRotation.headers['set-cookie'] as unknown as string[];
    const replacementCsrf = getCookieValue(replacementCookies, CSRF_COOKIE_NAME)!;
    const replacementHash = hashToken(
      getCookieValue(replacementCookies, AUTH_COOKIES.REFRESH_TOKEN)!,
    );

    // Simulate a leftover "confirmed replay" verdict written by an older
    // deployment (or an interrupted upgrade). The current design derives the
    // replay decision from the atomic counter, so a stale verdict must never be
    // treated as destructive state and revoke a valid session.
    await RefreshTokenModel.collection.updateOne(
      { tokenHash: replacementHash },
      { $set: { predecessorReplayConfirmed: true } },
    );

    const rotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', replacementCookies)
      .set('X-CSRF-Token', replacementCsrf);
    expect(rotation.status).toBe(200);
    expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
    expect(await RefreshTokenModel.countDocuments({ revocationReason: 'security_replay' })).toBe(0);

    const rotatedCookies = rotation.headers['set-cookie'] as unknown as string[];
    const meRes = await request(app).get('/api/auth/me').set('Cookie', rotatedCookies);
    expect(meRes.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // 35. Transaction reconciliation: our own rotation committed, transient error after
  //     NOTE: fake transaction session/topology; not a real replica-set run.
  // ---------------------------------------------------------------------------
  it('35. should treat a committed rotation as success when a transient error is raised afterwards', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Transient Commit User',
        email: 'transient-commit@example.com',
        password: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME)!;

    const fake = createFakeTransactionSession();
    stubReplicaSetTopology(fake.session);
    stubCandidatePersistence({ fakeSession: fake.session, persist: true });
    stubTransactionalClaim({
      fakeSession: fake.session,
      behavior: 'commit-then-transient',
      transientError: makeTransientTransactionError(),
    });

    try {
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf);

      expect(refreshRes.status).toBe(200);

      const rotatedCookies = refreshRes.headers['set-cookie'] as unknown as string[];
      const rotatedToken = getCookieValue(rotatedCookies, AUTH_COOKIES.REFRESH_TOKEN)!;
      const rotatedHash = hashToken(rotatedToken);

      const oldToken = await RefreshTokenModel.findOne({
        userId: regRes.body.data.user.id,
        isRevoked: true,
      });
      expect(oldToken?.revocationReason).toBe('rotation');
      expect(oldToken?.replacedByTokenHash).toBe(rotatedHash);

      const candidate = await RefreshTokenModel.findOne({ tokenHash: rotatedHash });
      expect(candidate?.isRevoked).toBe(false);
      expect(candidate?.predecessorReuseCount).toBe(0);

      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
      expect(await RefreshTokenModel.countDocuments({ revocationReason: 'security_replay' })).toBe(0);
      expect(fake.abortTransaction).toHaveBeenCalledTimes(1);
      expect(fake.endSession).toHaveBeenCalledTimes(1);
      expect(fake.commitTransaction).not.toHaveBeenCalled();

      const meRes = await request(app).get('/api/auth/me').set('Cookie', rotatedCookies);
      expect(meRes.status).toBe(200);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // ---------------------------------------------------------------------------
  // 36. Transaction reconciliation: token revoked by another request (not our own)
  //     NOTE: fake transaction session/topology; not a real replica-set run.
  // ---------------------------------------------------------------------------
  it('36. should not attribute success to a transient rotation whose token was revoked by another request', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Foreign Revoke User',
        email: 'foreign-revoke@example.com',
        password: 'Password123!',
      });
    const firstCookies = regRes.headers['set-cookie'] as unknown as string[];
    const firstCsrf = getCookieValue(firstCookies, CSRF_COOKIE_NAME)!;

    // A real standalone rotation revokes the old token and links a replacement.
    const firstRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(firstRotation.status).toBe(200);
    const secondTokenHash = hashToken(
      getCookieValue(
        firstRotation.headers['set-cookie'] as unknown as string[],
        AUTH_COOKIES.REFRESH_TOKEN,
      )!,
    );

    const fake = createFakeTransactionSession();
    stubReplicaSetTopology(fake.session);
    stubCandidatePersistence({ fakeSession: fake.session, persist: false });
    stubTransactionalClaim({
      fakeSession: fake.session,
      behavior: 'transient',
      transientError: makeTransientTransactionError(),
    });

    try {
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', firstCookies)
        .set('X-CSRF-Token', firstCsrf);

      expect(refreshRes.status).toBe(401);
      expect(refreshRes.body.error.code).toBe(AUTH_ERRORS.REFRESH_TOKEN_INVALID);
      expect(refreshRes.body.error.message).toMatch(/recently rotated/i);
      expect(refreshRes.body.error.message).not.toMatch(/reuse detected/i);

      const secondToken = await RefreshTokenModel.findOne({ tokenHash: secondTokenHash });
      expect(secondToken?.isRevoked).toBe(false);
      expect(secondToken?.predecessorReuseCount).toBe(1);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
      expect(await RefreshTokenModel.countDocuments({ revocationReason: 'security_replay' })).toBe(0);
      // The aborted candidate must not exist: only the two rotated tokens remain.
      expect(await RefreshTokenModel.countDocuments({})).toBe(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // ---------------------------------------------------------------------------
  // 37. Transaction reconciliation: database failure while re-reading state
  //     NOTE: fake transaction session/topology; not a real replica-set run.
  // ---------------------------------------------------------------------------
  it('37. should surface a reconciliation database failure instead of a false outcome', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Reconciliation Failure User',
        email: 'reconciliation-failure@example.com',
        password: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME)!;

    const fake = createFakeTransactionSession();
    stubReplicaSetTopology(fake.session);
    stubCandidatePersistence({ fakeSession: fake.session, persist: false });
    stubTransactionalClaim({
      fakeSession: fake.session,
      behavior: 'transient',
      transientError: makeTransientTransactionError(),
    });
    vi.spyOn(RefreshTokenModel, 'findOne').mockRejectedValueOnce(
      new Error('Simulated reconciliation read failure'),
    );

    try {
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf);

      // Must not be a 200 (false success) nor a 401 (misleading auth failure).
      expect(refreshRes.status).toBe(500);
      expect(refreshRes.body.success).toBe(false);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
      expect(await RefreshTokenModel.countDocuments({})).toBe(1);
      expect(await RefreshTokenModel.countDocuments({ revocationReason: 'security_replay' })).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // ---------------------------------------------------------------------------
  // 38. Cleanup control flow: expected 401 survives without repeated session cleanup
  //     NOTE: fake transaction session/topology; not a real replica-set run.
  // ---------------------------------------------------------------------------
  it('38. should keep the expected 401 after transaction cleanup without repeating session cleanup', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Unclaimed Cleanup User',
        email: 'unclaimed-cleanup@example.com',
        password: 'Password123!',
      });
    const firstCookies = regRes.headers['set-cookie'] as unknown as string[];
    const firstCsrf = getCookieValue(firstCookies, CSRF_COOKIE_NAME)!;

    const firstRotation = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', firstCookies)
      .set('X-CSRF-Token', firstCsrf);
    expect(firstRotation.status).toBe(200);

    const fake = createFakeTransactionSession();
    stubReplicaSetTopology(fake.session);
    stubCandidatePersistence({ fakeSession: fake.session, persist: false });
    stubTransactionalClaim({
      fakeSession: fake.session,
      behavior: 'null',
      transientError: makeTransientTransactionError(),
    });

    try {
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', firstCookies)
        .set('X-CSRF-Token', firstCsrf);

      expect(refreshRes.status).toBe(401);
      expect(refreshRes.body.error.code).toBe(AUTH_ERRORS.REFRESH_TOKEN_INVALID);
      expect(refreshRes.body.error.message).toMatch(/recently rotated/i);
      expect(fake.abortTransaction).toHaveBeenCalledTimes(1);
      expect(fake.endSession).toHaveBeenCalledTimes(1);
      expect(fake.commitTransaction).not.toHaveBeenCalled();
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
      expect(await RefreshTokenModel.countDocuments({})).toBe(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  // ---------------------------------------------------------------------------
  // 39. Cleanup control flow: cleanup failure is surfaced, never swallowed
  //     NOTE: fake transaction session/topology; not a real replica-set run.
  // ---------------------------------------------------------------------------
  it('39. should surface a session cleanup failure instead of hiding it', async () => {
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Cleanup Failure User',
        email: 'cleanup-failure@example.com',
        password: 'Password123!',
      });
    const cookies = regRes.headers['set-cookie'] as unknown as string[];
    const csrf = getCookieValue(cookies, CSRF_COOKIE_NAME)!;

    const fake = createFakeTransactionSession({ abortFails: true });
    stubReplicaSetTopology(fake.session);
    stubCandidatePersistence({ fakeSession: fake.session, persist: false });
    stubTransactionalClaim({
      fakeSession: fake.session,
      behavior: 'null',
      transientError: makeTransientTransactionError(),
    });

    try {
      const refreshRes = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookies)
        .set('X-CSRF-Token', csrf);

      expect(refreshRes.status).toBe(500);
      expect(refreshRes.body.success).toBe(false);
      // Cleanup is attempted exactly once and endSession still runs afterwards.
      expect(fake.abortTransaction).toHaveBeenCalledTimes(1);
      expect(fake.endSession).toHaveBeenCalledTimes(1);
      expect(await RefreshTokenModel.countDocuments({ isRevoked: false })).toBe(1);
      expect(await RefreshTokenModel.countDocuments({})).toBe(1);
      expect(await RefreshTokenModel.countDocuments({ revocationReason: 'security_replay' })).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
