import { Router } from 'express';
import { requireAuth, validate } from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { CoursePlayerController } from './course-player.controller.js';
import {
  coursePlayerService,
  type CoursePlayerService,
} from './course-player.service.js';
import { coursePlayerLessonParamSchema } from './course-player.validation.js';

/**
 * Protected Course Player routes.
 *
 * Mounted at `/api/courses`, the same prefix as the anonymous public catalog
 * and the student enrollment routes. Authentication is applied per route, not
 * with `router.use`, so unmatched catalog requests continue to be public.
 *
 * The router accepts a service so tests can inject fakes.
 */
export function createCoursePlayerRouter(
  service: CoursePlayerService = coursePlayerService,
): Router {
  const controller = new CoursePlayerController(service);
  const router = Router();

  router.get(
    '/:courseId/lessons/:lessonId',
    asyncHandler(requireAuth),
    validate({ params: coursePlayerLessonParamSchema }),
    asyncHandler(controller.getLesson),
  );

  return router;
}

export const coursePlayerRoutes = createCoursePlayerRouter();
