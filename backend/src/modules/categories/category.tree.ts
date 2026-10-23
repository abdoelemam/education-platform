import { CATEGORY_MAX_DEPTH } from './category.constants.js';
import type { CategoryDocument } from './category.types.js';

export interface CategoryTreeNode {
  category: CategoryDocument;
  children: CategoryTreeNode[];
}

export interface BuildCategoryTreeOptions {
  /** Public callers must only see active nodes with active ancestors. */
  activeOnly: boolean;
}

function byId(categories: CategoryDocument[]): Map<string, CategoryDocument> {
  return new Map(categories.map((category) => [category._id.toString(), category]));
}

function sortCategories(
  categories: CategoryDocument[],
): CategoryDocument[] {
  return [...categories].sort((a, b) => {
    const orderDifference = a.sortOrder - b.sortOrder;
    if (orderDifference !== 0) {
      return orderDifference;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * Depth of a category from its root (roots have depth 0).
 *
 * Returns `Infinity` for missing parents or cycles so callers can reject a
 * corrupt tree rather than traversing forever.
 */
export function categoryDepth(
  categories: CategoryDocument[],
  categoryId: string,
): number {
  const map = byId(categories);
  const seen = new Set<string>();
  let current = map.get(categoryId);

  if (!current) {
    return Number.POSITIVE_INFINITY;
  }

  let depth = 0;
  while (current.parentId) {
    const currentId = current._id.toString();
    if (seen.has(currentId)) {
      return Number.POSITIVE_INFINITY;
    }
    seen.add(currentId);

    const parent = map.get(current.parentId.toString());
    if (!parent) {
      return Number.POSITIVE_INFINITY;
    }

    depth += 1;
    if (depth > CATEGORY_MAX_DEPTH * 2) {
      return Number.POSITIVE_INFINITY;
    }
    current = parent;
  }

  return depth;
}

/**
 * Height of a category's subtree relative to itself (a leaf has height 0).
 * Returns `Infinity` when the graph contains a cycle or a missing parent.
 */
export function categorySubtreeHeight(
  categories: CategoryDocument[],
  categoryId: string,
): number {
  const childrenByParent = new Map<string, CategoryDocument[]>();
  for (const category of categories) {
    if (!category.parentId) {
      continue;
    }
    const parentId = category.parentId.toString();
    const bucket = childrenByParent.get(parentId);
    if (bucket) {
      bucket.push(category);
    } else {
      childrenByParent.set(parentId, [category]);
    }
  }

  const map = byId(categories);
  if (!map.has(categoryId)) {
    return Number.POSITIVE_INFINITY;
  }

  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (visiting.has(id)) {
      return Number.POSITIVE_INFINITY;
    }
    visiting.add(id);

    let height = 0;
    for (const child of childrenByParent.get(id) ?? []) {
      const childId = child._id.toString();
      const childHeight = visit(childId);
      if (!Number.isFinite(childHeight)) {
        visiting.delete(id);
        return Number.POSITIVE_INFINITY;
      }
      height = Math.max(height, childHeight + 1);
    }

    visiting.delete(id);
    return height;
  };

  return visit(categoryId);
}

/**
 * True when `candidateId` is `ancestorId` or one of its descendants.
 *
 * Used before a parent update: setting `category.parentId = candidateId` must
 * be rejected when the candidate is the category itself or is inside its
 * current subtree.
 */
export function isWithinSubtree(
  categories: CategoryDocument[],
  candidateId: string,
  ancestorId: string,
): boolean {
  if (candidateId === ancestorId) {
    return true;
  }

  const map = byId(categories);
  const seen = new Set<string>();
  let current = map.get(candidateId);

  while (current) {
    const currentId = current._id.toString();
    if (seen.has(currentId)) {
      return true;
    }
    seen.add(currentId);

    if (!current.parentId) {
      return false;
    }

    const parentId = current.parentId.toString();
    if (parentId === ancestorId) {
      return true;
    }
    current = map.get(parentId);
  }

  return false;
}

/**
 * True only when the category and every ancestor are active. A category can be
 * active itself while hidden under an inactive branch; public visibility and
 * future publishing checks must use this helper rather than `isActive` alone.
 */
export function isPubliclyVisible(
  categories: CategoryDocument[],
  categoryId: string,
): boolean {
  const map = byId(categories);
  const seen = new Set<string>();
  let current = map.get(categoryId);

  while (current) {
    const currentId = current._id.toString();
    if (seen.has(currentId)) {
      return false;
    }
    seen.add(currentId);

    if (!current.isActive) {
      return false;
    }

    if (!current.parentId) {
      return true;
    }

    current = map.get(current.parentId.toString());
  }

  return false;
}

/**
 * Root-to-node ancestry for a category, including the category itself.
 * Returns `null` when any link is missing or the graph contains a cycle, so
 * callers never write a reference onto an incomplete path.
 */
export function collectAncestorIds(
  categories: CategoryDocument[],
  categoryId: string,
): string[] | null {
  const map = byId(categories);
  const path: string[] = [];
  const seen = new Set<string>();
  let current = map.get(categoryId);

  if (!current) {
    return null;
  }

  while (current) {
    const currentId = current._id.toString();
    if (seen.has(currentId)) {
      return null;
    }
    seen.add(currentId);
    path.push(currentId);

    if (!current.parentId) {
      return path.reverse();
    }

    current = map.get(current.parentId.toString());
  }

  return null;
}

/** Category ids in a subtree, including the root. Cycle-safe. */
export function collectSubtreeIds(
  categories: CategoryDocument[],
  categoryId: string,
): string[] {
  const childrenByParent = new Map<string, CategoryDocument[]>();
  for (const category of categories) {
    if (!category.parentId) {
      continue;
    }
    const parentId = category.parentId.toString();
    const bucket = childrenByParent.get(parentId);
    if (bucket) {
      bucket.push(category);
    } else {
      childrenByParent.set(parentId, [category]);
    }
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  const queue = [categoryId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);

    for (const child of childrenByParent.get(id) ?? []) {
      queue.push(child._id.toString());
    }
  }

  return ids;
}

/**
 * Build a deterministic tree. Nodes that are inactive, have an inactive
 * ancestor, have a missing parent, or participate in a cycle are omitted.
 * This is deliberately defensive: writes prevent these states, but a corrupt
 * historical row must never make a public request loop forever.
 */
export function buildCategoryTree(
  categories: CategoryDocument[],
  options: BuildCategoryTreeOptions,
): CategoryTreeNode[] {
  const map = byId(categories);
  const visibility = new Map<string, boolean>();
  const resolving = new Set<string>();

  const isVisible = (id: string): boolean => {
    const cached = visibility.get(id);
    if (cached !== undefined) {
      return cached;
    }

    const category = map.get(id);
    if (!category) {
      return false;
    }

    if (resolving.has(id)) {
      visibility.set(id, false);
      return false;
    }

    if (options.activeOnly && !category.isActive) {
      visibility.set(id, false);
      return false;
    }

    if (!category.parentId) {
      visibility.set(id, true);
      return true;
    }

    resolving.add(id);
    const parentVisible = isVisible(category.parentId.toString());
    resolving.delete(id);
    visibility.set(id, parentVisible);
    return parentVisible;
  };

  const visibleCategories = sortCategories(categories).filter((category) =>
    isVisible(category._id.toString()),
  );
  const nodes = new Map<string, CategoryTreeNode>();
  for (const category of visibleCategories) {
    nodes.set(category._id.toString(), { category, children: [] });
  }

  const roots: CategoryTreeNode[] = [];
  for (const category of visibleCategories) {
    const node = nodes.get(category._id.toString())!;
    const parentId = category.parentId?.toString();

    if (!parentId) {
      roots.push(node);
      continue;
    }

    const parent = nodes.get(parentId);
    if (!parent) {
      // The parent was hidden or corrupt. Do not expose an orphan as a root in
      // the public tree; admin visibility uses the same safe behavior.
      continue;
    }

    parent.children.push(node);
  }

  return roots;
}
