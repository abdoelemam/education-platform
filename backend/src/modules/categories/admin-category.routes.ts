import { Router } from 'express';
import {
  requireAuth,
  requireRole,
  validate,
  verifyCsrfToken,
} from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { CategoryController } from './category.controller.js';
import { categoryService, type CategoryService } from './category.service.js';
import {
  categoryIdParamSchema,
  createCategorySchema,
  updateCategorySchema,
} from './category.validation.js';

/**
 * Admin category management routes.
 *
 * Mounted at `/api/admin/categories`. Every route requires an authenticated
 * admin; all state-changing routes also require a valid CSRF token. The router
 * accepts a service so tests can inject fakes when needed.
 */
export function createAdminCategoryRouter(
  service: CategoryService = categoryService,
): Router {
  const controller = new CategoryController(service);
  const router = Router();

  router.use(asyncHandler(requireAuth), requireRole('admin'));

  router.get('/', asyncHandler(controller.listAdmin));

  router.post(
    '/',
    verifyCsrfToken,
    validate({ body: createCategorySchema }),
    asyncHandler(controller.create),
  );

  router.get(
    '/:categoryId',
    validate({ params: categoryIdParamSchema }),
    asyncHandler(controller.getAdmin),
  );

  router.patch(
    '/:categoryId',
    verifyCsrfToken,
    validate({ params: categoryIdParamSchema, body: updateCategorySchema }),
    asyncHandler(controller.update),
  );

  router.delete(
    '/:categoryId',
    verifyCsrfToken,
    validate({ params: categoryIdParamSchema }),
    asyncHandler(controller.remove),
  );

  return router;
}

export const adminCategoryRoutes = createAdminCategoryRouter();
