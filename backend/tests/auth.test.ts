import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { requireAuth, requireRole } from '../src/middleware/auth.js';
import { asyncHandler } from '../src/utils/async-handler.js';
import { sendSuccess } from '../src/utils/api-response.js';
import { AUTH_COOKIES } from '../src/modules/auth/auth.constants.js';

import express from 'express';
import cookieParser from 'cookie-parser';
import { globalErrorHandler } from '../src/middleware/error-handler.js';

const TEST_DB_URI = 'mongodb://127.0.0.1:27017/education-platform-test';

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
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI);
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
  // 11. Logout behavior and refresh flow
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

    // Verify refresh session was created in DB
    const sessionCountBefore = await RefreshTokenModel.countDocuments({ isRevoked: false });
    expect(sessionCountBefore).toBe(1);

    // Logout
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookies);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    // Verify session revoked in DB
    const sessionCountAfter = await RefreshTokenModel.countDocuments({ isRevoked: false });
    expect(sessionCountAfter).toBe(0);

    // Verify clear-cookie headers
    const clearCookies = logoutRes.headers['set-cookie'] as unknown as string[];
    expect(clearCookies).toBeDefined();
    expect(clearCookies.some((c: string) => c.includes('access_token=;'))).toBe(true);
    expect(clearCookies.some((c: string) => c.includes('refresh_token=;'))).toBe(true);
  });
});
