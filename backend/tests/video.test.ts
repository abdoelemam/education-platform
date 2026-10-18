import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import { createApp } from '../src/app.js';
import { AppError } from '../src/errors/index.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { RefreshTokenModel } from '../src/modules/auth/refresh-token.model.js';
import { VideoModel } from '../src/modules/videos/video.model.js';
import {
  videoRepository,
  VideoRepository,
} from '../src/modules/videos/video.repository.js';
import { VideoService } from '../src/modules/videos/video.service.js';
import { UnconfiguredVideoProvider } from '../src/modules/videos/providers/unconfigured.video-provider.js';
import { VIDEO_ERRORS } from '../src/modules/videos/video.constants.js';
import { AUTH_ERRORS } from '../src/modules/auth/auth.constants.js';
import { CSRF_COOKIE_NAME } from '../src/middleware/csrf.js';
import type {
  ProviderAssetInfo,
  VideoPlaybackReference,
  VideoProvider,
  VideoUploadAuthorization,
  VideoUploadAuthorizationRequest,
} from '../src/modules/videos/providers/video-provider.interface.js';

const EXPECTED_TEST_DB_NAME = 'education-platform-test';
const ALLOWED_TEST_HOSTS = new Set(['127.0.0.1', 'localhost']);
const TEST_DB_URI = 'mongodb://127.0.0.1:27017/education-platform-test';

/**
 * Strict database safety assertion (mirrors the auth suite):
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

/**
 * In-memory provider used to exercise the provider boundary without network
 * access. It models an external storage/processing provider and is never used
 * in production code.
 */
class FakeVideoProvider implements VideoProvider {
  readonly name = 'fake-provider';

  private assets = new Map<string, ProviderAssetInfo>();

  readonly authorizationRequests: VideoUploadAuthorizationRequest[] = [];
  readonly deletedAssets: string[] = [];
  getAssetCalls = 0;
  /** When set, the next authorization request fails like a provider outage. */
  failNextAuthorization = false;

  isConfigured(): boolean {
    return true;
  }

  async createUploadAuthorization(
    input: VideoUploadAuthorizationRequest,
  ): Promise<VideoUploadAuthorization> {
    if (this.failNextAuthorization) {
      this.failNextAuthorization = false;
      throw new AppError(
        502,
        VIDEO_ERRORS.VIDEO_PROVIDER_ERROR,
        'Fake provider unavailable',
      );
    }

    this.authorizationRequests.push(input);

    return {
      provider: this.name,
      assetId: input.assetId,
      uploadUrl: 'https://fake-provider.test/video/upload',
      method: 'POST',
      fields: {
        public_id: input.assetId,
        timestamp: '1700000000',
        api_key: 'fake-api-key',
        signature: 'fake-signature',
      },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    };
  }

  async getAsset(assetId: string): Promise<ProviderAssetInfo> {
    this.getAssetCalls += 1;
    return (
      this.assets.get(assetId) ?? { exists: false, assetId, status: 'failed' }
    );
  }

  buildPlaybackReference(asset: ProviderAssetInfo): VideoPlaybackReference {
    return {
      provider: this.name,
      assetId: asset.assetId,
      url:
        asset.playbackUrl ??
        `https://fake-provider.test/play/${asset.assetId}`,
    };
  }

  async deleteAsset(assetId: string): Promise<void> {
    this.deletedAssets.push(assetId);
    this.assets.delete(assetId);
  }

  seedAsset(
    assetId: string,
    overrides: Partial<ProviderAssetInfo> = {},
  ): ProviderAssetInfo {
    const asset: ProviderAssetInfo = {
      exists: true,
      assetId,
      status: 'ready',
      durationSeconds: 321,
      width: 1920,
      height: 1080,
      format: 'mp4',
      sizeBytes: 123456,
      thumbnailUrl: `https://fake-provider.test/thumb/${assetId}.jpg`,
      playbackUrl: `https://fake-provider.test/play/${assetId}.mp4`,
      ...overrides,
    };

    this.assets.set(assetId, asset);
    return asset;
  }

  reset(): void {
    this.assets.clear();
    this.authorizationRequests.length = 0;
    this.deletedAssets.length = 0;
    this.getAssetCalls = 0;
    this.failNextAuthorization = false;
  }
}

