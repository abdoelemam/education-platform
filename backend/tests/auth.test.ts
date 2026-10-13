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

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/education-platform-test';

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
    // -------------------------------------------------------------------------
    // Database Safety Guard: Prevent accidental connection or deletion of prod data
    // -------------------------------------------------------------------------
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SAFETY CHECK FAILED: Tests must never run in production mode (NODE_ENV=production).');
    }

    if (!TEST_DB_URI.includes('test')) {
      throw new Error(`SAFETY CHECK FAILED: TEST_DB_URI must explicitly contain 'test'. Found: ${TEST_DB_URI}`);
    }

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
    }

    // Verify connected database name
    const connectedDbName = mongoose.connection.name;
    if (!connectedDbName || !connectedDbName.toLowerCase().includes('test')) {
      throw new Error(`SAFETY CHECK FAILED: Connected database name must contain 'test'. Connected to: ${connectedDbName}`);
    }
  });

  afterAll(async () => {
    await UserModel.deleteMany({});
    await RefreshTokenModel.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(async () => {
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

    // Verify cookies are set
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
    // First registration
    await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Jane Doe',
        email: 'duplicate@example.com',
        password: 'Password123!',
      });

    // Attempt second registration with same email
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Another Jane',
        email: 'DUPLICATE@example.com', // test case-insensitivity
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
        name: 'J', // too short
        email: 'invalid-email',
        password: 'short', // less than 8 chars
      });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.body).toBeDefined();
    expect(res.body.error.details.body.name).toBeDefined();
    expect(res.body.error.details.body.email).toBeDefined();
    expect(res.body.error.details.body.password).toBeDefined();
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

    // Verify cookies
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

    // Wrong password
    const resWrongPass = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'bob@example.com',
        password: 'WrongPassword123!',
      });

    expect(resWrongPass.status).toBe(401);
    expect(resWrongPass.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');

    // Non-existent email (prevents account enumeration)
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
    // Unauthenticated
    const unauthRes = await request(app).get('/api/auth/me');
    expect(unauthRes.status).toBe(401);
    expect(unauthRes.body.error.code).toBe('AUTH_UNAUTHORIZED');

    // Authenticated via cookie
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
  // 8. Invalid or expired access token
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
    // Register as student
    const studentRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Student User',
        email: 'student@example.com',
        password: 'Password123!',
        role: 'student',
      });

    const studentCookies = studentRes.headers['set-cookie'] as unknown as string[];

    // Student attempts to access admin route -> 403
    const adminAttempt = await request(roleTestApp)
      .get('/api/test-admin-only')
      .set('Cookie', studentCookies);

    expect(adminAttempt.status).toBe(403);
    expect(adminAttempt.body.error.code).toBe('AUTH_FORBIDDEN');

    // Register as teacher
    const teacherRes = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Teacher User',
        email: 'teacher@example.com',
        password: 'Password123!',
        role: 'teacher',
      });

    const teacherCookies = teacherRes.headers['set-cookie'] as unknown as string[];

    // Teacher accesses teacher route -> 200
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

    // Verify refresh session was created in DB
    const sessionCountBefore = await RefreshTokenModel.countDocuments({ isRevoked: false });
    expect(sessionCountBefore).toBe(1);

    // Logout with CSRF header
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrfToken!);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    // Verify session revoked in DB
    const sessionCountAfter = await RefreshTokenModel.countDocuments({ isRevoked: false });
    expect(sessionCountAfter).toBe(0);

    // Verify clear-cookie headers for access_token, refresh_token, and csrf_token
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

    // Perform refresh
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', initialCsrfToken!);

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.success).toBe(true);

    const rotatedCookies = refreshRes.headers['set-cookie'] as unknown as string[];
    const newRefreshToken = getCookieValue(rotatedCookies, AUTH_COOKIES.REFRESH_TOKEN);
    const newAccessToken = getCookieValue(rotatedCookies, AUTH_COOKIES.ACCESS_TOKEN);

    // New refresh token must be issued and must differ from initial token
    expect(newRefreshToken).toBeDefined();
    expect(newAccessToken).toBeDefined();
    expect(newRefreshToken).not.toBe(initialRefreshToken);

    // Verify database state: exactly 1 active token, 1 revoked token with replacedByTokenHash
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

    // First rotation: succeeds
    const firstRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', csrfToken);

    expect(firstRefresh.status).toBe(200);

    // Attempt second refresh using the INITIAL (now rotated/old) cookie
    const secondRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', csrfToken);

    expect(secondRefresh.status).toBe(401);
    expect(secondRefresh.body.error.code).toBe(AUTH_ERRORS.REFRESH_TOKEN_INVALID);
  });

  // ---------------------------------------------------------------------------
  // 14. Reuse detection: Suspected token theft revokes ALL sessions
  // ---------------------------------------------------------------------------
  it('14. should detect refresh token reuse and revoke all sessions for that user', async () => {
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

    // Malicious actor attempts to reuse the already-rotated Token 1
    const attackRefresh = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', initialCookies)
      .set('X-CSRF-Token', initialCsrf);

    expect(attackRefresh.status).toBe(401);
    expect(attackRefresh.body.error.code).toBe(AUTH_ERRORS.REFRESH_TOKEN_INVALID);

    // Reuse detection MUST have revoked ALL sessions for this user in the database
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
  // 15. Concurrency: Atomic consumption under simultaneous requests
  // ---------------------------------------------------------------------------
  it('15. should handle concurrent refresh requests atomically so only one succeeds', async () => {
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

    // Ensure database consistency: exactly 1 active token should exist
    const activeTokens = await RefreshTokenModel.find({ isRevoked: false });
    expect(activeTokens.length).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 16. Refresh attempt by disabled user account
  // ---------------------------------------------------------------------------
  it('16. should reject refresh attempt if the user account has been disabled', async () => {
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

    // Deactivate user in database
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
  // 17. Refresh attempt by deleted user account
  // ---------------------------------------------------------------------------
  it('17. should reject refresh attempt if the user account has been deleted', async () => {
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

    // Delete user from database completely
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
  // 18. CSRF Protection: Verification on cookie-authenticated state-changing routes
  // ---------------------------------------------------------------------------
  it('18. should enforce CSRF protection on state-changing requests', async () => {
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
});
