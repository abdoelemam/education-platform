import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import {
  globalErrorHandler,
  requestLogger,
  notFoundHandler,
} from './middleware/index.js';
import { healthRoutes } from './modules/health/index.js';
import { authRoutes } from './modules/auth/index.js';
import { createVideoRouter } from './modules/videos/index.js';
import type { VideoService } from './modules/videos/index.js';
import {
  createCourseRouter,
  createAdminCourseRouter,
  createPublicCourseRouter,
} from './modules/courses/index.js';
import type { CourseService } from './modules/courses/index.js';
import {
  createAdminCategoryRouter,
  createPublicCategoryRouter,
} from './modules/categories/index.js';
import {
  createCourseEnrollmentRouter,
  createMyCoursesRouter,
  createTeacherEnrollmentRouter,
} from './modules/enrollments/index.js';
import type { EnrollmentService } from './modules/enrollments/index.js';
import { createCoursePlayerRouter } from './modules/course-player/index.js';
import type { CoursePlayerService } from './modules/course-player/index.js';
import {
  createAdminTeacherRouter,
  createTeacherApplicationRouter,
} from './modules/teacher-approvals/index.js';
import type { TeacherApprovalService } from './modules/teacher-approvals/index.js';

export interface CreateAppOptions {
  /**
   * Optional video service override. Used by tests to inject a fake storage
   * provider instead of contacting a real provider.
   */
  videoService?: VideoService;
  /**
   * Optional course service override. Used by tests to inject fake
   * repositories instead of touching the database directly.
   */
  courseService?: CourseService;
  /**
   * Optional enrollment service override, mirroring the course service hook for
   * tests that want to isolate enrollment logic.
   */
  enrollmentService?: EnrollmentService;
  /**
   * Optional teacher-approval service override for tests.
   */
  teacherApprovalService?: TeacherApprovalService;
  /**
   * Optional Course Player service override for tests.
   */
  coursePlayerService?: CoursePlayerService;
}

/**
 * Create and configure the Express application.
 *
 * Separated from server startup so the app can be tested independently.
 */
export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();

  // ---------------------------------------------------------------------------
  // Security middleware
  // ---------------------------------------------------------------------------
  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGIN,
      credentials: true,
    }),
  );

  // ---------------------------------------------------------------------------
  // Body and cookie parsing
  // ---------------------------------------------------------------------------
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());

  // ---------------------------------------------------------------------------
  // Request logging
  // ---------------------------------------------------------------------------
  app.use(requestLogger);

  // ---------------------------------------------------------------------------
  // API Routes
  // ---------------------------------------------------------------------------
  // All API routes are prefixed with /api
  app.use('/api', healthRoutes);
  app.use('/api/auth', authRoutes);
  // Teacher reapplication is mounted on its own path so it cannot affect the
  // authentication behavior of the other `/api/teacher/*` routers.
  app.use(
    '/api/teacher/reapply',
    createTeacherApplicationRouter(options.teacherApprovalService),
  );
  app.use('/api/teacher/videos', createVideoRouter(options.videoService));
  // Mounted before the course builder router so a roster request is handled
  // here and does not run the builder's router-level authentication twice.
  app.use(
    '/api/teacher/courses/:courseId/enrollments',
    createTeacherEnrollmentRouter(options.enrollmentService),
  );
  app.use('/api/teacher/courses', createCourseRouter(options.courseService));
  app.use(
    '/api/admin/teachers',
    createAdminTeacherRouter(options.teacherApprovalService),
  );
  app.use('/api/admin/courses', createAdminCourseRouter(options.courseService));
  app.use('/api/my-courses', createMyCoursesRouter(options.enrollmentService));
  // Enrollment routes are mounted before the public catalog. They declare
  // per-route authentication, so unmatched catalog requests fall through.
  app.use('/api/courses', createCourseEnrollmentRouter(options.enrollmentService));
  // Protected Course Player content. Authentication is declared per route so
  // the public catalog below remains anonymous.
  app.use('/api/courses', createCoursePlayerRouter(options.coursePlayerService));
  app.use('/api/courses', createPublicCourseRouter(options.courseService));
  app.use('/api/admin/categories', createAdminCategoryRouter());
  app.use('/api/categories', createPublicCategoryRouter());

  // Future module routes will be registered here:
  // app.use('/api/teacher', teacherRoutes);
  // app.use('/api/student', studentRoutes);
  // app.use('/api/payments', paymentRoutes);

  // ---------------------------------------------------------------------------
  // 404 handler (must be after all routes)
  // ---------------------------------------------------------------------------
  app.use(notFoundHandler);

  // ---------------------------------------------------------------------------
  // Global error handler (must be last)
  // ---------------------------------------------------------------------------
  app.use(globalErrorHandler);

  return app;
}
