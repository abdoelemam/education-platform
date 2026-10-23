import { Router } from 'express';
import {
  requireAuth,
  requireRole,
  validate,
  verifyCsrfToken,
} from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { CourseController } from './course.controller.js';
import { courseService, type CourseService } from './course.service.js';
import {
  assignCourseCategorySchema,
  courseIdParamSchema,
  listReviewCoursesQuerySchema,
  rejectCourseSchema,
} from './course.validation.js';

/**
 * Admin course moderation routes.
 *
 * Mounted at `/api/admin/courses`. Only admins may list submissions, inspect a
 * submitted course, approve it or reject it with a reason. State-changing
 * routes require a valid CSRF token.
 *
 * The router accepts a service so tests can inject fakes.
 */
export function createAdminCourseRouter(
  service: CourseService = courseService,
): Router {
  const controller = new CourseController(service);
  const router = Router();

  // Authentication + authorization for the whole router.
  router.use(asyncHandler(requireAuth), requireRole('admin'));

  router.get(
    '/',
    validate({ query: listReviewCoursesQuerySchema }),
    asyncHandler(controller.listForReview),
  );

  router.get(
    '/:courseId',
    validate({ params: courseIdParamSchema }),
    asyncHandler(controller.getForReview),
  );

  router.post(
    '/:courseId/approve',
    verifyCsrfToken,
    validate({ params: courseIdParamSchema }),
    asyncHandler(controller.approve),
  );

  router.post(
    '/:courseId/reject',
    verifyCsrfToken,
    validate({ params: courseIdParamSchema, body: rejectCourseSchema }),
    asyncHandler(controller.reject),
  );

  // Category-only repair for an approved but unpublished course. This is not a
  // general edit endpoint and cannot change content, status, or publish state.
  router.patch(
    '/:courseId/category',
    verifyCsrfToken,
    validate({
      params: courseIdParamSchema,
      body: assignCourseCategorySchema,
    }),
    asyncHandler(controller.assignCategory),
  );

  return router;
}

export const adminCourseRoutes = createAdminCourseRouter();
