import { AppError } from '../../errors/index.js';
import { COURSE_ERRORS } from '../courses/course.constants.js';
import {
  courseRepository,
  type CourseRepository,
} from '../courses/course.repository.js';
import { loadReadyLessonVideo } from '../courses/lesson-video.js';
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
  SectionDocument,
} from '../courses/course.types.js';
import { canAccessCourse } from '../enrollments/enrollment.access.js';
import {
  enrollmentRepository,
  type EnrollmentRepository,
} from '../enrollments/enrollment.repository.js';
import type { AuthUser } from '../users/user.types.js';
import {
  videoRepository,
  type VideoRepository,
} from '../videos/video.repository.js';
import type { VideoDocument } from '../videos/video.types.js';
import {
  PROGRESS_LESSON_TYPES,
  VIDEO_COMPLETION_THRESHOLD,
} from './progress.constants.js';
import {
  summarizeCourseProgress,
  toCourseProgressView,
  toEmptyLessonProgressView,
  toLessonProgressView,
} from './progress.mapper.js';
import {
  progressRepository,
  type ProgressRepository,
} from './progress.repository.js';
import type {
  CourseProgressSummary,
  CourseProgressView,
  LessonProgressView,
  ProgressLessonType,
  RecordProgressInput,
} from './progress.types.js';

const PROGRESS_LESSON_TYPE_SET: ReadonlySet<string> = new Set(
  PROGRESS_LESSON_TYPES,
);

/**
 * Clamp a client-reported playback value into `[0, max]`.
 *
 * The validation layer already rejects negative, non-finite or absurd values;
 * this clamp is the final database-facing guarantee and also limits a value to
 * the authoritative video duration.
 */
function clampSeconds(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.min(value, max);
}

/** Group committed content documents by their denormalized course id. */
function groupByCourse<T extends { courseId: { toString(): string } }>(
  documents: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const document of documents) {
    const courseId = document.courseId.toString();
    const bucket = grouped.get(courseId);
    if (bucket) {
      bucket.push(document);
    } else {
      grouped.set(courseId, [document]);
    }
  }

  return grouped;
}

/**
 * Business rules for the Progress System (Roadmap Phase 9).
 *
 * Every progress read and write follows the same order: load the course,
 * enforce the existing published-course + enrollment policy, and only then
 * resolve committed lesson content. That order prevents unauthorized callers
 * from probing lesson ids, and it deliberately reuses `canAccessCourse` rather
 * than defining a second enrollment predicate.
 *
 * Only an authenticated student reaches this service; teachers and admins can
 * preview content through the Course Player but cannot create progress rows.
 */
export class ProgressService {
  constructor(
    private readonly courseRepo: CourseRepository = courseRepository,
    private readonly sectionRepo: SectionRepository = sectionRepository,
    private readonly lessonRepo: LessonRepository = lessonRepository,
    private readonly enrollmentRepo: EnrollmentRepository = enrollmentRepository,
    private readonly videoRepo: VideoRepository = videoRepository,
    private readonly progressRepo: ProgressRepository = progressRepository,
  ) {}

  /**
   * Record the authenticated student's progress for one lesson.
   *
   * Video completion is derived only from server-recorded watched time and the
   * authoritative duration stored on the Video document. The client's
   * `completed` flag is ignored for video lessons; it is the explicit action
   * for text/document lessons.
   */
  async recordLessonProgress(params: {
    courseId: string;
    lessonId: string;
    requester: AuthUser;
    input: RecordProgressInput;
  }): Promise<LessonProgressView> {
    const course = await this.requireAccessibleCourse(
      params.courseId,
      params.requester,
    );
    const { lesson, section } = await this.requireProgressLesson(
      course,
      params.lessonId,
    );

    const studentId = params.requester.id;
    const courseId = course._id.toString();
    const lessonId = lesson._id.toString();
    const lessonType = lesson.type as ProgressLessonType;

    if (lessonType === 'video') {
      const video = await this.requireVideoWithDuration(course, lesson);
      const durationSeconds = video.durationSeconds as number;
      const watchedSeconds = clampSeconds(
        params.input.watchedSeconds ?? 0,
        durationSeconds,
      );
      const lastPositionSeconds =
        params.input.positionSeconds === undefined
          ? undefined
          : clampSeconds(params.input.positionSeconds, durationSeconds);
      const complete =
        watchedSeconds >= durationSeconds * VIDEO_COMPLETION_THRESHOLD;

      const row = await this.progressRepo.upsert({
        studentId,
        courseId,
        sectionId: section._id.toString(),
        lessonId,
        lessonType,
        watchedSeconds,
        durationSeconds,
        lastPositionSeconds,
        complete,
      });

      // The persisted row is authoritative and completion is sticky. Triggering
      // from `row.completed` (rather than only the current request's threshold)
      // lets a later update finish a course when an earlier enrollment-completion
      // write failed after the lesson itself was already marked complete.
      if (row.completed) {
        await this.maybeCompleteCourse(studentId, courseId);
      }

      return toLessonProgressView(row);
    }

    // Text/document lessons have no playback. A non-completion request is
    // read-only: it returns any existing row (or an empty view) instead of
    // creating a meaningless progress row.
    if (params.input.completed !== true) {
      const existing = await this.progressRepo.findByStudentAndLesson(
        studentId,
        lessonId,
      );
      return existing
        ? toLessonProgressView(existing)
        : toEmptyLessonProgressView(lesson);
    }

    const row = await this.progressRepo.upsert({
      studentId,
      courseId,
      sectionId: section._id.toString(),
      lessonId,
      lessonType,
      watchedSeconds: 0,
      complete: true,
    });

    await this.maybeCompleteCourse(studentId, courseId);

    return toLessonProgressView(row);
  }

