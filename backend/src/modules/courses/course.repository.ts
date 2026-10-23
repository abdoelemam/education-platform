import { randomBytes } from 'node:crypto';
import { Types, type FilterQuery } from 'mongoose';
import { COURSE_EDIT_LOCK_TTL_MS } from './course.constants.js';
import {
  activeCourseEditFenceFilter,
  type CourseEditFence,
} from './course.fence.js';
import { CourseModel } from './course.model.js';
import type { CourseDocument, CourseStatus, ICourse } from './course.types.js';

export interface CreateCourseData {
  /** Pre-generated id used to reserve category membership before insertion. */
  id?: string;
  ownerId: string;
  title: string;
  slug: string;
  description?: string;
  categoryId?: string;
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
    | 'editLeaseExpiresAt'
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
      _id: data.id ? new Types.ObjectId(data.id) : undefined,
      ownerId: new Types.ObjectId(data.ownerId),
      title: data.title,
      slug: data.slug,
      description: data.description,
      categoryId: data.categoryId
        ? new Types.ObjectId(data.categoryId)
        : undefined,
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
   * Public catalog listing: published courses only, newest publication first.
   * `categoryIds` restricts the result to a resolved category subtree.
   */
  async listPublished(params: {
    skip: number;
    limit: number;
    categoryIds?: string[];
  }): Promise<ListCoursesResult> {
    const filter: FilterQuery<CourseDocument> = {
      status: 'published' as const,
    };

    if (params.categoryIds) {
      filter.categoryId = {
        $in: params.categoryIds.map((id) => new Types.ObjectId(id)),
      };
    }

    const [items, total] = await Promise.all([
      CourseModel.find(filter)
        .sort({ publishedAt: -1, createdAt: -1 })
        .skip(params.skip)
        .limit(params.limit)
        .exec(),
      CourseModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  async findPublishedBySlug(slug: string): Promise<CourseDocument | null> {
    return CourseModel.findOne({ slug, status: 'published' }).exec();
  }

  /**
   * Update course metadata. `undefined` values are stripped; use `unset` to
   * explicitly clear a field.
   */
  async updateById(
    id: string,
    update: CourseUpdate,
    unset: string[] = [],
    fence?: CourseEditFence,
  ): Promise<CourseDocument | null> {
    const filter = fence
      ? { _id: id, ...activeCourseEditFenceFilter(fence) }
      : { _id: id };

    return CourseModel.findOneAndUpdate(
      filter,
      buildUpdateDocument(update, unset),
      { new: true },
    ).exec();
  }

  /**
   * Administrative repair path: change only the category of an approved course
   * that has not been published yet.
   *
   * The category that was inspected is part of the CAS filter, so two admins
   * racing the same repair cannot both succeed. The method never writes content,
   * review metadata, or publish state.
   */
  async assignCategoryIfApproved(params: {
    id: string;
    fromCategoryId?: string | null;
    toCategoryId: string;
  }): Promise<CourseDocument | null> {
    const fromFilter = params.fromCategoryId
      ? { categoryId: new Types.ObjectId(params.fromCategoryId) }
      : { categoryId: null };

    return CourseModel.findOneAndUpdate(
      {
        _id: params.id,
        status: 'approved',
        publishedAt: { $exists: false },
        ...fromFilter,
      },
      { $set: { categoryId: new Types.ObjectId(params.toCategoryId) } },
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
    const now = new Date();
    const expiresAt = new Date(now.getTime() + COURSE_EDIT_LOCK_TTL_MS);

    return CourseModel.findOneAndUpdate(
      {
        _id: id,
        status: { $in: [...editableStatuses] },
        ...UNLOCKED_FILTER,
      },
      {
        $set: {
          editLocked: true,
          editLockedAt: now,
          editLockToken: token,
          editLeaseExpiresAt: expiresAt,
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
        $unset: {
          editLockedAt: 1,
          editLockToken: 1,
          editLeaseExpiresAt: 1,
        },
      },
    ).exec();
  }

  /**
   * Clear an expired edit lease. Compare-and-set prevents a concurrent live
   * edit from losing its fresh lease. The legacy `editLockedAt` branch keeps
   * leases created before `editLeaseExpiresAt` was introduced recoverable.
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
          {
            editLeaseExpiresAt: { $exists: true },
            $expr: { $lte: ['$editLeaseExpiresAt', '$$NOW'] },
          },
          {
            editLeaseExpiresAt: { $exists: false },
            editLockedAt: { $lt: olderThan },
          },
          {
            editLeaseExpiresAt: { $exists: false },
            editLockedAt: { $exists: false },
          },
        ],
      },
      {
        $set: { editLocked: false },
        $unset: {
          editLockedAt: 1,
          editLockToken: 1,
          editLeaseExpiresAt: 1,
        },
      },
    ).exec();

    return result.modifiedCount > 0;
  }

  /**
   * Atomically verify that `fence` is still the course's live lease. Used as
   * the authorization point before a staged content create is committed, so a
   * request whose lease was replaced cannot activate a newly inserted row.
   */
  async beginContentCommit(
    id: string,
    fence: CourseEditFence,
  ): Promise<boolean> {
    const result = await CourseModel.updateOne(
      { _id: id, ...activeCourseEditFenceFilter(fence) },
      { $set: { editLeaseExpiresAt: fence.expiresAt } },
      { timestamps: false },
    ).exec();

    return result.matchedCount > 0;
  }

  /**
   * Delete the course only while `fence` is still the active edit lease.
   * Returns false when the lease expired, was replaced, or the course is gone.
   */
  async deleteById(
    id: string,
    fence?: CourseEditFence,
  ): Promise<boolean> {
    const filter = fence
      ? { _id: id, ...activeCourseEditFenceFilter(fence) }
      : { _id: id };

    const deleted = await CourseModel.findOneAndDelete(filter).exec();
    return deleted !== null;
  }
}

export const courseRepository = new CourseRepository();