/**
 * Repository wrapper whose writes can be forced to fail, proving that a failed
 * DB update never triggers deletion of the superseded provider asset.
 */
class UpdateFailingVideoRepository extends VideoRepository {
  failUpdates = false;

  override async updateById(
    id: string,
    update: Parameters<VideoRepository['updateById']>[1],
    unset: string[] = [],
  ) {
    if (this.failUpdates) {
      return null;
    }
    return super.updateById(id, update, unset);
  }
}

interface TestSession {
  cookies: string[];
  csrf: string;
  userId: string;
}

describe('Video System Integration Tests', () => {
  const fakeProvider = new FakeVideoProvider();
  const app = createApp({
    videoService: new VideoService(videoRepository, fakeProvider),
  });

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
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    assertSafeTestDatabase();
    await UserModel.deleteMany({});
    await RefreshTokenModel.deleteMany({});
    await VideoModel.deleteMany({});
    fakeProvider.reset();
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
      name: input.name ?? 'Video Test User',
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

  async function createVideo(
    session: TestSession,
    title = 'Course Intro Video',
  ): Promise<string> {
    const res = await request(app)
      .post('/api/teacher/videos')
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send({ title, description: 'A short introduction' });

    expect(res.status).toBe(201);
    return res.body.data.video.id as string;
  }

  async function authorizeUpload(
    session: TestSession,
    videoId: string,
  ): Promise<{ assetId: string; upload: Record<string, unknown> }> {
    const res = await request(app)
      .post(`/api/teacher/videos/${videoId}/upload-authorization`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf);

    expect(res.status).toBe(200);
    return {
      assetId: res.body.data.upload.assetId as string,
      upload: res.body.data.upload as Record<string, unknown>,
    };
  }

  async function completeUpload(
    session: TestSession,
    videoId: string,
    payload: Record<string, unknown> = {},
  ) {
    return request(app)
      .post(`/api/teacher/videos/${videoId}/upload-complete`)
      .set('Cookie', session.cookies)
      .set('X-CSRF-Token', session.csrf)
      .send(payload);
  }

  // ---------------------------------------------------------------------------
  // 1. Authentication required
  // ---------------------------------------------------------------------------
  it('1. should reject unauthenticated access to teacher video routes', async () => {
    const res = await request(app)
      .post('/api/teacher/videos')
      .send({ title: 'No auth' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe(AUTH_ERRORS.UNAUTHORIZED);
  });

  // ---------------------------------------------------------------------------
  // 2. Students cannot access teacher video routes
  // ---------------------------------------------------------------------------
  it('2. should forbid students from accessing teacher video routes', async () => {
    const student = await registerUser({
      email: 'student.video@example.com',
      role: 'student',
    });

    const res = await request(app)
      .post('/api/teacher/videos')
      .set('Cookie', student.cookies)
      .set('X-CSRF-Token', student.csrf)
      .send({ title: 'Student video' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);
  });

  // ---------------------------------------------------------------------------
  // 3. Pending teachers are rejected until approved
  // ---------------------------------------------------------------------------
  it('3. should forbid pending teachers until their account is approved', async () => {
    const pending = await registerUser({
      email: 'pending.teacher@example.com',
      role: 'teacher',
    });

    const res = await request(app)
      .post('/api/teacher/videos')
      .set('Cookie', pending.cookies)
      .set('X-CSRF-Token', pending.csrf)
      .send({ title: 'Pending video' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(AUTH_ERRORS.FORBIDDEN);

    // Approving the teacher unlocks the same session (auth reads DB state).
    await UserModel.updateOne(
      { _id: pending.userId },
      { teacherStatus: 'approved' },
    ).exec();

    const retry = await request(app)
      .post('/api/teacher/videos')
      .set('Cookie', pending.cookies)
      .set('X-CSRF-Token', pending.csrf)
      .send({ title: 'Pending video' });

    expect(retry.status).toBe(201);
  });

  // ---------------------------------------------------------------------------
  // 4. CSRF is required on state-changing routes
  // ---------------------------------------------------------------------------
  it('4. should require a valid CSRF token for state-changing video routes', async () => {
    const teacher = await registerApprovedTeacher('csrf.teacher@example.com');

    const res = await request(app)
      .post('/api/teacher/videos')
      .set('Cookie', teacher.cookies)
      .send({ title: 'No CSRF' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(AUTH_ERRORS.CSRF_TOKEN_MISSING);
  });

  // ---------------------------------------------------------------------------
  // 5. Input validation
  // ---------------------------------------------------------------------------
  it('5. should validate video creation input with Zod', async () => {
    const teacher = await registerApprovedTeacher('validate.teacher@example.com');

    const res = await request(app)
      .post('/api/teacher/videos')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: '' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.body.title).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 6. Metadata creation is owned by the authenticated teacher
  // ---------------------------------------------------------------------------
  it('6. should create video metadata owned by the authenticated teacher', async () => {
    const teacher = await registerApprovedTeacher('owner.teacher@example.com');

    const res = await request(app)
      .post('/api/teacher/videos')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Owned Video', description: 'Owned description' });

    expect(res.status).toBe(201);

    const video = res.body.data.video;
    expect(video.id).toBeDefined();
    expect(video.ownerId).toBe(teacher.userId);
    expect(video.title).toBe('Owned Video');
    expect(video.provider).toBe('fake-provider');
    expect(video.uploadStatus).toBe('not_authorized');
    expect(video.processingStatus).toBe('pending');
    expect(video.playbackUrl).toBeUndefined();

    const stored = await VideoModel.findById(video.id).exec();
    expect(stored).not.toBeNull();
    expect(stored!.ownerId.toString()).toBe(teacher.userId);
  });

  // ---------------------------------------------------------------------------
  // 7. Listing is scoped to the owner
  // ---------------------------------------------------------------------------
  it('7. should list only the authenticated teacher videos with pagination meta', async () => {
    const teacherA = await registerApprovedTeacher('list.a@example.com');
    const teacherB = await registerApprovedTeacher('list.b@example.com');

    await createVideo(teacherA, 'A video 1');
    await createVideo(teacherA, 'A video 2');
    await createVideo(teacherB, 'B video');

    const res = await request(app)
      .get('/api/teacher/videos')
      .set('Cookie', teacherA.cookies);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(
      res.body.data.every(
        (video: { ownerId: string }) => video.ownerId === teacherA.userId,
      ),
    ).toBe(true);

    const page2 = await request(app)
      .get('/api/teacher/videos?page=2&limit=1')
      .set('Cookie', teacherA.cookies);

    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta).toMatchObject({
      page: 2,
      limit: 1,
      total: 2,
      totalPages: 2,
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Ownership checks and admin bypass
  // ---------------------------------------------------------------------------
  it('8. should enforce ownership for reads and allow admins to bypass it', async () => {
    const owner = await registerApprovedTeacher('read.owner@example.com');
    const other = await registerApprovedTeacher('read.other@example.com');
    const admin = await createAdmin('admin.video@example.com');

    const videoId = await createVideo(owner);

    const ownerRead = await request(app)
      .get(`/api/teacher/videos/${videoId}`)
      .set('Cookie', owner.cookies);
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.body.data.video.id).toBe(videoId);

    const otherRead = await request(app)
      .get(`/api/teacher/videos/${videoId}`)
      .set('Cookie', other.cookies);
    expect(otherRead.status).toBe(403);
    expect(otherRead.body.error.code).toBe(VIDEO_ERRORS.VIDEO_FORBIDDEN);

    const adminRead = await request(app)
      .get(`/api/teacher/videos/${videoId}`)
      .set('Cookie', admin.cookies);
    expect(adminRead.status).toBe(200);

    const missing = await request(app)
      .get('/api/teacher/videos/507f1f77bcf86cd799439011')
      .set('Cookie', owner.cookies);
    expect(missing.status).toBe(404);

    const invalidId = await request(app)
      .get('/api/teacher/videos/not-an-object-id')
      .set('Cookie', owner.cookies);
    expect(invalidId.status).toBe(422);
    expect(invalidId.body.error.code).toBe('VALIDATION_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 9. Secure upload authorization
  // ---------------------------------------------------------------------------
  it('9. should issue signed direct-upload instructions without provider secrets', async () => {
    const teacher = await registerApprovedTeacher('upload.teacher@example.com');
    const videoId = await createVideo(teacher);

    const { assetId, upload } = await authorizeUpload(teacher, videoId);

    expect(upload.provider).toBe('fake-provider');
    expect(upload.uploadUrl).toBe('https://fake-provider.test/video/upload');
    expect(upload.method).toBe('POST');
    expect(upload.expiresAt).toBeDefined();
    expect(assetId).toContain(videoId);

    const fields = upload.fields as Record<string, string>;
    expect(fields.signature).toBe('fake-signature');
    expect(fields.api_key).toBe('fake-api-key');
    expect(fields.api_secret).toBeUndefined();

    // The server chose the asset id, not the client.
    expect(fakeProvider.authorizationRequests).toHaveLength(1);
    expect(fakeProvider.authorizationRequests[0]!.assetId).toBe(assetId);
    expect(fakeProvider.authorizationRequests[0]!.ownerId).toBe(teacher.userId);

    const stored = await VideoModel.findById(videoId).exec();
    expect(stored!.uploadStatus).toBe('authorized');
    expect(stored!.processingStatus).toBe('pending');
    expect(stored!.providerAssetId).toBe(assetId);
    expect(stored!.uploadAuthorizationExpiresAt).toBeDefined();
    expect(stored!.playbackUrl).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 10. Other teachers cannot obtain upload instructions
  // ---------------------------------------------------------------------------
  it('10. should forbid other teachers from obtaining upload authorization', async () => {
    const owner = await registerApprovedTeacher('authz.owner@example.com');
    const other = await registerApprovedTeacher('authz.other@example.com');
    const videoId = await createVideo(owner);

    const res = await request(app)
      .post(`/api/teacher/videos/${videoId}/upload-authorization`)
      .set('Cookie', other.cookies)
      .set('X-CSRF-Token', other.csrf);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(VIDEO_ERRORS.VIDEO_FORBIDDEN);
    expect(fakeProvider.authorizationRequests).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 11. Unconfigured provider fails closed
  // ---------------------------------------------------------------------------
  it('11. should fail closed when no video provider is configured', async () => {
    const teacher = await registerApprovedTeacher('unconfigured.teacher@example.com');
    const unconfiguredApp = createApp({
      videoService: new VideoService(
        videoRepository,
        new UnconfiguredVideoProvider(),
      ),
    });

    const created = await request(unconfiguredApp)
      .post('/api/teacher/videos')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Unconfigured provider video' });

    expect(created.status).toBe(201);

    const res = await request(unconfiguredApp)
      .post(`/api/teacher/videos/${created.body.data.video.id}/upload-authorization`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe(VIDEO_ERRORS.VIDEO_PROVIDER_NOT_CONFIGURED);
  });

  // ---------------------------------------------------------------------------
  // 12. Completion requires prior authorization
  // ---------------------------------------------------------------------------
  it('12. should reject upload completion before authorization', async () => {
    const teacher = await registerApprovedTeacher('complete.first@example.com');
    const videoId = await createVideo(teacher);

    const res = await completeUpload(teacher, videoId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(VIDEO_ERRORS.VIDEO_UPLOAD_NOT_AUTHORIZED);
  });

  // ---------------------------------------------------------------------------
  // 13. Missing provider asset is reported and persisted
  // ---------------------------------------------------------------------------
  it('13. should reject completion when the provider cannot find the asset', async () => {
    const teacher = await registerApprovedTeacher('complete.missing@example.com');
    const videoId = await createVideo(teacher);
    await authorizeUpload(teacher, videoId);

    const res = await completeUpload(teacher, videoId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(VIDEO_ERRORS.VIDEO_UPLOAD_NOT_FOUND);

    const stored = await VideoModel.findById(videoId).exec();
    expect(stored!.uploadStatus).toBe('failed');
    expect(stored!.processingStatus).toBe('failed');
    expect(stored!.failureReason).toBeDefined();
    expect(stored!.playbackUrl).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 14. Provider metadata is authoritative; client hints are ignored
  // ---------------------------------------------------------------------------
  it('14. should verify completion with the provider and ignore client metadata', async () => {
    const teacher = await registerApprovedTeacher('complete.ready@example.com');
    const videoId = await createVideo(teacher);
    const { assetId } = await authorizeUpload(teacher, videoId);

    fakeProvider.seedAsset(assetId);

    const res = await completeUpload(teacher, videoId, {
      // Deliberately untrusted client hints.
      durationSeconds: 999999,
      processingStatus: 'ready',
      playbackUrl: 'https://attacker.test/evil.mp4',
    });

    expect(res.status).toBe(200);

    const video = res.body.data.video;
    expect(video.uploadStatus).toBe('completed');
    expect(video.processingStatus).toBe('ready');
    expect(video.providerAssetId).toBe(assetId);
    expect(video.durationSeconds).toBe(321);
    expect(video.width).toBe(1920);
    expect(video.height).toBe(1080);
    expect(video.format).toBe('mp4');
    expect(video.sizeBytes).toBe(123456);
    expect(video.thumbnailUrl).toBe(
      `https://fake-provider.test/thumb/${assetId}.jpg`,
    );
    expect(video.playbackUrl).toBe(
      `https://fake-provider.test/play/${assetId}.mp4`,
    );
    expect(video.readyAt).toBeDefined();
    expect(fakeProvider.getAssetCalls).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 15. Playback is gated until the provider reports ready
  // ---------------------------------------------------------------------------
  it('15. should expose playback only after the provider reports the video ready', async () => {
    const teacher = await registerApprovedTeacher('playback.teacher@example.com');
    const other = await registerApprovedTeacher('playback.other@example.com');
    const videoId = await createVideo(teacher);
    const { assetId } = await authorizeUpload(teacher, videoId);

    const beforeReady = await request(app)
      .get(`/api/teacher/videos/${videoId}/playback`)
      .set('Cookie', teacher.cookies);

    expect(beforeReady.status).toBe(409);
    expect(beforeReady.body.error.code).toBe(VIDEO_ERRORS.VIDEO_NOT_READY);

    fakeProvider.seedAsset(assetId);
    const completed = await completeUpload(teacher, videoId);
    expect(completed.status).toBe(200);

    const playback = await request(app)
      .get(`/api/teacher/videos/${videoId}/playback`)
      .set('Cookie', teacher.cookies);

    expect(playback.status).toBe(200);
    expect(playback.body.data.playback).toMatchObject({
      provider: 'fake-provider',
      assetId,
      url: `https://fake-provider.test/play/${assetId}.mp4`,
    });

    const forbidden = await request(app)
      .get(`/api/teacher/videos/${videoId}/playback`)
      .set('Cookie', other.cookies);

    expect(forbidden.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // 16. Completion is idempotent once ready
  // ---------------------------------------------------------------------------
  it('16. should treat repeated completion of a ready video as idempotent', async () => {
    const teacher = await registerApprovedTeacher('complete.twice@example.com');
    const videoId = await createVideo(teacher);
    const { assetId } = await authorizeUpload(teacher, videoId);
    fakeProvider.seedAsset(assetId);

    const first = await completeUpload(teacher, videoId);
    expect(first.status).toBe(200);
    const callsAfterFirst = fakeProvider.getAssetCalls;

    const second = await completeUpload(teacher, videoId);
    expect(second.status).toBe(200);
    expect(second.body.data.video.playbackUrl).toBe(
      first.body.data.video.playbackUrl,
    );
    // No extra provider round-trip once ready.
    expect(fakeProvider.getAssetCalls).toBe(callsAfterFirst);
  });

  // ---------------------------------------------------------------------------
  // 17. Deletion removes metadata and the provider asset
  // ---------------------------------------------------------------------------
  it('17. should delete video metadata and the provider asset', async () => {
    const teacher = await registerApprovedTeacher('delete.teacher@example.com');
    const videoId = await createVideo(teacher);
    const { assetId } = await authorizeUpload(teacher, videoId);
    fakeProvider.seedAsset(assetId);
    await completeUpload(teacher, videoId);

    const res = await request(app)
      .delete(`/api/teacher/videos/${videoId}`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);

    expect(res.status).toBe(200);
    expect(fakeProvider.deletedAssets).toContain(assetId);

    const stored = await VideoModel.findById(videoId).exec();
    expect(stored).toBeNull();

    const afterDelete = await request(app)
      .get(`/api/teacher/videos/${videoId}`)
      .set('Cookie', teacher.cookies);
    expect(afterDelete.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // 18. Admin can access another teacher's ready video
  // ---------------------------------------------------------------------------
  it('18. should allow admins to read and play another teacher video', async () => {
    const teacher = await registerApprovedTeacher('admin.read.teacher@example.com');
    const admin = await createAdmin('admin.read@example.com');
    const videoId = await createVideo(teacher);
    const { assetId } = await authorizeUpload(teacher, videoId);
    fakeProvider.seedAsset(assetId);
    await completeUpload(teacher, videoId);

    const read = await request(app)
      .get(`/api/teacher/videos/${videoId}`)
      .set('Cookie', admin.cookies);

    expect(read.status).toBe(200);

    const playback = await request(app)
      .get(`/api/teacher/videos/${videoId}/playback`)
      .set('Cookie', admin.cookies);

    expect(playback.status).toBe(200);
    expect(playback.body.data.playback.assetId).toBe(assetId);
  });

  // ---------------------------------------------------------------------------
  // 19. Completion accepts an absent body
  // ---------------------------------------------------------------------------
  it('19. should accept upload completion with an absent request body', async () => {
    const teacher = await registerApprovedTeacher('complete.nobody@example.com');
    const videoId = await createVideo(teacher);
    const { assetId } = await authorizeUpload(teacher, videoId);
    fakeProvider.seedAsset(assetId);

    const res = await request(app)
      .post(`/api/teacher/videos/${videoId}/upload-complete`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);

    expect(res.status).toBe(200);
    expect(res.body.data.video.processingStatus).toBe('ready');
  });

  // ---------------------------------------------------------------------------
  // 20. Refresh a processing upload until ready without clobbering uploadedAt
  // ---------------------------------------------------------------------------
  it('20. should refresh processing state until ready and keep uploadedAt stable', async () => {
    const teacher = await registerApprovedTeacher('complete.processing@example.com');
    const videoId = await createVideo(teacher);
    const { assetId } = await authorizeUpload(teacher, videoId);

    fakeProvider.seedAsset(assetId, {
      status: 'processing',
      playbackUrl: undefined,
      thumbnailUrl: undefined,
    });

    const processing = await completeUpload(teacher, videoId);
    expect(processing.status).toBe(200);
    expect(processing.body.data.video.uploadStatus).toBe('completed');
    expect(processing.body.data.video.processingStatus).toBe('processing');
    expect(processing.body.data.video.playbackUrl).toBeUndefined();

    const storedWhileProcessing = await VideoModel.findById(videoId).exec();
    const uploadedAt = storedWhileProcessing!.uploadedAt;
    expect(uploadedAt).toBeDefined();
    expect(storedWhileProcessing!.readyAt).toBeUndefined();

    const playbackBeforeReady = await request(app)
      .get(`/api/teacher/videos/${videoId}/playback`)
      .set('Cookie', teacher.cookies);
    expect(playbackBeforeReady.status).toBe(409);
    expect(playbackBeforeReady.body.error.code).toBe(VIDEO_ERRORS.VIDEO_NOT_READY);

    // The provider finishes processing.
    fakeProvider.seedAsset(assetId);

    const ready = await completeUpload(teacher, videoId);
    expect(ready.status).toBe(200);
    expect(ready.body.data.video.processingStatus).toBe('ready');
    expect(ready.body.data.video.playbackUrl).toBe(
      `https://fake-provider.test/play/${assetId}.mp4`,
    );

    const storedWhenReady = await VideoModel.findById(videoId).exec();
    expect(storedWhenReady!.uploadedAt?.getTime()).toBe(uploadedAt?.getTime());
    expect(storedWhenReady!.readyAt).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 21. A ready video cannot receive new upload instructions
  // ---------------------------------------------------------------------------
  it('21. should not issue new upload instructions for a ready video', async () => {
    const owner = await registerApprovedTeacher('reauth.owner@example.com');
    const other = await registerApprovedTeacher('reauth.other@example.com');
    const videoId = await createVideo(owner);
    const { assetId } = await authorizeUpload(owner, videoId);
    fakeProvider.seedAsset(assetId);
    await completeUpload(owner, videoId);

    const ownerRetry = await request(app)
      .post(`/api/teacher/videos/${videoId}/upload-authorization`)
      .set('Cookie', owner.cookies)
      .set('X-CSRF-Token', owner.csrf);

    expect(ownerRetry.status).toBe(409);
    expect(ownerRetry.body.error.code).toBe(
      VIDEO_ERRORS.VIDEO_UPLOAD_ALREADY_COMPLETE,
    );

    // Ownership is enforced before the ready check.
    const otherRetry = await request(app)
      .post(`/api/teacher/videos/${videoId}/upload-authorization`)
      .set('Cookie', other.cookies)
      .set('X-CSRF-Token', other.csrf);

    expect(otherRetry.status).toBe(403);
    expect(otherRetry.body.error.code).toBe(VIDEO_ERRORS.VIDEO_FORBIDDEN);

    // No additional provider authorization was issued for the ready video.
    expect(fakeProvider.authorizationRequests).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 22. Retry after an upload that never produced an asset reuses the asset id
  // ---------------------------------------------------------------------------
  it('22. should reuse the asset id when retrying an upload with no provider asset', async () => {
    const teacher = await registerApprovedTeacher('retry.missing@example.com');
    const videoId = await createVideo(teacher);

    const first = await authorizeUpload(teacher, videoId);
    const failed = await completeUpload(teacher, videoId);
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe(VIDEO_ERRORS.VIDEO_UPLOAD_NOT_FOUND);

    const second = await authorizeUpload(teacher, videoId);

    expect(second.assetId).toBe(first.assetId);
    expect(fakeProvider.authorizationRequests).toHaveLength(2);
    // Nothing existed at the provider, so there is nothing to clean up.
    expect(fakeProvider.deletedAssets).toHaveLength(0);

    fakeProvider.seedAsset(second.assetId);
    const completed = await completeUpload(teacher, videoId);
    expect(completed.status).toBe(200);
    expect(completed.body.data.video.processingStatus).toBe('ready');
  });

  // ---------------------------------------------------------------------------
  // 23. Retry after a provider-confirmed processing failure rotates the asset
  // ---------------------------------------------------------------------------
  it('23. should rotate the asset id and clean up after a processing failure', async () => {
    const teacher = await registerApprovedTeacher('retry.broken@example.com');
    const videoId = await createVideo(teacher);

    const first = await authorizeUpload(teacher, videoId);
    fakeProvider.seedAsset(first.assetId, {
      status: 'failed',
      failureReason: 'transcode failed',
    });

    const failedComplete = await completeUpload(teacher, videoId);
    expect(failedComplete.status).toBe(502);
    expect(failedComplete.body.error.code).toBe(
      VIDEO_ERRORS.VIDEO_PROVIDER_ERROR,
    );

    const storedFailed = await VideoModel.findById(videoId).exec();
    expect(storedFailed!.uploadStatus).toBe('completed');
    expect(storedFailed!.processingStatus).toBe('failed');

    const second = await authorizeUpload(teacher, videoId);

    expect(second.assetId).not.toBe(first.assetId);
    expect(second.assetId.startsWith(`${first.assetId}-`)).toBe(true);
    expect(fakeProvider.deletedAssets).toContain(first.assetId);

    fakeProvider.seedAsset(second.assetId);
    const completed = await completeUpload(teacher, videoId);
    expect(completed.status).toBe(200);
    expect(completed.body.data.video.providerAssetId).toBe(second.assetId);
    expect(completed.body.data.video.processingStatus).toBe('ready');
  });

  // ---------------------------------------------------------------------------
  // 24. Completion trusts the provider even after the recorded window elapsed
  // ---------------------------------------------------------------------------
  it('24. should verify completion from the provider after the recorded window elapsed', async () => {
    const teacher = await registerApprovedTeacher('expired.authorization@example.com');
    const videoId = await createVideo(teacher);
    const { assetId } = await authorizeUpload(teacher, videoId);
    fakeProvider.seedAsset(assetId);

    // The upload happened within Cloudinary's 1-hour window but completion was
    // reported later; the provider asset is the source of truth, not our clock.
    await VideoModel.updateOne(
      { _id: videoId },
      { uploadAuthorizationExpiresAt: new Date(Date.now() - 60_000) },
    ).exec();

    const res = await completeUpload(teacher, videoId);
    expect(res.status).toBe(200);
    expect(res.body.data.video.processingStatus).toBe('ready');
  });

  // ---------------------------------------------------------------------------
  // 25. Other teachers cannot complete someone else's upload
  // ---------------------------------------------------------------------------
  it('25. should forbid other teachers from completing an owned upload', async () => {
    const owner = await registerApprovedTeacher('complete.owner@example.com');
    const other = await registerApprovedTeacher('complete.other@example.com');
    const videoId = await createVideo(owner);
    const { assetId } = await authorizeUpload(owner, videoId);
    fakeProvider.seedAsset(assetId);

    const res = await request(app)
      .post(`/api/teacher/videos/${videoId}/upload-complete`)
      .set('Cookie', other.cookies)
      .set('X-CSRF-Token', other.csrf);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(VIDEO_ERRORS.VIDEO_FORBIDDEN);
    // The provider was never consulted on behalf of the non-owner.
    expect(fakeProvider.getAssetCalls).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 26. A failed authorization must not delete the superseded asset
  // ---------------------------------------------------------------------------
  it('26. should not delete the superseded asset when issuing instructions fails', async () => {
    const teacher = await registerApprovedTeacher('rotation.auth.fail@example.com');
    const videoId = await createVideo(teacher);

    const first = await authorizeUpload(teacher, videoId);
    fakeProvider.seedAsset(first.assetId, {
      status: 'failed',
      failureReason: 'transcode failed',
    });
    const failedComplete = await completeUpload(teacher, videoId);
    expect(failedComplete.status).toBe(502);

    // A rotation is now required; make the provider fail to issue instructions.
    fakeProvider.failNextAuthorization = true;

    const res = await request(app)
      .post(`/api/teacher/videos/${videoId}/upload-authorization`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe(VIDEO_ERRORS.VIDEO_PROVIDER_ERROR);
    // The old asset is untouched because the new state was never persisted.
    expect(fakeProvider.deletedAssets).toHaveLength(0);

    const stored = await VideoModel.findById(videoId).exec();
    expect(stored!.providerAssetId).toBe(first.assetId);
    expect(stored!.processingStatus).toBe('failed');
  });

  // ---------------------------------------------------------------------------
  // 27. A failed DB write must not delete the superseded asset
  // ---------------------------------------------------------------------------
  it('27. should not delete the superseded asset when saving the new state fails', async () => {
    const failingRepo = new UpdateFailingVideoRepository();
    const failingApp = createApp({
      videoService: new VideoService(failingRepo, fakeProvider),
    });
    const teacher = await registerApprovedTeacher('rotation.db.fail@example.com');

    const created = await request(failingApp)
      .post('/api/teacher/videos')
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf)
      .send({ title: 'Rotation DB failure' });
    expect(created.status).toBe(201);
    const videoId = created.body.data.video.id as string;

    const first = await request(failingApp)
      .post(`/api/teacher/videos/${videoId}/upload-authorization`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);
    expect(first.status).toBe(200);
    const assetId = first.body.data.upload.assetId as string;

    fakeProvider.seedAsset(assetId, {
      status: 'failed',
      failureReason: 'transcode failed',
    });
    const failedComplete = await request(failingApp)
      .post(`/api/teacher/videos/${videoId}/upload-complete`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);
    expect(failedComplete.status).toBe(502);

    // The write now fails, so the new asset id cannot be persisted.
    failingRepo.failUpdates = true;

    const res = await request(failingApp)
      .post(`/api/teacher/videos/${videoId}/upload-authorization`)
      .set('Cookie', teacher.cookies)
      .set('X-CSRF-Token', teacher.csrf);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(VIDEO_ERRORS.VIDEO_NOT_FOUND);
    // No deletion is attempted before the new state is committed.
    expect(fakeProvider.deletedAssets).toHaveLength(0);

    const stored = await VideoModel.findById(videoId).exec();
    expect(stored!.providerAssetId).toBe(assetId);
  });
});
