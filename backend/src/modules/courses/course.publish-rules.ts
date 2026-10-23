import {
  COURSE_PRICE_MINOR_MAX,
  COURSE_PUBLISH_ISSUES,
  type CoursePublishIssue,
} from './course.constants.js';
import type {
  ICourse,
  LessonDocument,
  SectionDocument,
} from './course.types.js';
import { COURSE_LEVELS } from './course.types.js';
import { isValidCurrency, isValidHttpUrl, isValidLanguage } from './course.validators.js';

/**
 * Readiness snapshot for a referenced video. Only the fields needed to decide
 * whether a video lesson can be published are accepted, so the rules stay
 * independent from the Video module's full document.
 */
export interface PublishVideoState {
  ownerId: string;
  processingStatus: string;
  playbackUrl?: string;
}

/**
 * Visibility snapshot for the course's category reference. The service resolves
 * the category under the category tree lock and passes only what the rules need,
 * keeping this module independent from category persistence.
 */
export interface PublishCategoryState {
  /** True only when the category and every ancestor are active. */
  publiclyVisible: boolean;
}

export interface PublishReadinessInput {
  course: ICourse;
  sections: SectionDocument[];
  lessons: LessonDocument[];
  videos: ReadonlyMap<string, PublishVideoState>;
  /**
   * `null` means the referenced category no longer exists (or was never
   * committed). `undefined` is treated the same way when `categoryId` is set.
   */
  category?: PublishCategoryState | null;
}

/**
 * Collect every reason a course cannot be published.
 *
 * The function is pure and deterministic: the service loads committed sections
 * and lessons, resolves the referenced videos, and turns a non-empty result into
 * `422 COURSE_NOT_PUBLISHABLE`. Staged content is excluded by the repositories
 * before it reaches this check.
 */
export function collectPublishIssues(
  input: PublishReadinessInput,
): CoursePublishIssue[] {
  const issues = new Set<CoursePublishIssue>();
  const { course } = input;

  if (!course.categoryId) {
    issues.add(COURSE_PUBLISH_ISSUES.CATEGORY_REQUIRED);
  } else if (!input.category) {
    issues.add(COURSE_PUBLISH_ISSUES.CATEGORY_NOT_FOUND);
  } else if (!input.category.publiclyVisible) {
    issues.add(COURSE_PUBLISH_ISSUES.CATEGORY_INACTIVE);
  }

  if (!course.description || course.description.trim().length === 0) {
    issues.add(COURSE_PUBLISH_ISSUES.DESCRIPTION_REQUIRED);
  }

  if (!course.thumbnailUrl) {
    issues.add(COURSE_PUBLISH_ISSUES.THUMBNAIL_REQUIRED);
  } else if (!isValidHttpUrl(course.thumbnailUrl)) {
    issues.add(COURSE_PUBLISH_ISSUES.THUMBNAIL_INVALID);
  }

  if (!course.level) {
    issues.add(COURSE_PUBLISH_ISSUES.LEVEL_REQUIRED);
  } else if (!COURSE_LEVELS.includes(course.level)) {
    issues.add(COURSE_PUBLISH_ISSUES.LEVEL_INVALID);
  }

  if (!course.language) {
    issues.add(COURSE_PUBLISH_ISSUES.LANGUAGE_REQUIRED);
  } else if (!isValidLanguage(course.language)) {
    issues.add(COURSE_PUBLISH_ISSUES.LANGUAGE_INVALID);
  }

  if (
    !course.learningOutcomes ||
    course.learningOutcomes.length === 0 ||
    course.learningOutcomes.some((outcome) => outcome.trim().length === 0)
  ) {
    issues.add(COURSE_PUBLISH_ISSUES.LEARNING_OUTCOMES_REQUIRED);
  }

  if (course.priceMinor === undefined) {
    issues.add(COURSE_PUBLISH_ISSUES.PRICE_REQUIRED);
  } else if (
    !Number.isInteger(course.priceMinor) ||
    course.priceMinor < 0 ||
    course.priceMinor > COURSE_PRICE_MINOR_MAX
  ) {
    issues.add(COURSE_PUBLISH_ISSUES.PRICE_INVALID);
  }

  if (!course.currency) {
    issues.add(COURSE_PUBLISH_ISSUES.CURRENCY_REQUIRED);
  } else if (!isValidCurrency(course.currency)) {
    issues.add(COURSE_PUBLISH_ISSUES.CURRENCY_INVALID);
  }

  if (input.sections.length === 0) {
    issues.add(COURSE_PUBLISH_ISSUES.SECTIONS_REQUIRED);
  }

  const lessonsBySection = new Map<string, LessonDocument[]>();
  for (const lesson of input.lessons) {
    const sectionId = lesson.sectionId.toString();
    const bucket = lessonsBySection.get(sectionId);
    if (bucket) {
      bucket.push(lesson);
    } else {
      lessonsBySection.set(sectionId, [lesson]);
    }
  }

  for (const section of input.sections) {
    const lessons = lessonsBySection.get(section._id.toString()) ?? [];
    if (lessons.length === 0) {
      issues.add(COURSE_PUBLISH_ISSUES.SECTION_WITHOUT_LESSONS);
    }
  }

  for (const lesson of input.lessons) {
    switch (lesson.type) {
      case 'text': {
        if (!lesson.content || lesson.content.trim().length === 0) {
          issues.add(COURSE_PUBLISH_ISSUES.LESSON_PAYLOAD_INVALID);
        }
        break;
      }
      case 'document': {
        if (!lesson.documentUrl || !isValidHttpUrl(lesson.documentUrl)) {
          issues.add(COURSE_PUBLISH_ISSUES.LESSON_PAYLOAD_INVALID);
        }
        break;
      }
      case 'video': {
        const video = lesson.videoId
          ? input.videos.get(lesson.videoId.toString())
          : undefined;
        if (
          !video ||
          video.ownerId !== course.ownerId.toString() ||
          video.processingStatus !== 'ready' ||
          !video.playbackUrl
        ) {
          issues.add(COURSE_PUBLISH_ISSUES.VIDEO_NOT_READY);
        }
        break;
      }
      default: {
        // `quiz` lessons are reserved until the Quiz System exists, so stored
        // quiz lessons cannot be published.
        issues.add(COURSE_PUBLISH_ISSUES.LESSON_PAYLOAD_INVALID);
      }
    }
  }

  return [...issues];
}
