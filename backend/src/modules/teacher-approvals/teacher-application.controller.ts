import type { Request, Response } from 'express';
import { AppError } from '../../errors/index.js';
import { sendSuccess } from '../../utils/api-response.js';
import type { AuthUser } from '../users/user.types.js';
import {
  teacherApprovalService,
  type TeacherApprovalService,
} from './teacher-approval.service.js';

/**
 * Teacher-facing application lifecycle controller.
 *
 * Kept separate from `TeacherApprovalController` because these endpoints act on
 * the caller's own account rather than on an administrator-selected one.
 */
export class TeacherApplicationController {
  constructor(
    private readonly svc: TeacherApprovalService = teacherApprovalService,
  ) {}

  /**
   * POST /api/teacher/reapply
   */
  reapply = async (req: Request, res: Response): Promise<void> => {
    const requester = this.requireUser(req);
    const teacher = await this.svc.requestReapplication({ requester });
    sendSuccess(res, { teacher });
  };

  private requireUser(req: Request): AuthUser {
    if (!req.user) {
      throw AppError.unauthorized();
    }
    return req.user;
  }
}

export const teacherApplicationController = new TeacherApplicationController();
