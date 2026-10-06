import type { Response } from 'express';

/**
 * Standardized API response types matching the project specification.
 */

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiListResponse<T> {
  success: true;
  data: T[];
  meta: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Send a standard success response.
 */
export function sendSuccess<T>(res: Response, data: T, statusCode = 200): void {
  const body: ApiSuccessResponse<T> = {
    success: true,
    data,
  };
  res.status(statusCode).json(body);
}

/**
 * Send a standard paginated list response.
 */
export function sendPaginated<T>(
  res: Response,
  data: T[],
  meta: PaginationMeta,
  statusCode = 200,
): void {
  const body: ApiListResponse<T> = {
    success: true,
    data,
    meta,
  };
  res.status(statusCode).json(body);
}

/**
 * Send a standard error response.
 */
export function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const body: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
  res.status(statusCode).json(body);
}
