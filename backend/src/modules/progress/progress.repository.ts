import { Types } from 'mongoose';
import { LessonProgressModel } from './progress.model.js';
import type { LessonProgressLike, ProgressLessonType } from './progress.types.js';

export interface UpsertProgressData {
  studentId: string;
  courseId: string;
  sectionId: string;
  lessonId: string;
  lessonType: ProgressLessonType;
  watchedSeconds: number;
  durationSeconds?: number;
  /** When omitted, an existing resume position is left unchanged. */
  lastPositionSeconds?: number;
  /** True when the server has determined this lesson is complete. */
  complete: boolean;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

export class ProgressRepository {
  /**
   * Upsert one student/lesson row.
   *
   * `$max` keeps watched time monotonic, and the separate completion update only
   * matches a row that is not yet completed, so the first completion timestamp
   * is preserved. The unique `(studentId, lessonId)` index is the duplicate
   * barrier; a concurrent insert is retried as a plain update.
   */
  async upsert(data: UpsertProgressData): Promise<LessonProgressLike> {
    const filter = {
      studentId: new Types.ObjectId(data.studentId),
      lessonId: new Types.ObjectId(data.lessonId),
    };

    const set: Record<string, unknown> = {};

    if (data.lastPositionSeconds !== undefined) {
      set.lastPositionSeconds = data.lastPositionSeconds;
    }

    if (data.durationSeconds !== undefined) {
      set.durationSeconds = data.durationSeconds;
    }

    const setOnInsert: Record<string, unknown> = {
      studentId: filter.studentId,
      courseId: new Types.ObjectId(data.courseId),
      sectionId: new Types.ObjectId(data.sectionId),
      lessonId: filter.lessonId,
      lessonType: data.lessonType,
      completed: false,
    };

    // `$set` and `$setOnInsert` cannot both target the same path. When the
    // client supplies a position it is written by `$set`; otherwise the insert
    // initializes it to zero and later updates leave it untouched.
    if (data.lastPositionSeconds === undefined) {
      setOnInsert.lastPositionSeconds = 0;
    }

    const update: Record<string, unknown> = {
      $setOnInsert: setOnInsert,
      $max: { watchedSeconds: data.watchedSeconds },
    };

    if (Object.keys(set).length > 0) {
      update.$set = set;
    }

    try {
      await LessonProgressModel.updateOne(filter, update, {
        upsert: true,
      }).exec();
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      // Another request inserted the row first; retry as a plain update.
      await LessonProgressModel.updateOne(filter, update).exec();
    }

    if (data.complete) {
      await LessonProgressModel.updateOne(
        { ...filter, completed: false },
        { $set: { completed: true, completedAt: new Date() } },
      ).exec();
    }

    const row = await this.findByStudentAndLesson(
      data.studentId,
      data.lessonId,
    );

    if (!row) {
      throw new Error('Progress row missing after upsert');
    }

    return row;
  }

  async findByStudentAndLesson(
    studentId: string,
    lessonId: string,
  ): Promise<LessonProgressLike | null> {
    return LessonProgressModel.findOne({
      studentId: new Types.ObjectId(studentId),
      lessonId: new Types.ObjectId(lessonId),
    })
      .lean()
      .exec() as unknown as Promise<LessonProgressLike | null>;
  }

  async listByStudentAndCourse(
    studentId: string,
    courseId: string,
  ): Promise<LessonProgressLike[]> {
    return LessonProgressModel.find({
      studentId: new Types.ObjectId(studentId),
      courseId: new Types.ObjectId(courseId),
    })
      .lean()
      .exec() as unknown as Promise<LessonProgressLike[]>;
  }

  async listByStudentAndCourseIds(
    studentId: string,
    courseIds: string[],
  ): Promise<LessonProgressLike[]> {
    if (courseIds.length === 0) {
      return [];
    }

    return LessonProgressModel.find({
      studentId: new Types.ObjectId(studentId),
      courseId: { $in: courseIds.map((id) => new Types.ObjectId(id)) },
    })
      .lean()
      .exec() as unknown as Promise<LessonProgressLike[]>;
  }
}

export const progressRepository = new ProgressRepository();
