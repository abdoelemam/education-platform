import { Types, type PipelineStage } from 'mongoose';
import { CourseModel } from '../courses/course.model.js';
import { EnrollmentModel } from './enrollment.model.js';
import type {
  EnrollmentLike,
  EnrollmentSource,
} from './enrollment.types.js';

export interface FindOrCreateEnrollmentData {
  studentId: string;
  courseId: string;
  source: EnrollmentSource;
}

export interface FindOrCreateEnrollmentResult {
  enrollment: EnrollmentLike;
  /** False when an enrollment for this student/course already existed. */
  created: boolean;
}

export interface ListEnrollmentsParams {
  skip: number;
  limit: number;
}

export interface ListEnrollmentsResult {
  items: EnrollmentLike[];
  total: number;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

export class EnrollmentRepository {
  /**
   * Read paths use `lean()` on purpose.
   *
   * Mongoose applies schema defaults while hydrating documents, which would
   * silently turn a legacy row that never stored `status`/`enrolledAt` into a
   * freshly "enrolled now" active row. Lean reads return the stored document,
   * and the mapper normalizes missing fields from the real stored data.
   */
  async findByStudentAndCourse(
    studentId: string,
    courseId: string,
  ): Promise<EnrollmentLike | null> {
    const enrollment = await EnrollmentModel.findOne({
      studentId,
      courseId,
    })
      .lean()
      .exec();

    return enrollment as EnrollmentLike | null;
  }

  /**
   * Create the student's enrollment, or return the existing one.
   *
   * The unique `{ studentId, courseId }` index is the duplicate barrier. Two
   * concurrent upserts can race: the loser receives a duplicate-key error and
   * re-reads the winner's row. Callers therefore observe exactly one persisted
   * enrollment and a deterministic `created` flag.
   *
   * `$setOnInsert` never mutates an existing enrollment, so a repeated request
   * cannot reset a completed enrollment or its timestamps.
   */
  async findOrCreate(
    data: FindOrCreateEnrollmentData,
  ): Promise<FindOrCreateEnrollmentResult> {
    const filter = {
      studentId: new Types.ObjectId(data.studentId),
      courseId: new Types.ObjectId(data.courseId),
    };

    try {
      const result = await EnrollmentModel.findOneAndUpdate(
        filter,
        {
          $setOnInsert: {
            studentId: filter.studentId,
            courseId: filter.courseId,
            status: 'active',
            enrolledAt: new Date(),
            source: data.source,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
          includeResultMetadata: true,
          lean: true,
        },
      ).exec();

      if (result.value) {
        return {
          enrollment: result.value as unknown as EnrollmentLike,
          created: result.lastErrorObject?.updatedExisting !== true,
        };
      }
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    // The upsert lost a race (or, defensively, returned no document). The
    // winning row must exist now.
    const existing = await this.findByStudentAndCourse(
      data.studentId,
      data.courseId,
    );

    if (!existing) {
      throw new Error(
        'Enrollment upsert did not produce a readable enrollment document',
      );
    }

    return { enrollment: existing, created: false };
  }

  /**
   * Newest enrollment first, scoped to one student.
   *
   * Legacy enrollments whose course no longer exists are excluded from both
   * the page and the total. Counting raw enrollment rows while dropping
   * orphans from the page would make `total`/`totalPages` disagree with the
   * returned data and could produce short or empty pages.
   */
  async listByStudent(
    studentId: string,
    params: ListEnrollmentsParams,
  ): Promise<ListEnrollmentsResult> {
    const basePipeline: PipelineStage[] = [
      { $match: { studentId: new Types.ObjectId(studentId) } },
      {
        $lookup: {
          from: CourseModel.collection.name,
          localField: 'courseId',
          foreignField: '_id',
          as: 'course',
        },
      },
      { $match: { 'course.0': { $exists: true } } },
      { $sort: { enrolledAt: -1, _id: -1 } },
    ];

    const [items, totalResult] = await Promise.all([
      EnrollmentModel.aggregate([
        ...basePipeline,
        { $skip: params.skip },
        { $limit: params.limit },
        { $project: { course: 0 } },
      ]).exec(),
      EnrollmentModel.aggregate([
        ...basePipeline,
        { $count: 'total' },
      ]).exec(),
    ]);

    const total =
      (totalResult[0] as { total?: number } | undefined)?.total ?? 0;

    return { items: items as EnrollmentLike[], total };
  }

  /** Newest enrollment first, scoped to one course. */
  async listByCourse(
    courseId: string,
    params: ListEnrollmentsParams,
  ): Promise<ListEnrollmentsResult> {
    const filter = { courseId: new Types.ObjectId(courseId) };

    const [items, total] = await Promise.all([
      EnrollmentModel.find(filter)
        .sort({ enrolledAt: -1, _id: -1 })
        .skip(params.skip)
        .limit(params.limit)
        .lean()
        .exec(),
      EnrollmentModel.countDocuments(filter).exec(),
    ]);

    return { items: items as EnrollmentLike[], total };
  }

  /**
   * Authoritative completion entry point for the Progress System (Phase 9).
   *
   * Only an active enrollment transitions. A legacy row that never stored
   * `status` is treated as active by the mapper, so it is transitionable too.
   * The first completion timestamp is preserved on repeat calls, so completion
   * stays idempotent and historical.
   *
   * Returns `null` when no transition occurred: the row is missing, already
   * completed, cancelled, or expired. Callers must not interpret one of those
   * states as a successful completion.
   */
  async markCompleted(params: {
    studentId: string;
    courseId: string;
    completedAt?: Date;
  }): Promise<EnrollmentLike | null> {
    const completedAt = params.completedAt ?? new Date();

    return EnrollmentModel.findOneAndUpdate(
      {
        studentId: new Types.ObjectId(params.studentId),
        courseId: new Types.ObjectId(params.courseId),
        $or: [
          { status: 'active' },
          { status: { $exists: false } },
          { status: null },
        ],
      },
      { $set: { status: 'completed', completedAt } },
      { new: true },
    ).exec();
  }
}

export const enrollmentRepository = new EnrollmentRepository();
