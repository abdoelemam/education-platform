import { AppError } from '../../../errors/index.js';
import { VIDEO_ERRORS } from '../video.constants.js';
import type {
  ProviderAssetInfo,
  VideoPlaybackReference,
  VideoProvider,
  VideoUploadAuthorization,
  VideoUploadAuthorizationRequest,
} from './video-provider.interface.js';

/**
 * Fail-closed provider used when no video storage provider is configured.
 *
 * It never fakes a successful upload or a fake playback URL. Every operation
 * fails with a clear 503 so a missing configuration is surfaced explicitly
 * instead of silently degrading.
 */
export class UnconfiguredVideoProvider implements VideoProvider {
  readonly name = 'unconfigured';

  isConfigured(): boolean {
    return false;
  }

  async createUploadAuthorization(
    _request: VideoUploadAuthorizationRequest,
  ): Promise<VideoUploadAuthorization> {
    return this.unavailable();
  }

  async getAsset(_assetId: string): Promise<ProviderAssetInfo> {
    return this.unavailable();
  }

  buildPlaybackReference(_asset: ProviderAssetInfo): VideoPlaybackReference {
    return this.unavailable();
  }

  private unavailable(): never {
    throw new AppError(
      503,
      VIDEO_ERRORS.VIDEO_PROVIDER_NOT_CONFIGURED,
      'No video storage provider is configured. Set VIDEO_PROVIDER and its credentials.',
    );
  }
}
