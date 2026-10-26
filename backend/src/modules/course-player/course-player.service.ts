import { AppError } from '../../errors/index.js';
import { AUTH_ERRORS } from '../auth/auth.constants.js';
import { COURSE_ERRORS } from '../courses/course.constants.js';
import {
  courseRepository,
  type CourseRepository,
} from '../courses/course.repository.js';
import {
  lessonRepository,
  type LessonRepository,
} from '../courses/lesson.repository.js';
import {
  sectionRepository,
  type SectionRepository,
} from '../courses/section.repository.js';
import type {
  CourseDocument,
  LessonDocument,
} from '../courses/course.types.js';
import { isValidHttpUrl } from '../courses/course.validators.js';
import { canAccessCourse } from '../enrollments/enrollment.access.js';
import {
  enrollmentRepository,
  type EnrollmentRepository,
} from '../enrollments/enrollment.repository.js';
import type { AuthUser } from '../users/user.types.js';
import { VIDEO_ERRORS } from '../videos/video.constants.js';
import {
  videoRepository,
  type VideoRepository,
} from '../videos/video.repository.js';
import type { VideoDocument } from '../videos/video.types.js';
import {
  toCoursePlayerLessonView,
  toPlayerLessonReference,
} from './course-player.mapper.js';
import type {
  CoursePlayerLessonView,
  PlayerNavigation,
} from './course-player.types.js';

/**
 * Business rules for protected Course Player content.
 *
 * Every read follows the same order: load the course, authorize the requester
 * against the existing course/ownership policy, and only then resolve the
 * lesson. That order prevents unauthorized callers from probing lesson ids.
 *
 * The service deliberately reuses `canAccessCourse` for students rather than
 * defining a second enrollment predicate.
 */
export class CoursePlayerService {
  constructor(
    private readonly courseRepo: CourseRepository = courseRepository,
    private readonly sectionRepo: SectionRepository = sectionRepository,
    private readonly lessonRepo: LessonRepository = lessonRepository,
    private readonly enrollmentRepo: EnrollmentRepository = enrollmentRepository,
    private readonly videoRepo: VideoRepository = videoRepository,
  ) {}

  async getLesson(params: {
    courseId: string;
    lessonId: string;
    requester: AuthUser;
  }): Promise<CoursePlayerLessonView> {
    const course = await this.requireCourse(params.courseId);
    await this.authorizeCourse(course, params.requester);

    const lesson = await this.lessonRepo.findByCourseAndId(
      params.courseId,
      params.lessonId,
    );

    if (!lesson) {
      throw new AppError(
        404,
        COURSE_ERRORS.LESSON_NOT_FOUND,
        'Lesson not found',
      );
    }

    const section = await this.sectionRepo.findByCourseAndId(
      params.courseId,
      lesson.sectionId.toString(),
    );

    if (!section) {
      throw new AppError(
        404,
        COURSE_ERRORS.SECTION_NOT_FOUND,
        'Section not found',
      );
    }

    this.assertSupportedLesson(lesson);

    const video = await this.loadLessonVideo(course, lesson);
    const navigation = await this.buildNavigation(params.courseId, lesson);

    return toCoursePlayerLessonView({
      course,
      section,
      lesson,
      video,
      navigation,
    });
  }

  private async requireCourse(courseId: string): Promise<CourseDocument> {
    const course = await this.courseRepo.findById(courseId);

    if (!course) {
      throw new AppError(
        404,
        COURSE_ERRORS.COURSE_NOT_FOUND,
        'Course not found',
      );
    }

    return course;
  }

