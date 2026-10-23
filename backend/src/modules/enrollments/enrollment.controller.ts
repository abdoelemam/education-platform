import type { Request, Response } from 'express';
import { AppError } from '../../errors/index.js';
import { sendPaginated, sendSuccess } from '../../utils/api-response.js';
import type { AuthUser } from '../users/user.types.js';
import { enrollmentService, type EnrollmentService } from './enrollment.service.js';
import type {
  EnrollmentCourseParam,
  EnrollmentListQuery,
} from './enrollment.validation.js';

export class EnrollmentController {
  constructor(private readonly svc: EnrollmentService = enrollmentService) {}

  /**
   * POST /api/courses/:courseId/enroll
   *
   * Returns 201 when the enrollment was created and 200 when it already
   * existed (idempotent duplicate requests, including concurrent ones).
   */
  enroll = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as EnrollmentCourseParam;

    const result = await this.svc.enroll({ courseId, requester: user });
    sendSuccess(
      res,
      {
        enrollment: result.enrollment,
        created: result.created,
        hasAccess: result.hasAccess,
      },
      result.created ? 201 : 200,
    );
  };

  /**
   * GET /api/courses/:courseId/enrollment
   */
  getStatus = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as EnrollmentCourseParam;

    const status = await this.svc.getEnrollmentStatus({
      courseId,
      requester: user,
    });
    sendSuccess(res, status);
  };

  /**
   * GET /api/my-courses
   */
  listMyCourses = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const query = req.query as unknown as EnrollmentListQuery;

    const result = await this.svc.listMyCourses({
      studentId: user.id,
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
   * GET /api/teacher/courses/:courseId/enrollments
   */
  listCourseEnrollments = async (
    req: Request,
    res: Response,
  ): Promise<void> => {
    const user = this.requireUser(req);
    const { courseId } = req.params as unknown as EnrollmentCourseParam;
    const query = req.query as unknown as EnrollmentListQuery;

    const result = await this.svc.listCourseEnrollments({
      courseId,
      requester: user,
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

  private requireUser(req: Request): AuthUser {
    if (!req.user) {
      throw AppError.unauthorized();
    }

    return req.user;
  }
}

export const enrollmentController = new EnrollmentController();
