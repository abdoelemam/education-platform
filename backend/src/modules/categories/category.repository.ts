import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { CourseModel } from '../courses/course.model.js';
import {
  activeCategoryFenceFilter,
  COMMITTED_CATEGORY_FILTER,
  STAGED_CATEGORY_FILTER,
  type CategoryMutationFence,
} from './category.fence.js';
import {
  CATEGORY_LOCK_ID,
  CATEGORY_LOCK_TTL_MS,
} from './category.constants.js';
import { CategoryLockModel } from './category-lock.model.js';
import { CategoryModel } from './category.model.js';
import type { CategoryDocument, ICategory } from './category.types.js';

export interface CreateCategoryData {
  name: string;
  slug: string;
  description?: string;
  parentId?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export type CategoryUpdate = Partial<
  Pick<ICategory, 'name' | 'description' | 'parentId' | 'isActive' | 'sortOrder'>
>;

export type CategoryLockLease = CategoryMutationFence;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

function buildUpdateDocument(
  update: CategoryUpdate,
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

export class CategoryRepository {
  /**
   * Insert a staged category. It becomes visible only after `commitCreated`
   * succeeds under the same live lease.
   */
  async create(
    data: CreateCategoryData,
    fence: CategoryMutationFence,
  ): Promise<CategoryDocument> {
    const category = new CategoryModel({
      name: data.name,
      slug: data.slug,
      description: data.description,
      parentId: data.parentId ? new Types.ObjectId(data.parentId) : undefined,
      isActive: data.isActive ?? true,
      sortOrder: data.sortOrder ?? 0,
      committed: false,
      mutationToken: fence.token,
      fenceGeneration: fence.generation,
      leaseExpiresAt: fence.expiresAt,
    });

    return category.save();
  }

  async findById(id: string): Promise<CategoryDocument | null> {
    return CategoryModel.findOne({
      _id: id,
      ...COMMITTED_CATEGORY_FILTER,
    }).exec();
  }

  /**
   * The category graph is small enough to load as a unit. This keeps tree
   * construction, cycle detection and descendant checks consistent without
   * denormalized ancestor paths that could become stale on a move.
   *
   * Staged rows are deliberately excluded.
   */
  async listAll(): Promise<CategoryDocument[]> {
    return CategoryModel.find(COMMITTED_CATEGORY_FILTER)
      .sort({ sortOrder: 1, name: 1, _id: 1 })
      .exec();
  }

  /**
   * Update a committed category only while `fence` is still the live lease.
   * Returns `null` when the lease expired/was replaced or the row is gone.
   */
  async updateById(
    id: string,
    update: CategoryUpdate,
    unset: string[] = [],
    fence: CategoryMutationFence,
  ): Promise<CategoryDocument | null> {
    return CategoryModel.findOneAndUpdate(
      {
        _id: id,
        ...COMMITTED_CATEGORY_FILTER,
        ...activeCategoryFenceFilter(fence),
      },
      buildUpdateDocument(update, unset),
      { new: true },
    ).exec();
  }

  /**
   * Delete a committed category only while `fence` is still the live lease.
   */
  async deleteById(
    id: string,
    fence: CategoryMutationFence,
  ): Promise<boolean> {
    const deleted = await CategoryModel.findOneAndDelete({
      _id: id,
      ...COMMITTED_CATEGORY_FILTER,
      ...activeCategoryFenceFilter(fence),
    }).exec();
    return deleted !== null;
  }

  /**
   * Activate a staged row if the creating request still owns a live lease.
   */
  async commitCreated(
    id: string,
    fence: CategoryMutationFence,
  ): Promise<CategoryDocument | null> {
    return CategoryModel.findOneAndUpdate(
      {
        _id: id,
        ...STAGED_CATEGORY_FILTER,
        ...activeCategoryFenceFilter(fence),
      },
      { $set: { committed: true } },
      { new: true },
    ).exec();
  }

  /**
   * Remove a staged row after a failed commit. A stale row is also cleaned up
   * opportunistically on the next lock acquisition.
   */
  async deleteStaged(id: string): Promise<void> {
    await CategoryModel.deleteOne({
      _id: id,
      ...STAGED_CATEGORY_FILTER,
    }).exec();
  }

  /**
   * Deletion guard for the course link introduced in the next Category phase.
   *
   * The Course schema does not expose `categoryId` yet, so this intentionally
   * queries the underlying collection. It becomes effective as soon as the
   * course-category PR starts writing that field, and it lets this PR enforce
   * the referential rule rather than leaving a known hole.
   */
  async hasCourseReference(categoryId: string): Promise<boolean> {
    const course = await CourseModel.collection.findOne(
      { categoryId: new Types.ObjectId(categoryId) },
      { projection: { _id: 1 } },
    );
    return course !== null;
  }

  /**
   * Deactivation guard for reviewed/published courses in a subtree. Like
   * `hasCourseReference`, it is forward-compatible with the course-category
   * phase and is a no-op until courses can reference categories.
   */
  async hasProtectedCourseReferences(categoryIds: string[]): Promise<boolean> {
    if (categoryIds.length === 0) {
      return false;
    }

    const course = await CourseModel.collection.findOne(
      {
        categoryId: {
          $in: categoryIds.map((id) => new Types.ObjectId(id)),
        },
        status: { $in: ['approved', 'published'] },
      },
      { projection: { _id: 1 } },
    );
    return course !== null;
  }

  // -------------------------------------------------------------------------
  // Tree mutation lock and category fences
  // -------------------------------------------------------------------------

  async acquireLock(): Promise<CategoryLockLease | null> {
    const token = randomBytes(16).toString('hex');

    // Ensure the singleton exists. The filter on the next update is what makes
    // acquisition atomic; this upsert only bootstraps the document. Two
    // first-ever callers can race here, so a duplicate-key result is harmless
    // once the other caller has created the singleton.
    try {
      await CategoryLockModel.updateOne(
        { _id: CATEGORY_LOCK_ID },
        { $setOnInsert: { locked: false } },
        { upsert: true },
      ).exec();
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }

    // The expiry and stale check are evaluated with MongoDB server time. A
    // caller with a skewed clock therefore cannot steal a live lease. A lock
    // document that predates the expiry field (or was corrupted) is treated as
    // stale instead of blocking the tree forever.
    const lock = await CategoryLockModel.findOneAndUpdate(
      {
        _id: CATEGORY_LOCK_ID,
        $expr: {
          $or: [
            { $ne: ['$locked', true] },
            // Missing, null or otherwise malformed expiry fields must not keep
            // the singleton locked forever.
            { $ne: [{ $type: '$expiresAt' }, 'date'] },
            { $lte: ['$expiresAt', '$$NOW'] },
          ],
        },
      },
      [
        {
          $set: {
            locked: true,
            token,
            lockedAt: '$$NOW',
            expiresAt: { $add: ['$$NOW', CATEGORY_LOCK_TTL_MS] },
            // The generation is incremented in the same atomic update that
            // grants the lease and survives release in the singleton.
            // `reconcileGeneration` re-raises it above existing row fences if
            // the singleton was lost or restored at a lower value.
            fenceGeneration: {
              $add: [{ $ifNull: ['$fenceGeneration', 0] }, 1],
            },
          },
        },
      ],
      { new: true },
    ).exec();

    if (!lock) {
      return null;
    }

    const expiresAt = lock.expiresAt;
    const generation = lock.fenceGeneration;
    if (
      !(expiresAt instanceof Date) ||
      typeof generation !== 'number' ||
      !Number.isInteger(generation) ||
      generation < 1
    ) {
      await this.releaseLock(token).catch(() => undefined);
      return null;
    }

    let fence: CategoryMutationFence = { token, generation, expiresAt };

    // Move the fence onto every committed row before any caller can read and
    // validate the graph. A writer holding the previous (expired) lease will
    // no longer match any category document. If this preparation fails, release
    // the lock so a later request can retry instead of leaving it stuck.
    try {
      // The singleton can be deleted, recreated or restored from an older
      // snapshot, which resets its counter below fences that an earlier writer
      // already copied onto committed rows. Raise the lease generation above
      // every observed row before refreshing; otherwise the generation filter
      // would skip those rows and leave an older writer's fence valid.
      const reconciled = await this.reconcileGeneration(fence);
      if (!reconciled) {
        await this.releaseLock(token).catch(() => undefined);
        return null;
      }
      fence = reconciled;

      // Revoke staged creates from older generations before refreshing. Their
      // own fence would otherwise still allow a commit after the lock document
      // was lost. Deleting before the refresh closes the race: a commit that
      // lands first becomes a committed row that the refresh below overwrites,
      // while a commit that lands after the delete finds no staged row.
      await this.revokeOlderStaged(fence);
      await this.cleanupExpiredStaged();
      await this.refreshLease(fence);

      // A stale refresh that raced the reconciliation can only leave a fence
      // that this lease does not own. Refuse to hand out a lease in that state:
      // the foreign holder cannot pass the ownership revalidation below, so
      // failing here is safer than validating the tree against a fence that
      // cannot write. This is defense in depth; the write-time filters remain
      // the actual guarantee.
      const foreignFence = await CategoryModel.findOne({
        ...COMMITTED_CATEGORY_FILTER,
        $or: [
          { fenceGeneration: { $gt: fence.generation } },
          {
            fenceGeneration: fence.generation,
            mutationToken: { $ne: fence.token },
          },
        ],
      })
        .select('_id')
        .exec();

      if (foreignFence) {
        await this.releaseLock(token).catch(() => undefined);
        return null;
      }

      // A slower request may have lost the lock between acquisition and the
      // refresh above. Re-check ownership with the same token/generation and a
      // database-time expiry condition. If it no longer owns a live lease, it
      // must not return a usable fence. A concurrent sender cannot overwrite
      // the newer holder because `refreshLease` only updates older generations.
      const stillOwner = await CategoryLockModel.findOne({
        _id: CATEGORY_LOCK_ID,
        locked: true,
        token,
        fenceGeneration: fence.generation,
        $expr: { $gt: ['$expiresAt', '$$NOW'] },
      })
        .select('_id')
        .exec();

      if (!stillOwner) {
        await this.releaseLock(token).catch(() => undefined);
        return null;
      }
    } catch (error) {
      await this.releaseLock(token).catch(() => undefined);
      throw error;
    }

    return fence;
  }

  /**
   * Retire this lease before releasing the singleton lock. Committed rows lose
   * the fence first and staged rows created by this request are removed, so a
   * later holder can never adopt them. The lock document is released last: if
   * any cleanup step fails, the lease stays in place until its database-time
   * expiry instead of exposing a partially retired operation to a new writer.
   *
   * The token checks prevent a stale release from clearing a newer holder's
   * fence.
   */
  async releaseLock(token: string): Promise<void> {
    await CategoryModel.updateMany(
      {
        ...COMMITTED_CATEGORY_FILTER,
        mutationToken: token,
      },
      {
        $unset: {
          mutationToken: 1,
          fenceGeneration: 1,
          leaseExpiresAt: 1,
        },
      },
      { timestamps: false },
    ).exec();

    await CategoryModel.deleteMany({
      ...STAGED_CATEGORY_FILTER,
      mutationToken: token,
    }).exec();

    await CategoryLockModel.updateOne(
      { _id: CATEGORY_LOCK_ID, locked: true, token },
      {
        $set: { locked: false },
        $unset: { token: 1, lockedAt: 1, expiresAt: 1 },
      },
    ).exec();
  }

  /**
   * Keep the lease generation above every committed row fence.
   *
   * In normal operation the lock document retains the high-water generation, so
   * this is a no-op. If the singleton was deleted, recreated, or restored from
   * an older snapshot, its counter can be lower than a fence that a previous
   * writer already copied onto a committed row. The lease is then raised with a
   * single token/generation/expiry-guarded atomic update while we still own the
   * lock. The following `refreshLease` therefore rewrites every older fence, so
   * a writer that already validated under the lost lock can no longer match a
   * row. The row query only supplies the floor; the guarded lock update is what
   * makes the new generation authoritative and cannot be interleaved with
   * another acquisition.
   */
  protected async reconcileGeneration(
    fence: CategoryMutationFence,
  ): Promise<CategoryMutationFence | null> {
    const rowFloor = await this.maxCommittedGeneration();
    if (rowFloor < fence.generation) {
      return fence;
    }
    if (rowFloor >= Number.MAX_SAFE_INTEGER) {
      return null;
    }

    const nextGeneration = rowFloor + 1;
    const lock = await CategoryLockModel.findOneAndUpdate(
      {
        _id: CATEGORY_LOCK_ID,
        locked: true,
        token: fence.token,
        fenceGeneration: fence.generation,
        $expr: { $gt: ['$expiresAt', '$$NOW'] },
      },
      [
        {
          $set: {
            fenceGeneration: nextGeneration,
            expiresAt: { $add: ['$$NOW', CATEGORY_LOCK_TTL_MS] },
          },
        },
      ],
      { new: true },
    ).exec();

    if (!lock) {
      return null;
    }

    const expiresAt = lock.expiresAt;
    const generation = lock.fenceGeneration;
    if (!(expiresAt instanceof Date) || generation !== nextGeneration) {
      return null;
    }

    return { token: fence.token, generation, expiresAt };
  }

  /**
   * Highest generation currently attached to a committed row. A malformed or
   * missing value is ignored because no valid fence can match it. Staged rows
   * are excluded: they are invisible and can only be committed under their own
   * live fence.
   */
  private async maxCommittedGeneration(): Promise<number> {
    const row = await CategoryModel.findOne({
      ...COMMITTED_CATEGORY_FILTER,
      // Ignore corrupt non-numeric values instead of letting BSON type
      // ordering hide a real numeric fence behind a malformed row.
      fenceGeneration: { $type: 'number' },
    })
      .sort({ fenceGeneration: -1 })
      .select('fenceGeneration')
      .lean()
      .exec();

    const value = row?.fenceGeneration;
    return typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1
      ? value
      : 0;
  }

  /**
   * Copy the current lease onto committed categories that still carry an older
   * generation. Subsequent fenced updates/deletes require the token,
   * generation and a database-time-unexpired `leaseExpiresAt`.
   *
   * Acquisition increments `fenceGeneration` atomically with the lock token.
   * A stale holder that resumes after a newer acquisition therefore cannot
   * overwrite the newer fence: this filter skips newer generations. If the two
   * refreshes overlap, MongoDB serializes them per document; old-then-new ends
   * at the newer fence, while new-then-old makes the old update skip the row.
   */
  protected async refreshLease(
    fence: CategoryMutationFence,
  ): Promise<void> {
    await CategoryModel.updateMany(
      {
        ...COMMITTED_CATEGORY_FILTER,
        $or: [
          { fenceGeneration: { $exists: false } },
          { fenceGeneration: { $lt: fence.generation } },
        ],
      },
      {
        $set: {
          mutationToken: fence.token,
          fenceGeneration: fence.generation,
          leaseExpiresAt: fence.expiresAt,
        },
      },
      { timestamps: false },
    ).exec();
  }

  /**
   * Remove staged rows that this lease supersedes: older generations, plus a
   * same-generation row with a different token (possible when a recreated lock
   * counter collides on its first acquisition). They are invisible, so deleting
   * them loses no committed data, and it prevents their creator's own fence
   * from committing them after this acquisition took over. A staged row from a
   * strictly newer generation is deliberately preserved.
   */
  private async revokeOlderStaged(
    fence: CategoryMutationFence,
  ): Promise<void> {
    await CategoryModel.deleteMany({
      ...STAGED_CATEGORY_FILTER,
      $or: [
        { fenceGeneration: { $lt: fence.generation } },
        {
          fenceGeneration: fence.generation,
          mutationToken: { $ne: fence.token },
        },
      ],
    }).exec();
  }

  /**
   * Remove staged rows left by crashed or stale requests. A live staged row has
   * a future database-time expiry and is untouched. A stale request that
   * inserts after this cleanup can only create another invisible row; it still
   * cannot commit because its own lease expiry is in the past.
   */
  private async cleanupExpiredStaged(): Promise<void> {
    await CategoryModel.deleteMany({
      ...STAGED_CATEGORY_FILTER,
      $or: [
        { leaseExpiresAt: { $exists: false } },
        { $expr: { $lte: ['$leaseExpiresAt', '$$NOW'] } },
      ],
    }).exec();
  }
}

export const categoryRepository = new CategoryRepository();
