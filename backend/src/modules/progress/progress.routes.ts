import { Router } from 'express';
import {
  requireAuth,
  requireRole,
  validate,
  verifyCsrfToken,
} from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { ProgressController } from './progress.controller.js';
import {
  progressService,
  type ProgressService,
} from './progress.service.js';
import {
  progressCourseParamSchema,
  progressLessonParamSchema,
  recordProgressBodySchema,
} from './progress.validation.js';

/**
 * Protected Progress routes.
 *
 * Mounted at `/api/courses`, the same prefix as the public catalog, the student
 * enrollment routes and the Course Player. Authentication is applied per route
 * (not with `router.use`) so unmatched catalog requests stay anonymous.
 *
 * Progress is a student action. Teachers and admins preview content through the
 * Course Player but cannot read or write student progress.
 */
export function createProgressRouter(
  service: ProgressService = progressService,
): Router {
  const controller = new ProgressController(service);
  const router = Router();

  router.put(
    '/:courseId/lessons/:lessonId/progress',
    asyncHandler(requireAuth),
    requireRole('student'),
    verifyCsrfToken,
    validate({
      params: progressLessonParamSchema,
      body: recordProgressBodySchema,
    }),
    asyncHandler(controller.recordLessonProgress),
  );

  router.get(
    '/:courseId/progress',
    asyncHandler(requireAuth),
    requireRole('student'),
    validate({ params: progressCourseParamSchema }),
    asyncHandler(controller.getCourseProgress),
  );

  router.get(
    '/:courseId/lessons/:lessonId/progress',
    asyncHandler(requireAuth),
    requireRole('student'),
    validate({ params: progressLessonParamSchema }),
    asyncHandler(controller.getLessonProgress),
  );

  return router;
}

export const progressRoutes = createProgressRouter();
