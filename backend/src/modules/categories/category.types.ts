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
