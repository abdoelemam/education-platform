import { Router } from 'express';
import {
  requireApprovedTeacher,
  requireAuth,
  requireRole,
  validate,
} from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { EnrollmentController } from './enrollment.controller.js';
import { enrollmentService, type EnrollmentService } from './enrollment.service.js';
import {
  enrollmentCourseParamSchema,
  enrollmentListQuerySchema,
} from './enrollment.validation.js';

/**
 * Teacher roster routes.
 *
 * Mounted at `/api/teacher/courses/:courseId/enrollments` with
 * `mergeParams`, so the course id is validated like every other teacher route.
 * The service enforces ownership (admin bypass), and the middleware enforces
 * authentication, role and teacher-approval status.
 */
export function createTeacherEnrollmentRouter(
  service: EnrollmentService = enrollmentService,
): Router {
  const controller = new EnrollmentController(service);
  const router = Router({ mergeParams: true });

  router.use(
    asyncHandler(requireAuth),
    requireRole('teacher', 'admin'),
    requireApprovedTeacher,
  );

  router.get(
    '/',
    validate({
      params: enrollmentCourseParamSchema,
      query: enrollmentListQuerySchema,
    }),
    asyncHandler(controller.listCourseEnrollments),
  );

  return router;
}

export const teacherEnrollmentRoutes = createTeacherEnrollmentRouter();
