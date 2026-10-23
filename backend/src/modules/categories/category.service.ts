import { randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { AppError } from '../../errors/index.js';
import { logger } from '../../utils/logger.js';
import { slugify } from '../../utils/slug.js';
import { AUTH_ERRORS } from '../auth/auth.constants.js';
import type { AuthUser } from '../users/user.types.js';
import {
  CATEGORY_ERRORS,
  CATEGORY_MAX_DEPTH,
  CATEGORY_SLUG_MAX,
  CATEGORY_SLUG_MAX_ATTEMPTS,
} from './category.constants.js';
import type { CategoryMutationFence } from './category.fence.js';
import {
  toAdminCategory,
  toPublicCategoryTree,
} from './category.mapper.js';
import {
  categoryRepository,
  type CategoryRepository,
  type CourseReferenceWrite,
  type CategoryUpdate,
} from './category.repository.js';
import {
  buildCategoryTree,
  categoryDepth,
  categorySubtreeHeight,
  collectAncestorIds,
  collectSubtreeIds,
  isPubliclyVisible,
  isWithinSubtree,
} from './category.tree.js';
import type {
  AdminCategory,
  CategoryDocument,
  PublicCategory,
} from './category.types.js';
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
} from './category.validation.js';

const SLUG_BASE_MAX = CATEGORY_SLUG_MAX - 20;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Mongo ObjectIds are case-insensitive hex, but JavaScript string comparison is
 * not. Normalize every externally supplied id before using it in a textual
 * comparison or writing it back to the database.
 */
function normalizeObjectId(value: string): string {
  return new Types.ObjectId(value).toString();
}

