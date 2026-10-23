import { Router } from 'express';
import {
  requireAuth,
  requireRole,
  validate,
  verifyCsrfToken,
} from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { EnrollmentController } from './enrollment.controller.js';
import { enrollmentService, type EnrollmentService } from './enrollment.service.js';
import {
  enrollCourseBodySchema,
  enrollmentCourseParamSchema,
  enrollmentListQuerySchema,
} from './enrollment.validation.js';

/**
 * Student enrollment routes.
 *
 * Mounted at:
 * - `/api/my-courses`                    (student's paginated course list)
 * - `/api/courses/:courseId/...`         (enroll / own enrollment status)
 *
 * Enrollment is a student action. Teachers and admins manage and inspect courses
 * through the teacher/admin endpoints; allowing them to enroll would create an
 * ambiguous second role under the single-role user model.
 */
export function createMyCoursesRouter(
  service: EnrollmentService = enrollmentService,
): Router {
  const controller = new EnrollmentController(service);
  const router = Router();

  router.use(asyncHandler(requireAuth), requireRole('student'));

  router.get(
    '/',
    validate({ query: enrollmentListQuerySchema }),
    asyncHandler(controller.listMyCourses),
  );

  return router;
}

export function createCourseEnrollmentRouter(
  service: EnrollmentService = enrollmentService,
): Router {
  const controller = new EnrollmentController(service);
  const router = Router();

  // Authentication is applied per route, not via `router.use`.
  //
  // This router is mounted at the same `/api/courses` prefix as the public
  // catalog. Router-level middleware would run for catalog requests too and
  // make the public catalog require authentication. Route-level middleware only
  // runs for the enrollment paths defined below, so unmatched requests fall
  // through to the catalog router.
  router.post(
    '/:courseId/enroll',
    asyncHandler(requireAuth),
    requireRole('student'),
    verifyCsrfToken,
    validate({
      params: enrollmentCourseParamSchema,
      body: enrollCourseBodySchema,
    }),
    asyncHandler(controller.enroll),
  );

  router.get(
    '/:courseId/enrollment',
    asyncHandler(requireAuth),
    requireRole('student'),
    validate({ params: enrollmentCourseParamSchema }),
    asyncHandler(controller.getStatus),
  );

  return router;
}

export const myCoursesRoutes = createMyCoursesRouter();
export const courseEnrollmentRoutes = createCourseEnrollmentRouter();
