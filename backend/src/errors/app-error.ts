/**
 * Custom application error class.
 *
 * Used for all known/expected errors in the application.
 * The global error middleware uses this to produce standardized JSON responses.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;

    // Preserve proper stack trace
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Factory: 400 Bad Request
   */
  static badRequest(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  /**
   * Factory: 401 Unauthorized
   */
  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  /**
   * Factory: 403 Forbidden
   */
  static forbidden(message = 'Access denied'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }

  /**
   * Factory: 404 Not Found
   */
  static notFound(resource = 'Resource'): AppError {
    return new AppError(404, 'NOT_FOUND', `${resource} not found`);
  }

  /**
   * Factory: 409 Conflict
   */
  static conflict(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(409, 'CONFLICT', message, details);
  }

  /**
   * Factory: 422 Validation Error
   */
  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(422, 'VALIDATION_ERROR', message, details);
  }

  /**
   * Factory: 429 Too Many Requests
   */
  static tooManyRequests(message = 'Too many requests'): AppError {
    return new AppError(429, 'TOO_MANY_REQUESTS', message);
  }

  /**
   * Factory: 500 Internal Server Error
   */
  static internal(message = 'Internal server error'): AppError {
    return new AppError(500, 'INTERNAL_ERROR', message);
  }
}
