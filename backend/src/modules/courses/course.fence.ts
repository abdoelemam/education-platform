/**
 * A content-write fence held by the current course edit lease.
 *
 * `token` identifies the lease holder. `expiresAt` is written to every content
 * document when the lease is acquired so a later write can be rejected by the
 * database once the lease is no longer valid.
 */
export interface CourseEditFence {
  token: string;
  expiresAt: Date;
}

/**
 * Filter fragment that a write must satisfy to be allowed under `fence`.
 *
 * The expiry check uses MongoDB's `$$NOW`, not the application clock at the
 * time the request started. A request that stalls and reaches the database
 * after the lease expired therefore cannot match, even if it built its query
 * before expiry.
 */
export function activeEditFenceFilter(
  fence: CourseEditFence,
): Record<string, unknown> {
  return {
    editToken: fence.token,
    $expr: { $gt: ['$editLeaseExpiresAt', '$$NOW'] },
  };
}

/**
 * The course document stores the lease token under `editLockToken`; content
 * documents use `editToken`. Both checks use database time.
 */
export function activeCourseEditFenceFilter(
  fence: CourseEditFence,
): Record<string, unknown> {
  return {
    editLocked: true,
    editLockToken: fence.token,
    $expr: { $gt: ['$editLeaseExpiresAt', '$$NOW'] },
  };
}

/**
 * Content documents created during a mutation start uncommitted. They become
 * visible only after a fenced commit succeeds. A stale request that inserts
 * after its lease expired can therefore leave only an invisible staged row.
 */
export const COMMITTED_CONTENT_FILTER: Record<string, unknown> = {
  committed: { $ne: false },
};
