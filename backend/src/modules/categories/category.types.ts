import type { Document, Types } from 'mongoose';

/**
 * A category node in an adjacency-list tree.
 *
 * `parentId` is absent for root categories. The public tree is built from the
 * whole category collection so a corrupt parent reference can never create an
 * infinite traversal; see `category.tree.ts`.
 */
export interface ICategory {
  name: string;
  /** URL-safe, unique, server-generated identifier. Immutable after creation. */
  slug: string;
  description?: string;
  parentId?: Types.ObjectId;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;

  /*
   * Internal mutation fence. These fields are never mapped to API responses.
   * `committed` is absent on legacy rows and treated as committed; new rows are
   * inserted with `committed: false` and become visible only after a fenced
   * commit.
   */
  committed?: boolean;
  mutationToken?: string;
  /** Monotonic lease generation used to reject stale fence refreshes. */
  fenceGeneration?: number;
  leaseExpiresAt?: Date;

  /*
   * Course-reference membership.
   *
   * `courseRefs` contains every course directly assigned to this category. It
   * is written before the course row and blocks category deletion, so a stale
   * course write can never outlive the category it references.
   *
   * `protectedCourseRefs` is the subset belonging to approved, published, or
   * currently-publishing courses. It is also copied to every ancestor of the
   * assigned category. Deactivation and moves check this field atomically, so a
   * category branch cannot be hidden while a protected course lives below it.
   *
   * These are internal fields and are never mapped to API responses.
   */
  courseRefs?: Types.ObjectId[];
  protectedCourseRefs?: Types.ObjectId[];
}

export interface CategoryDocument extends ICategory, Document<Types.ObjectId> {
  _id: Types.ObjectId;
}

/**
 * Admin representation. Unlike the public shape it includes lifecycle/order
 * fields needed by the management UI.
 */
export interface AdminCategory {
  id: string;
  name: string;
  slug: string;
  description?: string;
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Public category tree node. Only active nodes with active ancestors are
 * returned, and no management-only fields are exposed.
 */
export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  description?: string;
  parentId: string | null;
  children: PublicCategory[];
}
