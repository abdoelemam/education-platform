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

export interface CreateAppOptions {
  /**
   * Optional video service override. Used by tests to inject a fake storage
   * provider instead of contacting a real provider.
   */
  videoService?: VideoService;
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
  app.use('/api/teacher/videos', createVideoRouter(options.videoService));

  // Future module routes will be registered here:
  // app.use('/api/auth', authRoutes);
  // app.use('/api/courses', courseRoutes);
  // app.use('/api/categories', categoryRoutes);
  // app.use('/api/teacher', teacherRoutes);
  // app.use('/api/student', studentRoutes);
  // app.use('/api/admin', adminRoutes);
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
