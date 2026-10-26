import type { Request, Response } from 'express';
import { AppError } from '../../errors/index.js';
import { sendPaginated, sendSuccess } from '../../utils/api-response.js';
import type { AuthUser } from '../users/user.types.js';
import {
  teacherApprovalService,
  type TeacherApprovalService,
} from './teacher-approval.service.js';
import type {
  ListTeacherApplicationsQuery,
  RejectTeacherApplicationInput,
  TeacherIdParam,
} from './teacher-approval.validation.js';

export class TeacherApprovalController {
  constructor(
    private readonly svc: TeacherApprovalService = teacherApprovalService,
  ) {}

  /**
   * GET /api/admin/teachers
   */
  list = async (req: Request, res: Response): Promise<void> => {
    const requester = this.requireUser(req);
    const query = req.query as unknown as ListTeacherApplicationsQuery;

    const result = await this.svc.listApplications({
      requester,
      status: query.status,
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
   * GET /api/admin/teachers/:teacherId
   */
  get = async (req: Request, res: Response): Promise<void> => {
    const requester = this.requireUser(req);
    const { teacherId } = req.params as unknown as TeacherIdParam;

    const teacher = await this.svc.getApplication(teacherId, requester);
    sendSuccess(res, { teacher });
  };

  /**
   * POST /api/admin/teachers/:teacherId/approve
   */
  approve = async (req: Request, res: Response): Promise<void> => {
    const requester = this.requireUser(req);
    const { teacherId } = req.params as unknown as TeacherIdParam;

    const teacher = await this.svc.approveApplication({ requester, teacherId });
    sendSuccess(res, { teacher });
  };

  /**
   * POST /api/admin/teachers/:teacherId/reject
   */
  reject = async (req: Request, res: Response): Promise<void> => {
    const requester = this.requireUser(req);
    const { teacherId } = req.params as unknown as TeacherIdParam;
    const { reason } = req.body as RejectTeacherApplicationInput;

    const teacher = await this.svc.rejectApplication({
      requester,
      teacherId,
      rejectionReason: reason,
    });
    sendSuccess(res, { teacher });
  };

  private requireUser(req: Request): AuthUser {
    if (!req.user) {
      throw AppError.unauthorized();
    }
    return req.user;
  }
}

export const teacherApprovalController = new TeacherApprovalController();
