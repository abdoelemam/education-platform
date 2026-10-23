import type {
  AdminCategory,
  CategoryDocument,
  PublicCategory,
} from './category.types.js';
import type { CategoryTreeNode } from './category.tree.js';

export function toAdminCategory(category: CategoryDocument): AdminCategory {
  return {
    id: category._id.toString(),
    name: category.name,
    slug: category.slug,
    description: category.description,
    parentId: category.parentId?.toString() ?? null,
    isActive: category.isActive,
    sortOrder: category.sortOrder,
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

export function toPublicCategoryTree(
  nodes: CategoryTreeNode[],
): PublicCategory[] {
  return nodes.map((node) => ({
    id: node.category._id.toString(),
    name: node.category.name,
    slug: node.category.slug,
    description: node.category.description,
    parentId: node.category.parentId?.toString() ?? null,
    children: toPublicCategoryTree(node.children),
  }));
}
