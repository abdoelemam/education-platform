import type { LessonDocument } from '../courses/course.types.js';
import type {
  CourseProgressSummary,
  CourseProgressView,
  LessonProgressLike,
  LessonProgressView,
  ProgressLessonType,
} from './progress.types.js';

/** Map a stored progress row to its display-safe view. */
export function toLessonProgressView(
  row: LessonProgressLike,
): LessonProgressView {
  return {
    lessonId: row.lessonId.toString(),
    sectionId: row.sectionId.toString(),
    lessonType: row.lessonType,
    watchedSeconds: row.watchedSeconds,
    durationSeconds: row.durationSeconds,
    lastPositionSeconds: row.lastPositionSeconds,
    completed: row.completed,
    completedAt: row.completedAt?.toISOString(),
  };
}

/** View for an eligible lesson with no stored progress yet. */
export function toEmptyLessonProgressView(
  lesson: LessonDocument,
): LessonProgressView {
  return {
    lessonId: lesson._id.toString(),
    sectionId: lesson.sectionId.toString(),
    lessonType: lesson.type as ProgressLessonType,
    watchedSeconds: 0,
    lastPositionSeconds: 0,
    completed: false,
  };
}

/**
 * Count completed eligible lessons.
 *
 * Only lessons that are currently committed and progress-eligible count toward
 * the denominator. Stale progress rows for removed/ineligible lessons are
 * ignored so a course cannot appear complete because of deleted content.
 */
export function summarizeCourseProgress(
  eligibleLessons: LessonDocument[],
  rows: LessonProgressLike[],
): CourseProgressSummary {
  const eligibleIds = new Set(
    eligibleLessons.map((lesson) => lesson._id.toString()),
  );
  const completedLessons = rows.filter(
    (row) => row.completed && eligibleIds.has(row.lessonId.toString()),
  ).length;
  const totalLessons = eligibleLessons.length;
  const percent =
    totalLessons === 0
      ? 0
      : Math.round((completedLessons / totalLessons) * 100);

  return { completedLessons, totalLessons, percent };
}

/** Build the full course progress view for one student. */
export function toCourseProgressView(params: {
  courseId: string;
  eligibleLessons: LessonDocument[];
  rows: LessonProgressLike[];
}): CourseProgressView {
  const eligibleIds = new Set(
    params.eligibleLessons.map((lesson) => lesson._id.toString()),
  );
  const relevant = params.rows.filter((row) =>
    eligibleIds.has(row.lessonId.toString()),
  );
  const byLesson = new Map(
    relevant.map((row) => [row.lessonId.toString(), row] as const),
  );
  const current = [...relevant].sort(
    (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
  )[0];

  return {
    courseId: params.courseId,
    ...summarizeCourseProgress(params.eligibleLessons, params.rows),
    currentLessonId: current ? current.lessonId.toString() : null,
    lessons: params.eligibleLessons.map((lesson) => {
      const row = byLesson.get(lesson._id.toString());
      return row ? toLessonProgressView(row) : toEmptyLessonProgressView(lesson);
    }),
  };
}
