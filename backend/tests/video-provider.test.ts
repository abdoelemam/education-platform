import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { CloudinaryVideoProvider } from '../src/modules/videos/providers/cloudinary.video-provider.js';
import { UnconfiguredVideoProvider } from '../src/modules/videos/providers/unconfigured.video-provider.js';
import { VIDEO_ERRORS } from '../src/modules/videos/video.constants.js';
import type { ProviderAssetInfo } from '../src/modules/videos/providers/video-provider.interface.js';

const CLOUD_NAME = 'demo-cloud';
const API_KEY = 'demo-key';
const API_SECRET = 'demo-secret';
/** Cloudinary's fixed, server-enforced upload-signature window. */
const CLOUDINARY_TTL_SECONDS = 60 * 60;

function createProvider(): CloudinaryVideoProvider {
  return new CloudinaryVideoProvider({
    cloudName: CLOUD_NAME,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
  });
}

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CloudinaryVideoProvider', () => {
  it('creates deterministic signed upload instructions without the API secret', async () => {
    const provider = createProvider();
    const assetId = 'education-platform/videos/664f00000000000000000001';

    const authorization = await provider.createUploadAuthorization({
      videoId: '664f00000000000000000001',
      ownerId: '664e00000000000000000002',
      assetId,
    });

    expect(authorization.provider).toBe('cloudinary');
    expect(authorization.uploadUrl).toBe(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`,
    );
    expect(authorization.method).toBe('POST');
    expect(authorization.assetId).toBe(assetId);

    const fields = authorization.fields;
    expect(fields.public_id).toBe(assetId);
    expect(fields.api_key).toBe(API_KEY);
    expect(fields.timestamp).toMatch(/^\d+$/);
    expect(fields.signature).toMatch(/^[0-9a-f]{40}$/);
    // `overwrite=false` is signed so Cloudinary never replaces an existing
    // asset, which protects a completed video from a reused older signature.
    expect(fields.overwrite).toBe('false');

    // The provider secret must never be part of the browser payload.
    expect(fields.api_secret).toBeUndefined();
    expect(JSON.stringify(fields)).not.toContain(API_SECRET);

    // Cloudinary SHA-1 signature: sorted key=value pairs + API secret.
    const expectedSignature = crypto
      .createHash('sha1')
      .update(
        `overwrite=false&public_id=${fields.public_id}&timestamp=${fields.timestamp}${API_SECRET}`,
      )
      .digest('hex');
    expect(fields.signature).toBe(expectedSignature);

    // Cloudinary enforces this window; it cannot be shortened.
    const expectedExpiryMs =
      (Number(fields.timestamp) + CLOUDINARY_TTL_SECONDS) * 1000;
    expect(authorization.expiresAt.getTime()).toBe(expectedExpiryMs);
  });

  it('resolves a provider asset into authoritative metadata', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({
        public_id: 'education-platform/videos/abc',
        format: 'mp4',
        duration: 42.5,
        width: 1280,
        height: 720,
        bytes: 2048,
        secure_url:
          'https://res.cloudinary.com/demo-cloud/video/upload/v1/education-platform/videos/abc.mp4',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const asset = await createProvider().getAsset('education-platform/videos/abc');

    expect(asset).toMatchObject({
      exists: true,
      assetId: 'education-platform/videos/abc',
      status: 'ready',
      durationSeconds: 42.5,
      width: 1280,
      height: 720,
      format: 'mp4',
      sizeBytes: 2048,
      playbackUrl:
        'https://res.cloudinary.com/demo-cloud/video/upload/v1/education-platform/videos/abc.mp4',
      thumbnailUrl:
        'https://res.cloudinary.com/demo-cloud/video/upload/v1/education-platform/videos/abc.jpg',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toContain(
      `/resources/video/upload/${encodeURIComponent('education-platform/videos/abc')}`,
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64')}`,
    );
  });

  it('treats a missing provider asset as not found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({}, 404)));

    const asset = await createProvider().getAsset('missing/asset');

    expect(asset).toEqual({
      exists: false,
      assetId: 'missing/asset',
      status: 'failed',
    });
  });

  it('maps provider failures to VIDEO_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({}, 500)));

    await expect(createProvider().getAsset('broken/asset')).rejects.toMatchObject({
      statusCode: 502,
      code: VIDEO_ERRORS.VIDEO_PROVIDER_ERROR,
    });
  });

  it('builds a playback reference only for a playable asset', () => {
    const provider = createProvider();
    const asset: ProviderAssetInfo = {
      exists: true,
      assetId: 'abc',
      status: 'ready',
      playbackUrl: 'https://res.cloudinary.com/demo-cloud/video/upload/abc.mp4',
    };

    expect(provider.buildPlaybackReference(asset)).toEqual({
      provider: 'cloudinary',
      assetId: 'abc',
      url: 'https://res.cloudinary.com/demo-cloud/video/upload/abc.mp4',
    });

    expect(() =>
      provider.buildPlaybackReference({
        exists: true,
        assetId: 'abc',
        status: 'ready',
      }),
    ).toThrow();
  });

  it('signs every authorization with overwrite disabled', async () => {
    const provider = createProvider();
    const assetId = 'education-platform/videos/abc';

    const first = await provider.createUploadAuthorization({
      videoId: '664f00000000000000000001',
      ownerId: '664e00000000000000000002',
      assetId,
    });
    const second = await provider.createUploadAuthorization({
      videoId: '664f00000000000000000001',
      ownerId: '664e00000000000000000002',
      assetId,
    });

    // A reused signed payload can never overwrite a completed asset.
    expect(first.fields.overwrite).toBe('false');
    expect(second.fields.overwrite).toBe('false');
  });

  it('deletes assets through the Admin API bulk endpoint by public id', async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({ deleted: { 'education-platform/videos/abc': 'deleted' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await createProvider().deleteAsset('education-platform/videos/abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/resources/video/upload`,
    );
    expect(init.method).toBe('DELETE');
    expect(init.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64')}`,
    );
    expect(new URLSearchParams(init.body).get('public_ids[]')).toBe(
      'education-platform/videos/abc',
    );
  });

  it('surfaces provider deletion failures instead of silently succeeding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({}, 404)));

    await expect(
      createProvider().deleteAsset('missing/asset'),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: VIDEO_ERRORS.VIDEO_PROVIDER_ERROR,
    });
  });
});

describe('UnconfiguredVideoProvider', () => {
  it('fails closed instead of faking uploads', async () => {
    const provider = new UnconfiguredVideoProvider();

    expect(provider.isConfigured()).toBe(false);

    await expect(
      provider.createUploadAuthorization({
        videoId: 'v',
        ownerId: 'o',
        assetId: 'a',
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: VIDEO_ERRORS.VIDEO_PROVIDER_NOT_CONFIGURED,
    });

    await expect(provider.getAsset('a')).rejects.toMatchObject({
      statusCode: 503,
      code: VIDEO_ERRORS.VIDEO_PROVIDER_NOT_CONFIGURED,
    });

    expect(() =>
      provider.buildPlaybackReference({ exists: false, assetId: 'a', status: 'failed' }),
    ).toThrow();
  });
});
