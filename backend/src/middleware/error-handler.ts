import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/index.js';
import { sendError } from '../utils/api-response.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';

/**
 * Global error handling middleware.
 *
 * - Handles known AppErrors with proper status codes and messages.
 * - Handles Mongoose validation errors.
 * - Handles unknown/unexpected errors without leaking internals in production.
 */
export function globalErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Already sent response — nothing to do
  if (res.headersSent) {
    return;
  }

  // Known application errors
  if (err instanceof AppError) {
    logger.warn(`AppError: ${err.code} - ${err.message}`, {
      statusCode: err.statusCode,
      code: err.code,
      details: err.details,
    });

    sendError(res, err.statusCode, err.code, err.message, err.details);
    return;
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    logger.warn('Mongoose validation error', { message: err.message });
    sendError(res, 422, 'VALIDATION_ERROR', 'Validation failed', {
      message: err.message,
    });
    return;
  }

  // Mongoose CastError (e.g. invalid ObjectId)
  if (err.name === 'CastError') {
    logger.warn('Mongoose cast error', { message: err.message });
    sendError(res, 400, 'INVALID_ID', 'Invalid resource identifier');
    return;
  }

  // MongoDB duplicate key error
  if ('code' in err && (err as Record<string, unknown>).code === 11000) {
    logger.warn('MongoDB duplicate key error', { message: err.message });
    sendError(res, 409, 'DUPLICATE_KEY', 'A resource with that value already exists');
    return;
  }

  // Unexpected errors
  logger.error('Unhandled error', {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });

  const message =
    config.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error';

  sendError(res, 500, 'INTERNAL_ERROR', message);
}
