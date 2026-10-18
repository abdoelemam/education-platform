import { config } from '../../../config/index.js';
import { CloudinaryVideoProvider } from './cloudinary.video-provider.js';
import { UnconfiguredVideoProvider } from './unconfigured.video-provider.js';
import type { VideoProvider } from './video-provider.interface.js';

/**
 * Build the active video provider from environment configuration.
 * Unknown or incomplete configuration resolves to the fail-closed provider.
 */
function buildVideoProvider(): VideoProvider {
  if (config.VIDEO_PROVIDER === 'cloudinary') {
    const provider = new CloudinaryVideoProvider({
      cloudName: config.CLOUDINARY_CLOUD_NAME ?? '',
      apiKey: config.CLOUDINARY_API_KEY ?? '',
      apiSecret: config.CLOUDINARY_API_SECRET ?? '',
    });

    if (provider.isConfigured()) {
      return provider;
    }
  }

  return new UnconfiguredVideoProvider();
}

let cachedProvider: VideoProvider | null = null;

/**
 * Resolve the process-wide video provider (memoized).
 * Tests inject their own provider instead of calling this.
 */
export function resolveVideoProvider(): VideoProvider {
  cachedProvider ??= buildVideoProvider();
  return cachedProvider;
}

export { CloudinaryVideoProvider } from './cloudinary.video-provider.js';
export { UnconfiguredVideoProvider } from './unconfigured.video-provider.js';
export type {
  ProviderAssetStatus,
  ProviderAssetInfo,
  VideoPlaybackReference,
  VideoProvider,
  VideoUploadAuthorization,
  VideoUploadAuthorizationRequest,
} from './video-provider.interface.js';
