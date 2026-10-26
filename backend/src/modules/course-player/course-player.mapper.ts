import type {
  CourseDocument,
  LessonDocument,
  SectionDocument,
} from '../courses/course.types.js';
import type { VideoDocument } from '../videos/video.types.js';
import type {
  CoursePlayerLessonView,
  PlayerLesson,
  PlayerLessonReference,
  PlayerNavigation,
} from './course-player.types.js';

/**
 * Map an adjacent lesson to the minimal navigation reference. The player only
 * needs enough information to render a control and request the next lesson.
 */
export function toPlayerLessonReference(
  lesson: LessonDocument,
): PlayerLessonReference {
  return {
    lessonId: lesson._id.toString(),
    sectionId: lesson.sectionId.toString(),
    title: lesson.title,
    type: lesson.type,
  };
}

/**
 * Map the current lesson and its type-specific payload.
 *
 * The service validates that the payload exists and that a video is ready and
 * owned by the course owner before this mapper runs. The explicit checks here
 * keep the mapper safe if it is reused without that validation.
 */
export function toPlayerLesson(
  lesson: LessonDocument,
  video?: VideoDocument,
): PlayerLesson {
  const base: PlayerLesson = {
    id: lesson._id.toString(),
    title: lesson.title,
    description: lesson.description,
    type: lesson.type,
    order: lesson.order,
  };

  switch (lesson.type) {
    case 'text': {
      if (!lesson.content) {
        throw new Error('Text lesson content is missing');
      }
      return { ...base, text: { content: lesson.content } };
    }
    case 'document': {
      if (!lesson.documentUrl) {
        throw new Error('Document lesson URL is missing');
      }
      return {
        ...base,
        document: {
          url: lesson.documentUrl,
          name: lesson.documentName,
        },
      };
    }
    case 'video': {
      if (!video?.playbackUrl) {
        throw new Error('Video playback data is missing');
      }
      return {
        ...base,
        video: {
          playbackUrl: video.playbackUrl,
          durationSeconds: video.durationSeconds,
          thumbnailUrl: video.thumbnailUrl,
        },
      };
    }
    default:
      throw new Error(`Unsupported lesson type: ${lesson.type}`);
  }
}

export function toCoursePlayerLessonView(params: {
  course: CourseDocument;
  section: SectionDocument;
  lesson: LessonDocument;
  video?: VideoDocument;
  navigation: PlayerNavigation;
}): CoursePlayerLessonView {
  return {
    course: {
      id: params.course._id.toString(),
      title: params.course.title,
      slug: params.course.slug,
    },
    section: {
      id: params.section._id.toString(),
      title: params.section.title,
      order: params.section.order,
    },
    lesson: toPlayerLesson(params.lesson, params.video),
    navigation: params.navigation,
  };
}
