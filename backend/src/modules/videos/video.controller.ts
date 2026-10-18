import type { Request, Response } from 'express';
import { sendSuccess, sendPaginated } from '../../utils/api-response.js';
import { AppError } from '../../errors/index.js';
import type { AuthUser } from '../users/user.types.js';
import { videoService, type VideoService } from './video.service.js';
import type {
  CreateVideoInput,
  ListVideosQuery,
  VideoIdParam,
} from './video.validation.js';

export class VideoController {
  constructor(private readonly svc: VideoService = videoService) {}

  /**
   * POST /api/teacher/videos
   */
  create = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const input = req.body as CreateVideoInput;

    const video = await this.svc.createVideo({
      ownerId: user.id,
      title: input.title,
      description: input.description,
    });

    sendSuccess(res, { video }, 201);
  };

  /**
   * GET /api/teacher/videos
   */
  list = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const query = req.query as unknown as ListVideosQuery;

    const result = await this.svc.listVideos({
      ownerId: user.id,
      page: query.page,
      limit: query.limit,
    });

    sendPaginated(res, result.items, {
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
    });
  };

  /**
   * GET /api/teacher/videos/:videoId
   */
  get = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { videoId } = req.params as unknown as VideoIdParam;

    const video = await this.svc.getVideo({ videoId, requester: user });
    sendSuccess(res, { video });
  };

  /**
   * POST /api/teacher/videos/:videoId/upload-authorization
   */
  requestUploadAuthorization = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { videoId } = req.params as unknown as VideoIdParam;

    const upload = await this.svc.authorizeUpload({ videoId, requester: user });
    sendSuccess(res, { upload });
  };

  /**
   * POST /api/teacher/videos/:videoId/upload-complete
   */
  completeUpload = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { videoId } = req.params as unknown as VideoIdParam;

    const video = await this.svc.completeUpload({ videoId, requester: user });
    sendSuccess(res, { video });
  };

  /**
   * GET /api/teacher/videos/:videoId/playback
   */
  playback = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { videoId } = req.params as unknown as VideoIdParam;

    const playback = await this.svc.getPlaybackReference({ videoId, requester: user });
    sendSuccess(res, { playback });
  };

  /**
   * DELETE /api/teacher/videos/:videoId
   */
  remove = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { videoId } = req.params as unknown as VideoIdParam;

    await this.svc.deleteVideo({ videoId, requester: user });
    sendSuccess(res, { message: 'Video deleted successfully' });
  };

  private requireUser(req: Request): AuthUser {
    if (!req.user) {
      throw AppError.unauthorized();
    }
    return req.user;
  }
}

export const videoController = new VideoController();