  /**
   * Preserve the existing access policy:
   *
   * - students need a published course and an active/completed enrollment;
   * - approved teachers may preview only their own courses;
   * - admins may inspect any course, including unpublished ones.
   *
   * A pending/rejected teacher is rejected before ownership is considered,
   * matching the Course Builder's approved-teacher requirement.
   */
  private async authorizeCourse(
    course: CourseDocument,
    requester: AuthUser,
  ): Promise<void> {
    if (requester.role === 'admin') {
      return;
    }

    if (requester.role === 'teacher') {
      if (requester.teacherStatus !== 'approved') {
        throw new AppError(
          403,
          AUTH_ERRORS.FORBIDDEN,
          'Teacher account is pending review or not approved',
        );
      }

      if (course.ownerId.toString() !== requester.id) {
        throw new AppError(
          403,
          COURSE_ERRORS.COURSE_FORBIDDEN,
          'You do not have access to this course',
        );
      }

      return;
    }

    if (requester.role === 'student') {
      // Unpublished courses are reported as missing so their existence is not
      // leaked to students. This mirrors the enrollment status endpoint.
      if (course.status !== 'published') {
        throw new AppError(
          404,
          COURSE_ERRORS.COURSE_NOT_FOUND,
          'Course not found',
        );
      }

      const enrollment = await this.enrollmentRepo.findByStudentAndCourse(
        requester.id,
        course._id.toString(),
      );

      if (!canAccessCourse(enrollment, course.status)) {
        throw new AppError(
          403,
          COURSE_ERRORS.COURSE_FORBIDDEN,
          'You do not have access to this course',
        );
      }

      return;
    }

    throw new AppError(403, AUTH_ERRORS.FORBIDDEN, 'Access denied');
  }

  /**
   * Reject lesson types the player cannot render yet and type-specific payloads
   * that are missing from stored data. Publishing validates the same payloads,
   * so these are defense-in-depth checks rather than normal request paths.
   */
  private assertSupportedLesson(lesson: LessonDocument): void {
    switch (lesson.type) {
      case 'text':
        if (!lesson.content || lesson.content.trim().length === 0) {
          throw new AppError(
            409,
            COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED,
            'This text lesson has no content',
          );
        }
        return;
      case 'document':
        if (!lesson.documentUrl) {
          throw new AppError(
            409,
            COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED,
            'This document lesson has no document',
          );
        }
        // Write-time validation and publishing already require http(s). This
        // re-check keeps legacy or directly written rows from returning an
        // unsafe scheme (for example `javascript:`) to the player.
        if (!isValidHttpUrl(lesson.documentUrl)) {
          throw new AppError(
            409,
            COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED,
            'This document lesson has an invalid document URL',
          );
        }
        return;
      case 'video':
        return;
      default:
        throw new AppError(
          409,
          COURSE_ERRORS.LESSON_TYPE_UNSUPPORTED,
          'This lesson type is not supported by the player yet',
        );
    }
  }

  /**
   * Load a video only for a video lesson and verify the same invariants the
   * publishing rules enforce: the asset belongs to the course owner, and the
   * provider has confirmed it is ready. Only a ready playback URL is exposed.
   */
  private async loadLessonVideo(
    course: CourseDocument,
    lesson: LessonDocument,
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

    const video = await this.videoRepo.findById(lesson.videoId.toString());

    if (
      !video ||
      video.ownerId.toString() !== course.ownerId.toString()
    ) {
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

  /**
   * Build previous/next references from the course's committed content only.
   * Sections define the outer order; lessons within each section are already
   * sorted by the repository.
   */
  private async buildNavigation(
    courseId: string,
    current: LessonDocument,
  ): Promise<PlayerNavigation> {
    const [sections, lessons] = await Promise.all([
      this.sectionRepo.listByCourse(courseId),
      this.lessonRepo.listByCourse(courseId),
    ]);

    const lessonsBySection = new Map<string, LessonDocument[]>();
    for (const lesson of lessons) {
      const sectionId = lesson.sectionId.toString();
      const bucket = lessonsBySection.get(sectionId);
      if (bucket) {
        bucket.push(lesson);
      } else {
        lessonsBySection.set(sectionId, [lesson]);
      }
    }

    const ordered: LessonDocument[] = [];
    for (const section of sections) {
      const bucket = lessonsBySection.get(section._id.toString());
      if (bucket) {
        ordered.push(...bucket);
      }
    }

    const index = ordered.findIndex(
      (lesson) => lesson._id.toString() === current._id.toString(),
    );
    const previous = index > 0 ? ordered[index - 1] : undefined;
    const next = index >= 0 ? ordered[index + 1] : undefined;

    return {
      previous: previous ? toPlayerLessonReference(previous) : null,
      next: next ? toPlayerLessonReference(next) : null,
    };
  }
}

export const coursePlayerService = new CoursePlayerService();
