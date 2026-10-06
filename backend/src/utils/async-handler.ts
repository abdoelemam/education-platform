import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler to forward errors to Express error middleware.
 *
 * Express 5 handles async errors natively, but this wrapper provides a clear,
 * explicit pattern and works as a safety net.
 *
 * Usage:
 *   router.get('/path', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
