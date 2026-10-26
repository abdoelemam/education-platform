import { Router } from 'express';
import {
  requireAuth,
  requireRole,
  verifyCsrfToken,
} from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { TeacherApplicationController } from './teacher-application.controller.js';
import {
  teacherApprovalService,
  type TeacherApprovalService,
} from './teacher-approval.service.js';

/**
 * Teacher application routes.
 *
 * Mounted at `/api/teacher/reapply`. Only teacher accounts reach the handler;
 * the service then re-checks that the account is currently `rejected`. Students
 * and administrators are therefore rejected by role instead of being able to
 * submit an ordinary teacher application. State-changing requests require a
 * valid CSRF token.
 */
export function createTeacherApplicationRouter(
  service: TeacherApprovalService = teacherApprovalService,
): Router {
  const controller = new TeacherApplicationController(service);
  const router = Router();

  router.use(asyncHandler(requireAuth), requireRole('teacher'));

  router.post('/', verifyCsrfToken, asyncHandler(controller.reapply));

  return router;
}

export const teacherApplicationRoutes = createTeacherApplicationRouter();
