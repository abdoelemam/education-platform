/**
 * Stable error codes for the Category module.
 * Mirrors the COURSE_ERRORS / AUTH_ERRORS convention.
 */
export const CATEGORY_ERRORS = {
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  CATEGORY_PARENT_NOT_FOUND: 'CATEGORY_PARENT_NOT_FOUND',
  CATEGORY_CYCLE: 'CATEGORY_CYCLE',
  CATEGORY_MAX_DEPTH: 'CATEGORY_MAX_DEPTH',
  CATEGORY_HAS_CHILDREN: 'CATEGORY_HAS_CHILDREN',
  CATEGORY_IN_USE: 'CATEGORY_IN_USE',
  CATEGORY_BUSY: 'CATEGORY_BUSY',
} as const;

export type CategoryErrorCode =
  (typeof CATEGORY_ERRORS)[keyof typeof CATEGORY_ERRORS];

export const CATEGORY_NAME_MIN = 2;
export const CATEGORY_NAME_MAX = 100;
export const CATEGORY_DESCRIPTION_MAX = 1000;
export const CATEGORY_SLUG_MAX = 100;
export const CATEGORY_SORT_ORDER_MAX = 100_000;

/**
 * Maximum root-to-node depth. Roots have depth 0. The cap keeps recursive
 * traversal bounded and prevents pathological trees.
 */
export const CATEGORY_MAX_DEPTH = 10;

/** How many slug suffixes are attempted before falling back to a random slug. */
export const CATEGORY_SLUG_MAX_ATTEMPTS = 20;

/** Short-lived lease serializing category-tree mutations. */
export const CATEGORY_LOCK_ID = 'category-tree';
export const CATEGORY_LOCK_TTL_MS = 30_000;
