import type { Request, Response } from 'express';
import { AppError } from '../../errors/index.js';
import { sendSuccess } from '../../utils/api-response.js';
import type { AuthUser } from '../users/user.types.js';
import {
  progressService,
  type ProgressService,
} from './progress.service.js';
import type {
  ProgressCourseParam,
  ProgressLessonParam,
  RecordProgressBody,
} from './progress.validation.js';

export class ProgressController {
  constructor(private readonly svc: ProgressService = progressService) {}

  /**
   * PUT /api/courses/:courseId/lessons/:lessonId/progress
   */
  recordLessonProgress = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId, lessonId } = req.params as unknown as ProgressLessonParam;
    const input = req.body as RecordProgressBody;

    const progress = await this.svc.recordLessonProgress({
      courseId,
      lessonId,
      requester: user,
      input,
    });

    sendSuccess(res, progress);
  };

  /**
   * GET /api/courses/:courseId/progress
   */
  getCourseProgress = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as ProgressCourseParam;

    const progress = await this.svc.getCourseProgress({
      courseId,
      requester: user,
    });

    sendSuccess(res, progress);
  };

  /**
   * GET /api/courses/:courseId/lessons/:lessonId/progress
   */
  getLessonProgress = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId, lessonId } = req.params as unknown as ProgressLessonParam;

    const progress = await this.svc.getLessonProgress({
      courseId,
      lessonId,
      requester: user,
    });

    sendSuccess(res, progress);
  };

  private requireUser(req: Request): AuthUser {
    if (!req.user) {
      throw AppError.unauthorized();
    }

    return req.user;
  }
}

export const progressController = new ProgressController();
