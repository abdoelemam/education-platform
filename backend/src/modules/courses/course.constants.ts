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
} as const;

export type CourseErrorCode = (typeof COURSE_ERRORS)[keyof typeof COURSE_ERRORS];

export const COURSE_PAGE_DEFAULT_LIMIT = 20;
export const COURSE_PAGE_MAX_LIMIT = 100;

export const COURSE_TITLE_MAX = 200;
export const COURSE_DESCRIPTION_MAX = 5000;
export const COURSE_SLUG_MAX = 80;

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