  /** Full progress summary and per-lesson progress for one course. */
  async getCourseProgress(params: {
    courseId: string;
    requester: AuthUser;
  }): Promise<CourseProgressView> {
    const course = await this.requireAccessibleCourse(
      params.courseId,
      params.requester,
    );
    const courseId = course._id.toString();

    const [sections, lessons, rows] = await Promise.all([
      this.sectionRepo.listByCourse(courseId),
      this.lessonRepo.listByCourse(courseId),
      this.progressRepo.listByStudentAndCourse(
        params.requester.id,
        courseId,
      ),
    ]);

    return toCourseProgressView({
      courseId,
      eligibleLessons: this.selectEligibleLessons(sections, lessons),
      rows,
    });
  }

  /** Resume position and progress for one lesson. */
  async getLessonProgress(params: {
    courseId: string;
    lessonId: string;
    requester: AuthUser;
  }): Promise<LessonProgressView> {
    const course = await this.requireAccessibleCourse(
      params.courseId,
      params.requester,
    );
    const { lesson } = await this.requireProgressLesson(
      course,
      params.lessonId,
    );

    const row = await this.progressRepo.findByStudentAndLesson(
      params.requester.id,
      lesson._id.toString(),
    );

    return row
      ? toLessonProgressView(row)
      : toEmptyLessonProgressView(lesson);
  }

  /**
   * Batch progress summaries for a student's course list.
   *
   * This is an internal read used by `GET /api/my-courses`; the caller has
   * already authenticated the student and scoped the course ids to their own
   * enrollments. It never performs an authorization decision of its own.
   */
  async getCourseSummaries(params: {
    studentId: string;
    courseIds: string[];
  }): Promise<Map<string, CourseProgressSummary>> {
    const courseIds = [...new Set(params.courseIds)];

    if (courseIds.length === 0) {
      return new Map();
    }

    const [sections, lessons, rows] = await Promise.all([
      this.sectionRepo.listByCourseIds(courseIds),
      this.lessonRepo.listByCourseIds(courseIds),
      this.progressRepo.listByStudentAndCourseIds(
        params.studentId,
        courseIds,
      ),
    ]);

    const sectionsByCourse = groupByCourse(sections);
    const lessonsByCourse = groupByCourse(lessons);
    const rowsByCourse = groupByCourse(rows);

    const summaries = new Map<string, CourseProgressSummary>();

    for (const courseId of courseIds) {
      const eligibleLessons = this.selectEligibleLessons(
        sectionsByCourse.get(courseId) ?? [],
        lessonsByCourse.get(courseId) ?? [],
      );

      summaries.set(
        courseId,
        summarizeCourseProgress(
          eligibleLessons,
          rowsByCourse.get(courseId) ?? [],
        ),
      );
    }

    return summaries;
  }

  /**
   * Published course + active/completed enrollment. Unpublished or unknown
   * courses are reported as missing so their existence is not leaked. The
   * route already requires the student role; this check is defense in depth so
   * a teacher/admin preview can never create or read student progress.
   */
  private async requireAccessibleCourse(
    courseId: string,
    requester: AuthUser,
  ): Promise<CourseDocument> {
    const course = await this.courseRepo.findById(courseId);

    if (!course || course.status !== 'published') {
      throw new AppError(
        404,
        COURSE_ERRORS.COURSE_NOT_FOUND,
        'Course not found',
      );
    }

    if (requester.role !== 'student') {
      throw new AppError(
        403,
        COURSE_ERRORS.COURSE_FORBIDDEN,
        'Only enrolled students can access course progress',
      );
    }

    const enrollment = await this.enrollmentRepo.findByStudentAndCourse(
      requester.id,
      courseId,
    );

    if (!canAccessCourse(enrollment, course.status)) {
      throw new AppError(
        403,
        COURSE_ERRORS.COURSE_FORBIDDEN,
        'You do not have access to this course',
      );
    }

    return course;
  }

