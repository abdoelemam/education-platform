import { Router } from 'express';
import {
  requireApprovedTeacher,
  requireAuth,
  requireRole,
  validate,
  verifyCsrfToken,
} from '../../middleware/index.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { CourseController } from './course.controller.js';
import { courseService, type CourseService } from './course.service.js';
import {
  courseIdParamSchema,
  createCourseSchema,
  createLessonSchema,
  createSectionSchema,
  lessonParamSchema,
  listCoursesQuerySchema,
  reorderLessonsSchema,
  reorderSectionsSchema,
  sectionParamSchema,
  updateCourseSchema,
  updateLessonSchema,
  updateSectionSchema,
} from './course.validation.js';

/**
 * Course Builder routes.
 *
 * Mounted at `/api/teacher/courses`. Every route requires an authenticated,
 * approved teacher (admins may bypass); state-changing routes also require a
 * valid CSRF token.
 *
 * The router accepts a service so tests can inject fakes.
 */
export function createCourseRouter(service: CourseService = courseService): Router {
  const controller = new CourseController(service);
  const router = Router();

  // Authentication + authorization for the whole router.
  router.use(
    asyncHandler(requireAuth),
    requireRole('teacher', 'admin'),
    requireApprovedTeacher,
  );

  // -------------------------------------------------------------------------
  // Course
  // -------------------------------------------------------------------------
  router.post(
    '/',
    verifyCsrfToken,
    validate({ body: createCourseSchema }),
    asyncHandler(controller.create),
  );

  router.get(
    '/',
    validate({ query: listCoursesQuerySchema }),
    asyncHandler(controller.list),
  );

  router.get(
    '/:courseId',
    validate({ params: courseIdParamSchema }),
    asyncHandler(controller.get),
  );

  router.patch(
    '/:courseId',
    verifyCsrfToken,
    validate({ params: courseIdParamSchema, body: updateCourseSchema }),
    asyncHandler(controller.update),
  );

  router.delete(
    '/:courseId',
    verifyCsrfToken,
    validate({ params: courseIdParamSchema }),
    asyncHandler(controller.remove),
  );

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------
  // Declared before the `:sectionId` routes for clarity; the methods differ, so
  // the static `reorder` segment is never captured as a section id.
  router.put(
    '/:courseId/sections/reorder',
    verifyCsrfToken,
    validate({ params: courseIdParamSchema, body: reorderSectionsSchema }),
    asyncHandler(controller.reorderSections),
  );

  router.post(
    '/:courseId/sections',
    verifyCsrfToken,
    validate({ params: courseIdParamSchema, body: createSectionSchema }),
    asyncHandler(controller.addSection),
  );

  router.patch(
    '/:courseId/sections/:sectionId',
    verifyCsrfToken,
    validate({ params: sectionParamSchema, body: updateSectionSchema }),
    asyncHandler(controller.updateSection),
  );

  router.delete(
    '/:courseId/sections/:sectionId',
    verifyCsrfToken,
    validate({ params: sectionParamSchema }),
    asyncHandler(controller.deleteSection),
  );

  // -------------------------------------------------------------------------
  // Lessons
  // -------------------------------------------------------------------------
  router.put(
    '/:courseId/sections/:sectionId/lessons/reorder',
    verifyCsrfToken,
    validate({ params: sectionParamSchema, body: reorderLessonsSchema }),
    asyncHandler(controller.reorderLessons),
  );

  router.post(
    '/:courseId/sections/:sectionId/lessons',
    verifyCsrfToken,
    validate({ params: sectionParamSchema, body: createLessonSchema }),
    asyncHandler(controller.addLesson),
  );

  router.patch(
    '/:courseId/sections/:sectionId/lessons/:lessonId',
    verifyCsrfToken,
    validate({ params: lessonParamSchema, body: updateLessonSchema }),
    asyncHandler(controller.updateLesson),
  );

  router.delete(
    '/:courseId/sections/:sectionId/lessons/:lessonId',
    verifyCsrfToken,
    validate({ params: lessonParamSchema }),
    asyncHandler(controller.deleteLesson),
  );

  return router;
}

export const courseRoutes = createCourseRouter();
