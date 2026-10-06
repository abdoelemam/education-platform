import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/api-response.js';

/**
 * Catch-all handler for routes that don't match any defined route.
 * Must be registered after all route handlers.
 */
export function notFoundHandler(req: Request, res: Response, _next: NextFunction): void {
  sendError(
    res,
    404,
    'ROUTE_NOT_FOUND',
    `Cannot ${req.method} ${req.originalUrl}`,
  );
}
