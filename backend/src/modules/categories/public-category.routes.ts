import { Router } from 'express';
import { asyncHandler } from '../../utils/async-handler.js';
import { CategoryController } from './category.controller.js';
import { categoryService, type CategoryService } from './category.service.js';

/**
 * Public category tree.
 *
 * Mounted at `/api/categories`. No authentication is required. Only active
 * categories with active ancestors are returned; management fields are never
 * exposed.
 */
export function createPublicCategoryRouter(
  service: CategoryService = categoryService,
): Router {
  const controller = new CategoryController(service);
  const router = Router();

  router.get('/', asyncHandler(controller.listPublic));

  return router;
}

export const publicCategoryRoutes = createPublicCategoryRouter();
