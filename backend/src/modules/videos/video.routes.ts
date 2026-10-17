import { Router } from 'express';
import {
  requireApprovedTeacher,
  requireAuth,
  requireRole,
  validate,
  verifyCsrfToken,
} from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { VideoController } from './video.controller.js';
import { videoService, type VideoService } from './video.service.js';
import {
  completeUploadSchema,
  createVideoSchema,
  listVideosQuerySchema,
  videoIdParamSchema,
} from './video.validation.js';

/**
 * Teacher video routes.
 *
 * Mounted at `/api/teacher/videos`. Every route requires an authenticated,
 * approved teacher (admins may bypass); state-changing routes also require a
 * valid CSRF token.
 *
 * The router accepts a service so tests can inject a fake provider without
 * any network access.
 */
export function createVideoRouter(service: VideoService = videoService): Router {
  const controller = new VideoController(service);
  const router = Router();

  // Authentication + authorization for the whole router.
  router.use(
    asyncHandler(requireAuth),
    requireRole('teacher', 'admin'),
    requireApprovedTeacher,
  );

  router.post(
    '/',
    verifyCsrfToken,
    validate({ body: createVideoSchema }),
    asyncHandler(controller.create),
  );

  router.get(
    '/',
    validate({ query: listVideosQuerySchema }),
    asyncHandler(controller.list),
  );

  router.get(
    '/:videoId',
    validate({ params: videoIdParamSchema }),
    asyncHandler(controller.get),
  );

  router.get(
    '/:videoId/playback',
    validate({ params: videoIdParamSchema }),
    asyncHandler(controller.playback),
  );

  router.post(
    '/:videoId/upload-authorization',
    verifyCsrfToken,
    validate({ params: videoIdParamSchema }),
    asyncHandler(controller.requestUploadAuthorization),
  );

  router.post(
    '/:videoId/upload-complete',
    verifyCsrfToken,
    validate({ params: videoIdParamSchema, body: completeUploadSchema }),
    asyncHandler(controller.completeUpload),
  );

  router.delete(
    '/:videoId',
    verifyCsrfToken,
    validate({ params: videoIdParamSchema }),
    asyncHandler(controller.remove),
  );

  return router;
}

export const videoRoutes = createVideoRouter();
