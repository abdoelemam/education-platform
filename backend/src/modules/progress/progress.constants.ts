/**
 * Progress System constants (Roadmap Phase 9).
 */

/**
 * A video is complete once the server-recorded watched time reaches 90% of the
 * authoritative duration stored on the Video document.
 *
 * This is a heuristic, not proof of genuine watching: a client can seek or
 * report arbitrary watched time. The threshold only defines when the backend
 * considers the lesson complete; it never trusts a client `completed` flag or
 * `ended` event for video lessons.
 */
export const VIDEO_COMPLETION_THRESHOLD = 0.9;

/**
 * Lesson types whose progress is tracked in this phase.
 *
 * Quiz lessons are excluded until the Quiz System (Phase 10) exists. Publishing
 * already blocks quiz lessons, so this mainly protects legacy/direct-DB rows.
 */
export const PROGRESS_LESSON_TYPES = ['video', 'text', 'document'] as const;

/**
 * Absolute upper bound for a client-reported playback value. The authoritative
 * video duration clamps video values further; this bound only rejects absurd
 * payloads before they reach the database.
 */
export const PROGRESS_MAX_SECONDS = 7 * 24 * 60 * 60;

/** Default percent when a course has no eligible lessons. */
export const PROGRESS_EMPTY_PERCENT = 0;