export class CategoryService {
  constructor(
    private readonly repo: CategoryRepository = categoryRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  async listPublicCategories(): Promise<PublicCategory[]> {
    const categories = await this.repo.listAll();
    const tree = buildCategoryTree(categories, { activeOnly: true });
    return toPublicCategoryTree(tree);
  }

  // -------------------------------------------------------------------------
  // Cross-module references (Course ↔ Category)
  // -------------------------------------------------------------------------

  /**
   * Committed categories for modules that validate a category reference.
   *
   * Staged category creates are excluded by the repository, so a caller can
   * never link a course to a category that is still being created.
   */
  async listReferenceCategories(): Promise<CategoryDocument[]> {
    return this.repo.listAll();
  }

  /**
   * Serialize a course-side category reference operation with category tree
   * mutations (delete, deactivate, move, create).
   *
   * A course write that assigns a category holds the course edit lease first
   * and this lease second; category operations never acquire a course lease, so
   * the lock order cannot cycle. Acquisition is non-blocking: a competing tree
   * mutation makes the course operation fail with `409 CATEGORY_BUSY` instead
   * of waiting. Publishing holds this lease through its compare-and-set so an
   * admin cannot hide or delete the category underneath the publication.
   */
  async withCategoryReferenceLock<T>(
    operation: (fence: CategoryMutationFence) => Promise<T>,
  ): Promise<T> {
    return this.withCategoryLock(operation);
  }

  /**
   * Add a normal (draft/rejected) reference to the category itself.
   *
   * The reference is written before the course row. A category delete uses a
   * single-document filter that requires both reference arrays to be empty, so
   * either this write wins (delete is refused) or the delete wins (this write
   * no longer matches). No lease TTL is needed for that guarantee.
   */
  async addDraftCourseReference(params: {
    categoryId: string;
    courseId: string;
    fence: CategoryMutationFence;
  }): Promise<CourseReferenceWrite> {
    return this.repo.addCourseReference(
      normalizeObjectId(params.categoryId),
      params.courseId,
      params.fence,
      { protected: false },
    );
  }

  /**
   * Add protected references to the category and every ancestor.
   *
   * The ancestor copies are what let deactivation/move use a local atomic
   * condition: hiding or moving any node in the path must fail while a
   * protected course exists below it, even if the original category lock lease
   * has expired.
   *
   * Returns the exact categories this call added to, so a failed operation can
   * remove only its own additions and never a pre-existing valid reference.
   */
  async addProtectedCourseReferencePath(params: {
    categories: CategoryDocument[];
    categoryId: string;
    courseId: string;
    fence: CategoryMutationFence;
  }): Promise<{ ok: boolean; addedCategoryIds: string[] }> {
    const path = collectAncestorIds(
      params.categories,
      normalizeObjectId(params.categoryId),
    );
    if (!path) {
      return { ok: false, addedCategoryIds: [] };
    }

    const addedCategoryIds: string[] = [];
    for (const pathCategoryId of path) {
      const result = await this.repo.addCourseReference(
        pathCategoryId,
        params.courseId,
        params.fence,
        { protected: true, requireActive: true },
      );
      if (!result.matched) {
        await this.removeCourseReferences(addedCategoryIds, params.courseId);
        return { ok: false, addedCategoryIds: [] };
      }
      if (result.added) {
        addedCategoryIds.push(pathCategoryId);
      }
    }

    return { ok: true, addedCategoryIds };
  }

  /**
   * Remove a course from its category and all ancestors. Used after a course
   * changes/clears its category, is deleted, or when a failed operation has to
   * roll back a protected reference.
   */
  async removeCourseReferencePath(params: {
    categories: CategoryDocument[];
    categoryId?: string | null;
    courseId: string;
  }): Promise<void> {
    if (!params.categoryId) {
      return;
    }

    const path = collectAncestorIds(
      params.categories,
      normalizeObjectId(params.categoryId),
    ) ?? [normalizeObjectId(params.categoryId)];
    await this.removeCourseReferences(path, params.courseId);
  }

  async removeCourseReferences(
    categoryIds: string[],
    courseId: string,
  ): Promise<void> {
    await Promise.all(
      [...new Set(categoryIds)].map((categoryId) =>
        this.repo.removeCourseReference(categoryId, courseId),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------

  async listAdminCategories(requester: AuthUser): Promise<AdminCategory[]> {
    this.assertAdmin(requester);
    const categories = await this.repo.listAll();
    return categories.map(toAdminCategory);
  }

  async getAdminCategory(params: {
    categoryId: string;
    requester: AuthUser;
  }): Promise<AdminCategory> {
    this.assertAdmin(params.requester);
    const category = await this.repo.findById(
      normalizeObjectId(params.categoryId),
    );
    if (!category) {
      throw this.notFound();
    }
    return toAdminCategory(category);
  }

  async createCategory(params: {
    requester: AuthUser;
    input: CreateCategoryInput;
  }): Promise<AdminCategory> {
    this.assertAdmin(params.requester);

    return this.withCategoryLock(async (fence) => {
      const categories = await this.repo.listAll();
      const parentId =
        params.input.parentId === undefined || params.input.parentId === null
          ? undefined
          : normalizeObjectId(params.input.parentId);

      if (parentId) {
        this.assertParentExists(categories, parentId);
        const parentDepth = categoryDepth(categories, parentId);
        if (!Number.isFinite(parentDepth) || parentDepth + 1 > CATEGORY_MAX_DEPTH) {
          throw this.maxDepthError();
        }
      }

      const base =
        slugify(params.input.name, SLUG_BASE_MAX) ||
        `category-${randomBytes(4).toString('hex')}`;

      for (let attempt = 0; attempt <= CATEGORY_SLUG_MAX_ATTEMPTS; attempt += 1) {
        const slug =
          attempt === 0
            ? base.slice(0, CATEGORY_SLUG_MAX)
            : `${base.slice(0, SLUG_BASE_MAX)}-${attempt + 1}`;

        try {
          const staged = await this.repo.create(
            {
              name: params.input.name,
              slug,
              description: params.input.description || undefined,
              parentId,
              isActive: params.input.isActive,
              sortOrder: params.input.sortOrder,
            },
            fence,
          );

          const committed = await this.repo.commitCreated(
            staged._id.toString(),
            fence,
          );
          if (!committed) {
            await this.discardStaged(staged._id.toString());
            throw this.conflictError();
          }

          return toAdminCategory(committed);
        } catch (error) {
          if (!isDuplicateKeyError(error)) {
            throw error;
          }
        }
      }

      const staged = await this.repo.create(
        {
          name: params.input.name,
          slug: `${base.slice(0, SLUG_BASE_MAX)}-${randomBytes(4).toString('hex')}`,
          description: params.input.description || undefined,
          parentId,
          isActive: params.input.isActive,
          sortOrder: params.input.sortOrder,
        },
        fence,
      );
      const committed = await this.repo.commitCreated(
        staged._id.toString(),
        fence,
      );
      if (!committed) {
        await this.discardStaged(staged._id.toString());
        throw this.conflictError();
      }
      return toAdminCategory(committed);
    });
  }

  async updateCategory(params: {
    categoryId: string;
    requester: AuthUser;
    input: UpdateCategoryInput;
  }): Promise<AdminCategory> {
    this.assertAdmin(params.requester);
    const categoryId = normalizeObjectId(params.categoryId);

    return this.withCategoryLock(async (fence) => {
      const categories = await this.repo.listAll();
      const category = categories.find(
        (item) => item._id.toString() === categoryId,
      );
      if (!category) {
        throw this.notFound();
      }

      const update: CategoryUpdate = {};
      const unset: string[] = [];
      let requiresProtectedGuard = false;

      if (params.input.name !== undefined) {
        update.name = params.input.name;
      }

      if (params.input.description !== undefined) {
        if (params.input.description === null || params.input.description === '') {
          unset.push('description');
        } else {
          update.description = params.input.description;
        }
      }

      if (params.input.sortOrder !== undefined) {
        update.sortOrder = params.input.sortOrder;
      }

      if (params.input.isActive !== undefined) {
        update.isActive = params.input.isActive;
        if (params.input.isActive === false) {
          await this.assertNoProtectedCourses(categories, categoryId);
          requiresProtectedGuard = true;
        }
      }

      if (params.input.parentId !== undefined) {
        if (params.input.parentId === null) {
          unset.push('parentId');
        } else {
          const parentId = normalizeObjectId(params.input.parentId);
          this.assertParentExists(categories, parentId);
          if (isWithinSubtree(categories, parentId, categoryId)) {
            throw new AppError(
              409,
              CATEGORY_ERRORS.CATEGORY_CYCLE,
              'A category cannot be moved under itself or one of its descendants',
            );
          }

          const parentDepth = categoryDepth(categories, parentId);
          const subtreeHeight = categorySubtreeHeight(categories, categoryId);
          if (
            !Number.isFinite(parentDepth) ||
            !Number.isFinite(subtreeHeight) ||
            parentDepth + 1 + subtreeHeight > CATEGORY_MAX_DEPTH
          ) {
            throw this.maxDepthError();
          }

          update.parentId = new Types.ObjectId(parentId);

          if (!isPubliclyVisible(categories, parentId)) {
            await this.assertNoProtectedCourses(categories, categoryId);
            requiresProtectedGuard = true;
          }
        }
      }

      const updated = await this.repo.updateById(
        categoryId,
        update,
        unset,
        fence,
        requiresProtectedGuard
          ? { 'protectedCourseRefs.0': { $exists: false } }
          : {},
      );
      if (!updated) {
        // A competing approval/publish may have protected the branch after the
        // pre-check, or the lease expired before this write. Re-check the
        // durable guard so the client gets the specific in-use error when
        // possible instead of a generic busy conflict.
        if (
          requiresProtectedGuard &&
          (await this.repo.hasProtectedCourseReferences([categoryId]))
        ) {
          throw this.inUseError();
        }
        // The row was deleted directly in the database, or this request lost
        // its lease between validation and the fenced write.
        throw this.conflictError();
      }

      return toAdminCategory(updated);
    });
  }

  async deleteCategory(params: {
    categoryId: string;
    requester: AuthUser;
  }): Promise<void> {
    this.assertAdmin(params.requester);
    const categoryId = normalizeObjectId(params.categoryId);

    return this.withCategoryLock(async (fence) => {
      const categories = await this.repo.listAll();
      const category = categories.find(
        (item) => item._id.toString() === categoryId,
      );
      if (!category) {
        throw this.notFound();
      }

      const childCount = categories.filter(
        (item) => item.parentId?.toString() === categoryId,
      ).length;
      if (childCount > 0) {
        throw new AppError(
          409,
          CATEGORY_ERRORS.CATEGORY_HAS_CHILDREN,
          'A category with child categories cannot be deleted',
          { children: childCount },
        );
      }

      if (await this.repo.hasCourseReference(categoryId)) {
        throw new AppError(
          409,
          CATEGORY_ERRORS.CATEGORY_IN_USE,
          'A category referenced by a course cannot be deleted',
        );
      }

      const deleted = await this.repo.deleteById(categoryId, fence, {
        'courseRefs.0': { $exists: false },
        'protectedCourseRefs.0': { $exists: false },
      });
      if (!deleted) {
        // A course reference may have been added after the pre-check. The
        // reference and delete are single-document operations on this row, so
        // MongoDB serializes them: either our delete wins, or it must fail.
        if (await this.repo.hasCourseReference(categoryId)) {
          throw new AppError(
            409,
            CATEGORY_ERRORS.CATEGORY_IN_USE,
            'A category referenced by a course cannot be deleted',
          );
        }
        throw this.conflictError();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async withCategoryLock<T>(
    operation: (fence: CategoryMutationFence) => Promise<T>,
  ): Promise<T> {
    const lease = await this.repo.acquireLock();
    if (!lease) {
      throw new AppError(
        409,
        CATEGORY_ERRORS.CATEGORY_BUSY,
        'The category tree is being modified; retry shortly',
      );
    }

    try {
      return await operation(lease);
    } finally {
      try {
        await this.repo.releaseLock(lease.token);
      } catch (error) {
        // Releasing is best effort: the lease expires on its own. Do not mask
        // an operation error, and do not turn a committed mutation into a 500
        // just because the release write failed. Never log the lease token.
        logger.error('Failed to release category tree lock', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async discardStaged(id: string): Promise<void> {
    try {
      await this.repo.deleteStaged(id);
    } catch (error) {
      // The row is invisible and will be removed by the next lock
      // acquisition's expired-staged cleanup.
      logger.warn('Failed to discard staged category', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private assertAdmin(requester: AuthUser): void {
    if (requester.role !== 'admin') {
      throw new AppError(
        403,
        AUTH_ERRORS.FORBIDDEN,
        'Admin access required',
      );
    }
  }

  private assertParentExists(
    categories: CategoryDocument[],
    parentId: string,
  ): void {
    const normalizedParentId = normalizeObjectId(parentId);
    const parent = categories.find(
      (category) => category._id.toString() === normalizedParentId,
    );
    if (!parent) {
      throw new AppError(
        422,
        CATEGORY_ERRORS.CATEGORY_PARENT_NOT_FOUND,
        'The parent category does not exist',
      );
    }
  }

  private async assertNoProtectedCourses(
    categories: CategoryDocument[],
    categoryId: string,
  ): Promise<void> {
    const subtreeIds = collectSubtreeIds(categories, categoryId);
    if (await this.repo.hasProtectedCourseReferences(subtreeIds)) {
      throw this.inUseError();
    }
  }

  private inUseError(): AppError {
    return new AppError(
      409,
      CATEGORY_ERRORS.CATEGORY_IN_USE,
      'A category with approved or published courses cannot be hidden',
    );
  }

  private maxDepthError(): AppError {
    return new AppError(
      422,
      CATEGORY_ERRORS.CATEGORY_MAX_DEPTH,
      `Category depth cannot exceed ${CATEGORY_MAX_DEPTH}`,
    );
  }

  private conflictError(): AppError {
    return new AppError(
      409,
      CATEGORY_ERRORS.CATEGORY_BUSY,
      'The category tree changed while the request was running; retry shortly',
    );
  }

  private notFound(): AppError {
    return new AppError(
      404,
      CATEGORY_ERRORS.CATEGORY_NOT_FOUND,
      'Category not found',
    );
  }
}

export const categoryService = new CategoryService();
