import type { Request, Response, NextFunction } from 'express';
import { type ZodError, type ZodSchema } from 'zod';
import { sendError } from '../utils/api-response.js';

/**
 * Schema targets for request validation.
 */
interface ValidationSchemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

/**
 * Format Zod errors into a clean details object.
 */
function formatZodErrors(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    if (!details[path]) {
      details[path] = [];
    }
    details[path].push(issue.message);
  }

  return details;
}

/**
 * Validation middleware factory.
 *
 * Validates request body, params, and/or query using Zod schemas.
 * Returns standardized 422 error on validation failure.
 *
 * Usage:
 *   router.post('/path', validate({ body: createCourseSchema }), controller.create);
 */
export function validate(schemas: ValidationSchemas) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const errors: Record<string, Record<string, string[]>> = {};

    if (schemas.body) {
      const result = schemas.body.safeParse(req.body);
      if (!result.success) {
        errors.body = formatZodErrors(result.error);
      } else {
        req.body = result.data;
      }
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(req.params);
      if (!result.success) {
        errors.params = formatZodErrors(result.error);
      } else {
        Object.defineProperty(req, 'params', {
          value: result.data,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }

    if (schemas.query) {
      const result = schemas.query.safeParse(req.query);
      if (!result.success) {
        errors.query = formatZodErrors(result.error);
      } else {
        Object.defineProperty(req, 'query', {
          value: result.data,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }

    if (Object.keys(errors).length > 0) {
      sendError(res, 422, 'VALIDATION_ERROR', 'Validation failed', errors);
      return;
    }

    next();
  };
}
