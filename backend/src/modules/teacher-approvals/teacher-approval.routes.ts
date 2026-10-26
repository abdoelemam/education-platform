import { Router } from 'express';
import {
  requireAuth,
  requireRole,
  validate,
  verifyCsrfToken,
} from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { TeacherApprovalController } from './teacher-approval.controller.js';
import {
  teacherApprovalService,
  type TeacherApprovalService,
} from './teacher-approval.service.js';
import {
  listTeacherApplicationsQuerySchema,
  rejectTeacherApplicationSchema,
  teacherIdParamSchema,
} from './teacher-approval.validation.js';

/**
 * Admin teacher-approval routes.
 *
 * Mounted at `/api/admin/teachers`. Only administrators may list applications,
 * inspect a teacher profile, approve it or reject it with a reason. Mutating
 * routes require a valid CSRF token.
 */
export function createAdminTeacherRouter(
  service: TeacherApprovalService = teacherApprovalService,
): Router {
  const controller = new TeacherApprovalController(service);
  const router = Router();

  router.use(asyncHandler(requireAuth), requireRole('admin'));

  router.get(
    '/',
    validate({ query: listTeacherApplicationsQuerySchema }),
    asyncHandler(controller.list),
  );

  router.get(
    '/:teacherId',
    validate({ params: teacherIdParamSchema }),
    asyncHandler(controller.get),
  );

  router.post(
    '/:teacherId/approve',
    verifyCsrfToken,
    validate({ params: teacherIdParamSchema }),
    asyncHandler(controller.approve),
  );

  router.post(
    '/:teacherId/reject',
    verifyCsrfToken,
    validate({
      params: teacherIdParamSchema,
      body: rejectTeacherApplicationSchema,
    }),
    asyncHandler(controller.reject),
  );

  return router;
}

export const adminTeacherRoutes = createAdminTeacherRouter();
