/**
 * Category-tree mutation fence.
 *
 * The singleton lock document serializes the read/validate/write sequence. The
 * fence is written to committed category rows when a lease is acquired and is
 * checked by every category write. A request whose lease expired or was
 * replaced cannot write, even if it was paused between validating the tree and
 * reaching the database. A monotonic generation ensures an older holder's late
 * refresh cannot overwrite a newer fence.
 */
export interface CategoryMutationFence {
  token: string;
  /**
   * Monotonic generation of the lock acquisition. The generation is incremented
   * atomically when the singleton lock is acquired and copied to every category
   * row. It is only used to stop an older lease from overwriting a newer fence.
   */
  generation: number;
  /** Database-time lease expiry copied to every committed category. */
  expiresAt: Date;
}

/**
 * Filter fragment that a category write must satisfy to be allowed under
 * `fence`.
 *
 * The expiry comparison uses MongoDB's `$$NOW`, not the application clock. A
 * stale request that reaches the database after its lease expired therefore
 * cannot match, regardless of process pauses or cross-instance clock skew.
 */
export function activeCategoryFenceFilter(
  fence: CategoryMutationFence,
): Record<string, unknown> {
  return {
    mutationToken: fence.token,
    fenceGeneration: fence.generation,
    $expr: { $gt: ['$leaseExpiresAt', '$$NOW'] },
  };
}

/**
 * Category rows created by a mutation are staged and become visible only after
 * a fenced commit succeeds. A stale request that inserts after its lease
 * expired can therefore leave only an invisible staged row.
 */
export const COMMITTED_CATEGORY_FILTER: Record<string, unknown> = {
  committed: { $ne: false },
};

export const STAGED_CATEGORY_FILTER: Record<string, unknown> = {
  committed: false,
};
