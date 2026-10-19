import { randomBytes } from 'node:crypto';
import { Types, type FilterQuery } from 'mongoose';
import { CourseModel } from './course.model.js';
import type { CourseDocument, CourseStatus, ICourse } from './course.types.js';

export interface CreateCourseData {
  ownerId: string;
  title: string;
  slug: string;
  description?: string;
}

export type CourseUpdate = Partial<
  Omit<
    ICourse,
    | '_id'
    | 'createdAt'
    | 'updatedAt'
    | 'ownerId'
    | 'slug'
    | 'editLocked'
    | 'editLockedAt'
    | 'editLockToken'
  >
>;

/**
 * Match a course whose edit lease is not held. `editLocked` may be missing on
 * documents created before the lease was introduced.
 */
const UNLOCKED_FILTER: FilterQuery<CourseDocument> = {
  $or: [{ editLocked: false }, { editLocked: { $exists: false } }],
};

export interface ListCoursesParams {
  ownerId: string;
  skip: number;
  limit: number;
}

export interface ListCoursesByStatusParams {
  status: CourseStatus;
  skip: number;
  limit: number;
}

export interface ListCoursesResult {
  items: CourseDocument[];
  total: number;
}

/**
 * Build a MongoDB update document, stripping `undefined` values and turning
 * explicit `unset` keys into `$unset` entries.
 */
function buildUpdateDocument(
  update: CourseUpdate,
  unset: string[],
): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) {
      set[key] = value;
    }
  }

  const updateDoc: Record<string, unknown> = {};
  if (Object.keys(set).length > 0) {
    updateDoc.$set = set;
  }
  if (unset.length > 0) {
    updateDoc.$unset = Object.fromEntries(unset.map((key) => [key, 1]));
  }

  return updateDoc;
}

export class CourseRepository {
  async create(data: CreateCourseData): Promise<CourseDocument> {
    const course = new CourseModel({
      ownerId: new Types.ObjectId(data.ownerId),
      title: data.title,
      slug: data.slug,
      description: data.description,
      status: 'draft',
    });

    return course.save();
  }

  async findById(id: string): Promise<CourseDocument | null> {
    return CourseModel.findById(id).exec();
  }

  async listByOwner(params: ListCoursesParams): Promise<ListCoursesResult> {
    const filter = { ownerId: new Types.ObjectId(params.ownerId) };

    const [items, total] = await Promise.all([
      CourseModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(params.skip)
        .limit(params.limit)
        .exec(),
      CourseModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  /**
   * List courses in a given lifecycle status (newest first). Used by the admin
   * moderation queue.
   */
  async listByStatus(
    params: ListCoursesByStatusParams,
  ): Promise<ListCoursesResult> {
    const filter = { status: params.status };

    const [items, total] = await Promise.all([
      CourseModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(params.skip)
        .limit(params.limit)
        .exec(),
      CourseModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  /**
   * Update course metadata. `undefined` values are stripped; use `unset` to
   * explicitly clear a field.
   */
  async updateById(
    id: string,
    update: CourseUpdate,
    unset: string[] = [],
  ): Promise<CourseDocument | null> {
    return CourseModel.findByIdAndUpdate(
      id,
      buildUpdateDocument(update, unset),
      { new: true },
    ).exec();
  }

  /**
   * Compare-and-set a lifecycle transition.
   *
   * The update only succeeds while the stored status is still one of
   * `fromStatuses`. This prevents two concurrent reviewers (or a reviewer and
   * the owner) from both acting on the same submission; the loser receives
   * `null` and the service reports a conflict.
   *
   * `guard` adds extra server-derived conditions, such as the submission
   * timestamp a reviewer actually inspected. It must never come from a client.
   */
  async transitionStatus(
    id: string,
    fromStatuses: readonly CourseStatus[],
    update: CourseUpdate,
    unset: string[] = [],
    guard: Record<string, unknown> = {},
  ): Promise<CourseDocument | null> {
    return CourseModel.findOneAndUpdate(
      { _id: id, status: { $in: [...fromStatuses] }, ...guard },
      buildUpdateDocument(update, unset),
      { new: true },
    ).exec();
  }

  /**
   * Submit for review only when no content write is in flight. This is the
   * other half of the edit-lease protocol: an edit that claimed the lease first
   * makes submission fail, while a submission that wins first makes the edit's
   * lease acquisition fail.
   */
  async transitionStatusIfIdle(
    id: string,
    fromStatuses: readonly CourseStatus[],
    update: CourseUpdate,
    unset: string[] = [],
    guard: Record<string, unknown> = {},
  ): Promise<CourseDocument | null> {
    return CourseModel.findOneAndUpdate(
      {
        _id: id,
        status: { $in: [...fromStatuses] },
        ...UNLOCKED_FILTER,
        ...guard,
      },
      buildUpdateDocument(update, unset),
      { new: true },
    ).exec();
  }

  /**
   * Claim the exclusive content-edit lease for a course.
   *
   * Returns `null` when the course is no longer editable, already has an edit
   * in progress, or has been deleted. The service distinguishes those cases
   * and may recover an abandoned lease.
   */
  async acquireEditLock(
    id: string,
    editableStatuses: readonly CourseStatus[],
  ): Promise<CourseDocument | null> {
    const token = randomBytes(16).toString('hex');

    return CourseModel.findOneAndUpdate(
      {
        _id: id,
        status: { $in: [...editableStatuses] },
        ...UNLOCKED_FILTER,
      },
      {
        $set: {
          editLocked: true,
          editLockedAt: new Date(),
          editLockToken: token,
        },
      },
      { new: true },
    ).exec();
  }

  /**
   * Release an edit lease. Safe to call after the course was deleted (no-op).
   * The token check prevents a stale request from releasing a newer holder's
   * lease after abandoned-lock recovery.
   */
  async releaseEditLock(id: string, token: string): Promise<void> {
    await CourseModel.updateOne(
      { _id: id, editLocked: true, editLockToken: token },
      {
        $set: { editLocked: false },
        $unset: { editLockedAt: 1, editLockToken: 1 },
      },
    ).exec();
  }

  /**
   * Clear an edit lease older than `olderThan`. Compare-and-set prevents a
   * concurrent live edit from losing its fresh lease.
   */
  async clearStaleEditLock(
    id: string,
    editableStatuses: readonly CourseStatus[],
    olderThan: Date,
  ): Promise<boolean> {
    const result = await CourseModel.updateOne(
      {
        _id: id,
        status: { $in: [...editableStatuses] },
        editLocked: true,
        $or: [
          { editLockedAt: { $lt: olderThan } },
          { editLockedAt: { $exists: false } },
        ],
      },
      {
        $set: { editLocked: false },
        $unset: { editLockedAt: 1, editLockToken: 1 },
      },
    ).exec();

    return result.modifiedCount > 0;
  }

  async deleteById(id: string): Promise<void> {
    await CourseModel.findByIdAndDelete(id).exec();
  }
}

export const courseRepository = new CourseRepository();
