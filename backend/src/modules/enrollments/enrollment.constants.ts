/**
 * Stable error codes for the Enrollment module. Mirrors the AUTH_ERRORS /
 * COURSE_ERRORS convention so clients can branch on `error.code`.
 *
 * Not-found and ownership errors reuse the existing course codes
 * (`COURSE_NOT_FOUND`, `COURSE_FORBIDDEN`) to keep one vocabulary across the
 * course lifecycle and its student-facing flows.
 */
export const ENROLLMENT_ERRORS = {
  /**
   * The course is paid and no verified payment integration exists yet. No
   * enrollment is created. The client receives `priceMinor`/`currency` in
   * `error.details` so it can show a checkout placeholder.
   */
  PAYMENT_REQUIRED: 'ENROLLMENT_PAYMENT_REQUIRED',
} as const;

export type EnrollmentErrorCode =
  (typeof ENROLLMENT_ERRORS)[keyof typeof ENROLLMENT_ERRORS];

export const ENROLLMENT_PAGE_DEFAULT_LIMIT = 20;
export const ENROLLMENT_PAGE_MAX_LIMIT = 100;
/**
 * Upper bound for `page`. Keeps the computed MongoDB `skip`
 * (`(page - 1) * limit`, at most 100_000_000) safely inside supported integer
 * ranges and rejects pathological values such as `1e300`.
 */
export const ENROLLMENT_PAGE_MAX = 1_000_000;
