import type { LessonType } from '../courses/course.types.js';

/**
 * Display-safe course summary returned by the Course Player.
 *
 * Only the fields the player needs to render its header/navigation are
 * included. Course management, review and edit-lease internals never appear
 * here.
 */
export interface PlayerCourseSummary {
  id: string;
  title: string;
  slug: string;
}

/**
 * Display-safe section summary for the current lesson.
 */
export interface PlayerSectionSummary {
  id: string;
  title: string;
  order: number;
}

/**
 * Minimal reference to an adjacent lesson. The player only needs enough data
 * to render a previous/next control and request the next lesson.
 */
export interface PlayerLessonReference {
  lessonId: string;
  sectionId: string;
  title: string;
  type: LessonType;
}

export interface PlayerNavigation {
  previous: PlayerLessonReference | null;
  next: PlayerLessonReference | null;
}

export interface PlayerTextContent {
  content: string;
}

export interface PlayerDocumentContent {
  url: string;
  name?: string;
}

/**
 * Playback data safe for an authorized student.
 *
 * Provider identity, provider asset ids, upload/processing state and failure
 * reasons are deliberately excluded: the browser only receives a URL that the
 * video system has already confirmed as ready.
 */
export interface PlayerVideoContent {
  playbackUrl: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
}

/**
 * The current lesson with exactly one type-specific payload.
 */
export interface PlayerLesson {
  id: string;
  title: string;
  description?: string;
  type: LessonType;
  order: number;
  text?: PlayerTextContent;
  document?: PlayerDocumentContent;
  video?: PlayerVideoContent;
}

/**
 * Full response payload for `GET /api/courses/:courseId/lessons/:lessonId`.
 */
export interface CoursePlayerLessonView {
  course: PlayerCourseSummary;
  section: PlayerSectionSummary;
  lesson: PlayerLesson;
  navigation: PlayerNavigation;
}
