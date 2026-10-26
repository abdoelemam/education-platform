import type { Request, Response } from 'express';
import { AppError } from '../../errors/index.js';
import { sendSuccess } from '../../utils/api-response.js';
import type { AuthUser } from '../users/user.types.js';
import {
  coursePlayerService,
  type CoursePlayerService,
} from './course-player.service.js';
import type { CoursePlayerLessonParam } from './course-player.validation.js';

export class CoursePlayerController {
  constructor(private readonly svc: CoursePlayerService = coursePlayerService) {}

  /**
   * GET /api/courses/:courseId/lessons/:lessonId
   */
  getLesson = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId, lessonId } = req.params as unknown as CoursePlayerLessonParam;

    const view = await this.svc.getLesson({
      courseId,
      lessonId,
      requester: user,
    });

    sendSuccess(res, view);
  };

  private requireUser(req: Request): AuthUser {
    if (!req.user) {
      throw AppError.unauthorized();
    }
    return req.user;
  }
}

export const coursePlayerController = new CoursePlayerController();
