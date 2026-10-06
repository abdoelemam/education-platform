import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config/index.js';
import {
  globalErrorHandler,
  requestLogger,
  notFoundHandler,
} from './middleware/index.js';
import { healthRoutes } from './modules/health/index.js';

/**
 * Create and configure the Express application.
 *
 * Separated from server startup so the app can be tested independently.
 */
export function createApp(): express.Express {
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
  // Body parsing
  // ---------------------------------------------------------------------------
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ---------------------------------------------------------------------------
  // Request logging
  // ---------------------------------------------------------------------------
  app.use(requestLogger);

  // ---------------------------------------------------------------------------
  // API Routes
  // ---------------------------------------------------------------------------
  // All API routes are prefixed with /api
  app.use('/api', healthRoutes);

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
