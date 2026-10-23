import { z } from 'zod';
import {
  CATEGORY_DESCRIPTION_MAX,
  CATEGORY_NAME_MAX,
  CATEGORY_NAME_MIN,
  CATEGORY_SORT_ORDER_MAX,
} from './category.constants.js';

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const objectId = (label: string) =>
  z
    .string()
    .regex(OBJECT_ID_PATTERN, `Invalid ${label}`)
    // Mongo ObjectIds are case-insensitive; normalize once at the boundary so
    // every textual comparison and stored parent reference uses lowercase hex.
    .transform((value) => value.toLowerCase());

const name = z
  .string()
  .trim()
  .min(CATEGORY_NAME_MIN, `Category name must be at least ${CATEGORY_NAME_MIN} characters`)
  .max(CATEGORY_NAME_MAX, `Category name cannot exceed ${CATEGORY_NAME_MAX} characters`);

const description = z
  .string()
  .trim()
  .max(
    CATEGORY_DESCRIPTION_MAX,
    `Category description cannot exceed ${CATEGORY_DESCRIPTION_MAX} characters`,
  );

const sortOrder = z
  .number()
  .int('Sort order must be an integer')
  .min(0, 'Sort order cannot be negative')
  .max(CATEGORY_SORT_ORDER_MAX, `Sort order cannot exceed ${CATEGORY_SORT_ORDER_MAX}`);

export const categoryIdParamSchema = z.object({
  categoryId: objectId('category id'),
});

export type CategoryIdParam = z.infer<typeof categoryIdParamSchema>;

export const createCategorySchema = z
  .object({
    name,
    description: description.optional(),
    parentId: objectId('parent category id').nullable().optional(),
    // `isActive` is an intentional admin field: creating an inactive category
    // is part of the existing API contract.
    isActive: z.boolean().optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: name.optional(),
    description: description.nullable().optional(),
    parentId: objectId('parent category id').nullable().optional(),
    // `isActive` is an intentional admin field; deactivating a branch is part
    // of the existing API contract.
    isActive: z.boolean().optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
