import { AppError } from '../../errors/index.js';
import { VIDEO_ERRORS } from '../videos/video.constants.js';
import type { VideoRepository } from '../videos/video.repository.js';
import type { VideoDocument } from '../videos/video.types.js';
import { COURSE_ERRORS } from './course.constants.js';
import type { CourseDocument, LessonDocument } from './course.types.js';

/**
 * Load the video attached to a video lesson and verify the invariants the
 * Course Player and the Progress System both depend on:
 *
 * - the lesson references a stored video;
 * - the asset belongs to the course owner, so another teacher's video is never
 *   exposed to an enrolled student;
 * - the provider has confirmed the asset is ready and has a playback URL.
 *
 * Returns `undefined` for non-video lessons. Readiness is checked before any
 * playback metadata is returned or any progress is recorded.
 */
export async function loadReadyLessonVideo(
  course: CourseDocument,
  lesson: LessonDocument,
  videoRepo: VideoRepository,
): Promise<VideoDocument | undefined> {
  if (lesson.type !== 'video') {
    return undefined;
  }

  if (!lesson.videoId) {
    throw new AppError(
      409,
      COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED,
      'This video lesson has no video attached',
    );
  }

  const video = await videoRepo.findById(lesson.videoId.toString());

  if (!video || video.ownerId.toString() !== course.ownerId.toString()) {
    // A missing or foreign video is treated as unavailable rather than
    // exposing another teacher's asset to an enrolled student.
    throw new AppError(
      404,
      COURSE_ERRORS.LESSON_VIDEO_NOT_FOUND,
      'The video for this lesson is not available',
    );
  }

  if (video.processingStatus !== 'ready' || !video.playbackUrl) {
    throw new AppError(
      409,
      VIDEO_ERRORS.VIDEO_NOT_READY,
      'This video is not ready for playback yet',
    );
  }

  return video;
}