  /**
   * Resolve a lesson inside the authorized course and require both the lesson
   * and its section to be committed. Cross-course ids, staged lessons and
   * staged sections are indistinguishable from missing content.
   */
  private async requireProgressLesson(
    course: CourseDocument,
    lessonId: string,
  ): Promise<{ lesson: LessonDocument; section: SectionDocument }> {
    const courseId = course._id.toString();

    const lesson = await this.lessonRepo.findByCourseAndId(courseId, lessonId);

    if (!lesson) {
      throw new AppError(
        404,
        COURSE_ERRORS.LESSON_NOT_FOUND,
        'Lesson not found',
      );
    }

    const section = await this.sectionRepo.findByCourseAndId(
      courseId,
      lesson.sectionId.toString(),
    );

    if (!section) {
      throw new AppError(
        404,
        COURSE_ERRORS.SECTION_NOT_FOUND,
        'Section not found',
      );
    }

    if (!PROGRESS_LESSON_TYPE_SET.has(lesson.type)) {
      throw new AppError(
        409,
        COURSE_ERRORS.LESSON_TYPE_UNSUPPORTED,
        'This lesson type does not support progress yet',
      );
    }

    return { lesson, section };
  }

  /**
   * Progress needs an authoritative duration. A ready video without one cannot
   * be evaluated safely, so it is rejected rather than trusting a client value.
   */
  private async requireVideoWithDuration(
    course: CourseDocument,
    lesson: LessonDocument,
  ): Promise<VideoDocument> {
    const video = await loadReadyLessonVideo(course, lesson, this.videoRepo);

    if (!video) {
      // Unreachable: the caller only invokes this for a video lesson.
      throw new Error('Expected a video lesson');
    }

    const durationSeconds = video.durationSeconds;

    if (
      typeof durationSeconds !== 'number' ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      throw new AppError(
        409,
        COURSE_ERRORS.LESSON_PAYLOAD_REQUIRED,
        'This video has no authoritative duration yet',
      );
    }

    return video;
  }

  /**
   * Completion uses committed lessons that are eligible for progress tracking.
   * A committed lesson whose section is staged is excluded, and quiz lessons
   * stay out until Phase 10.
   *
   * The result is in curriculum order: section order first, then the lesson's
   * own order (lesson `order` is scoped to its section, so a global lesson sort
   * alone would interleave sections). The caller uses this for the per-lesson
   * response as well as for counting, so the player UI can render the outline
   * directly.
   */
  private selectEligibleLessons(
    sections: SectionDocument[],
    lessons: LessonDocument[],
  ): LessonDocument[] {
    const sectionRank = new Map(
      sections.map((section, index) => [section._id.toString(), index]),
    );

    return lessons
      .filter(
        (lesson) =>
          PROGRESS_LESSON_TYPE_SET.has(lesson.type) &&
          sectionRank.has(lesson.sectionId.toString()),
      )
      .sort((a, b) => {
        const sectionDelta =
          (sectionRank.get(a.sectionId.toString()) ?? 0) -
          (sectionRank.get(b.sectionId.toString()) ?? 0);

        if (sectionDelta !== 0) {
          return sectionDelta;
        }

        if (a.order !== b.order) {
          return a.order - b.order;
        }

        return a.createdAt.getTime() - b.createdAt.getTime();
      });
  }

  private async computeCourseSummary(
    studentId: string,
    courseId: string,
  ): Promise<CourseProgressSummary> {
    const [sections, lessons, rows] = await Promise.all([
      this.sectionRepo.listByCourse(courseId),
      this.lessonRepo.listByCourse(courseId),
      this.progressRepo.listByStudentAndCourse(studentId, courseId),
    ]);

    return summarizeCourseProgress(
      this.selectEligibleLessons(sections, lessons),
      rows,
    );
  }

  /**
   * Mark the enrollment complete only when every eligible committed lesson is
   * complete. `markCompleted` is idempotent and preserves the first completion
   * timestamp. A course with zero eligible lessons never completes.
   */
  private async maybeCompleteCourse(
    studentId: string,
    courseId: string,
  ): Promise<void> {
    const summary = await this.computeCourseSummary(studentId, courseId);

    if (
      summary.totalLessons > 0 &&
      summary.completedLessons === summary.totalLessons
    ) {
      await this.enrollmentRepo.markCompleted({ studentId, courseId });
    }
  }
}

export const progressService = new ProgressService();
