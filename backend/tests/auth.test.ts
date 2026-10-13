import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  // 15. Concurrency: High concurrency scenario (5 simultaneous requests)
  // ---------------------------------------------------------------------------
  it('15. should handle high concurrency (5 simultaneous refresh requests) with stable results', async () => {
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

    // Exactly 1 active session in the database; none of the 4 rejections killed the new session
    const activeTokens = await RefreshTokenModel.find({ isRevoked: false });
    expect(activeTokens.length).toBe(1);

    const winningRes = responses.find((r) => r.status === 200)!;
    const newCookies = winningRes.headers['set-cookie'] as unknown as string[];
    const meRes = await request(app).get('/api/auth/me').set('Cookie', newCookies);
    expect(meRes.status).toBe(200);
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
  // 17. Refresh attempt by disabled user account
  // ---------------------------------------------------------------------------
  it('17. should reject refresh attempt if the user account has been disabled', async () => {
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
  // 18. Refresh attempt by deleted user account
  // ---------------------------------------------------------------------------
  it('18. should reject refresh attempt if the user account has been deleted', async () => {
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
  // 19. CSRF Protection: Verification on cookie-authenticated state-changing routes
  // ---------------------------------------------------------------------------
  it('19. should enforce CSRF protection on state-changing requests', async () => {
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
  // 20. Database Safety: Rejection of non-matching or unsafe test database
  // ---------------------------------------------------------------------------
  it('20. should abort if database name or host does not match the designated test database', () => {
    // Calling assertSafeTestDatabase() under valid test setup succeeds
    expect(() => assertSafeTestDatabase()).not.toThrow();
  });
});
