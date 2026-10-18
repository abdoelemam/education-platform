import { z } from 'zod';
import {
  VIDEO_PAGE_DEFAULT_LIMIT,
  VIDEO_PAGE_MAX_LIMIT,
} from './video.constants.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

/**
 * Schema for creating a video metadata record (before upload).
 */
export const createVideoSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(200, 'Title cannot exceed 200 characters'),
  description: z
    .string()
    .trim()
    .max(2000, 'Description cannot exceed 2000 characters')
    .optional(),
});

export type CreateVideoInput = z.infer<typeof createVideoSchema>;

/**
 * Route parameter schema for a video id.
 */
export const videoIdParamSchema = z.object({
  videoId: z.string().regex(OBJECT_ID_PATTERN, 'Invalid video id'),
});

export type VideoIdParam = z.infer<typeof videoIdParamSchema>;

/**
 * Query schema for listing videos.
 */
export const listVideosQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(VIDEO_PAGE_MAX_LIMIT)
    .default(VIDEO_PAGE_DEFAULT_LIMIT),
});

export type ListVideosQuery = z.infer<typeof listVideosQuerySchema>;

/**
 * Body schema for upload completion.
 *
 * Intentionally accepts an empty (or absent) body: any metadata the client
 * sends (duration, status, playback URL, ...) is stripped/ignored. The backend
 * derives state from the provider.
 */
export const completeUploadSchema = z.object({}).optional();

export type CompleteUploadInput = z.infer<typeof completeUploadSchema>;
