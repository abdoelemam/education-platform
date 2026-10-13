import { Router } from 'express';
import { authController } from './auth.controller.js';
import { registerSchema, loginSchema } from './auth.validation.js';
import { validate, requireAuth, verifyCsrfToken } from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';

const router = Router();

/**
 * Public routes
 */
router.post(
  '/register',
  validate({ body: registerSchema }),
  asyncHandler(authController.register),
);

router.post(
  '/login',
  validate({ body: loginSchema }),
  asyncHandler(authController.login),
);

router.post(
  '/refresh',
  verifyCsrfToken,
  asyncHandler(authController.refresh),
);

router.post(
  '/logout',
  verifyCsrfToken,
  asyncHandler(authController.logout),
);

/**
 * Protected routes
 */
router.get(
  '/me',
  asyncHandler(requireAuth),
  asyncHandler(authController.me),
);

export { router as authRoutes };
