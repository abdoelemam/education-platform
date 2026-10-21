import { Router } from 'express';
import { validate } from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { CourseController } from './course.controller.js';
import { courseService, type CourseService } from './course.service.js';
import {
  publicCatalogQuerySchema,
  publicCourseSlugParamSchema,
} from './course.validation.js';

/**
 * Public course catalog.
 *
 * Mounted at `/api/courses`. No authentication is required, but only published
 * courses are visible. Responses are intentionally limited to catalog metadata
 * and a curriculum outline: lesson bodies, video ids and document URLs require
 * an enrollment check that belongs to later phases.
 */
export function createPublicCourseRouter(
  service: CourseService = courseService,
): Router {
  const controller = new CourseController(service);
  const router = Router();

  router.get(
    '/',
    validate({ query: publicCatalogQuerySchema }),
    asyncHandler(controller.listPublished),
  );

  router.get(
    '/:slug',
    validate({ params: publicCourseSlugParamSchema }),
    asyncHandler(controller.getPublished),
  );

  return router;
}

export const publicCourseRoutes = createPublicCourseRouter();
