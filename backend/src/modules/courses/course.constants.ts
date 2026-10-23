import type { CourseStatus } from './course.types.js';

/**
 * Stable error codes for the Course Builder module.
 * Mirrors the AUTH_ERRORS / VIDEO_ERRORS convention so clients can branch on
 * `error.code`.
 */
export const COURSE_ERRORS = {
  COURSE_NOT_FOUND: 'COURSE_NOT_FOUND',
  COURSE_FORBIDDEN: 'COURSE_FORBIDDEN',
  SECTION_NOT_FOUND: 'SECTION_NOT_FOUND',
  LESSON_NOT_FOUND: 'LESSON_NOT_FOUND',
  LESSON_TYPE_UNSUPPORTED: 'LESSON_TYPE_UNSUPPORTED',
  LESSON_PAYLOAD_REQUIRED: 'LESSON_PAYLOAD_REQUIRED',
  LESSON_VIDEO_NOT_FOUND: 'LESSON_VIDEO_NOT_FOUND',
  LESSON_VIDEO_FORBIDDEN: 'LESSON_VIDEO_FORBIDDEN',
  INVALID_REORDER: 'INVALID_REORDER',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  COURSE_NOT_EDITABLE: 'COURSE_NOT_EDITABLE',
  COURSE_NOT_DELETABLE: 'COURSE_NOT_DELETABLE',
  COURSE_EDIT_IN_PROGRESS: 'COURSE_EDIT_IN_PROGRESS',
  COURSE_NOT_PUBLISHABLE: 'COURSE_NOT_PUBLISHABLE',
  COURSE_NOT_APPROVABLE: 'COURSE_NOT_APPROVABLE',
  COURSE_CATEGORY_NOT_FOUND: 'COURSE_CATEGORY_NOT_FOUND',
  COURSE_CATEGORY_INACTIVE: 'COURSE_CATEGORY_INACTIVE',
  COURSE_CATEGORY_CONFLICT: 'COURSE_CATEGORY_CONFLICT',
} as const;

export type CourseErrorCode = (typeof COURSE_ERRORS)[keyof typeof COURSE_ERRORS];

export const COURSE_PAGE_DEFAULT_LIMIT = 20;
export const COURSE_PAGE_MAX_LIMIT = 100;

export const COURSE_TITLE_MAX = 200;
export const COURSE_DESCRIPTION_MAX = 5000;
export const COURSE_SLUG_MAX = 80;
export const COURSE_THUMBNAIL_URL_MAX = 2048;
export const COURSE_LANGUAGE_MAX = 11;
export const COURSE_LEARNING_OUTCOME_MAX = 200;
export const COURSE_LEARNING_OUTCOMES_MAX_COUNT = 20;
export const COURSE_REQUIREMENT_MAX = 200;
export const COURSE_REQUIREMENTS_MAX_COUNT = 20;
/** Upper bound for an integer price in the currency's minor unit. */
export const COURSE_PRICE_MINOR_MAX = 999_999_999;

export const SECTION_TITLE_MAX = 200;
export const SECTION_DESCRIPTION_MAX = 2000;

export const LESSON_TITLE_MAX = 200;
export const LESSON_DESCRIPTION_MAX = 2000;
export const LESSON_TEXT_CONTENT_MAX = 20000;
export const LESSON_DOCUMENT_URL_MAX = 2048;

/**
 * How many slug suffixes are attempted before falling back to a random suffix.
 * Protects against pathological title collisions without looping forever.
 */
export const COURSE_SLUG_MAX_ATTEMPTS = 20;

export const COURSE_REJECTION_REASON_MAX = 1000;

/**
 * Explicit lifecycle state machine.
 *
 * - `draft`     → `pending_review` (owner submission)
 * - `rejected`  → `pending_review` (owner fixes and resubmits)
 * - `pending_review` → `approved` / `rejected` (admin review)
 * - `approved`  → `published` (owner publishing, after completeness validation)
 *
 * Archiving remains a later phase.
 */
export const COURSE_STATUS_TRANSITIONS: Record<
  CourseStatus,
  readonly CourseStatus[]
> = {
  draft: ['pending_review'],
  pending_review: ['approved', 'rejected'],
  approved: ['published'],
  rejected: ['pending_review'],
  published: [],
  archived: [],
};

/**
 * Machine-readable reasons a course cannot be published. Returned in
 * `error.details.reasons` so clients can point the teacher at the missing
 * requirements without parsing prose.
 */
export const COURSE_PUBLISH_ISSUES = {
  CATEGORY_REQUIRED: 'CATEGORY_REQUIRED',
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  CATEGORY_INACTIVE: 'CATEGORY_INACTIVE',
  DESCRIPTION_REQUIRED: 'DESCRIPTION_REQUIRED',
  THUMBNAIL_REQUIRED: 'THUMBNAIL_REQUIRED',
  THUMBNAIL_INVALID: 'THUMBNAIL_INVALID',
  LEVEL_REQUIRED: 'LEVEL_REQUIRED',
  LEVEL_INVALID: 'LEVEL_INVALID',
  LANGUAGE_REQUIRED: 'LANGUAGE_REQUIRED',
  LANGUAGE_INVALID: 'LANGUAGE_INVALID',
  LEARNING_OUTCOMES_REQUIRED: 'LEARNING_OUTCOMES_REQUIRED',
  PRICE_REQUIRED: 'PRICE_REQUIRED',
  PRICE_INVALID: 'PRICE_INVALID',
  CURRENCY_REQUIRED: 'CURRENCY_REQUIRED',
  CURRENCY_INVALID: 'CURRENCY_INVALID',
  SECTIONS_REQUIRED: 'SECTIONS_REQUIRED',
  SECTION_WITHOUT_LESSONS: 'SECTION_WITHOUT_LESSONS',
  LESSON_PAYLOAD_INVALID: 'LESSON_PAYLOAD_INVALID',
  VIDEO_NOT_READY: 'VIDEO_NOT_READY',
} as const;

export type CoursePublishIssue =
  (typeof COURSE_PUBLISH_ISSUES)[keyof typeof COURSE_PUBLISH_ISSUES];

/**
 * Statuses in which the owner may change content. Editing is frozen once a
 * course is submitted so an admin reviews exactly the version that was sent;
 * a rejected course becomes editable again for the next submission.
 */
export const COURSE_EDITABLE_STATUSES: readonly CourseStatus[] = [
  'draft',
  'rejected',
];

/**
 * Only untouched drafts and rejected submissions may be deleted. A course that
 * is under review or has been approved must be preserved: deleting it would
 * silently withdraw a submission or remove reviewed content. Pending courses
 * must be rejected by an admin before cleanup; an explicit withdraw flow is a
 * future feature.
 */
export const COURSE_DELETABLE_STATUSES: readonly CourseStatus[] = [
  'draft',
  'rejected',
];

/**
 * A content-edit lease older than this is treated as abandoned (for example,
 * after a process crash) and may be cleared by a later request. Normal content
 * writes finish far below this threshold.
 */
export const COURSE_EDIT_LOCK_TTL_MS = 5 * 60 * 1000;
