# Category Backend Foundation

Status: backend complete. Course ↔ category linking, catalog filtering and the
publishing requirement are a separate phase/PR.

## Purpose

Categories organize courses into a nested taxonomy, for example:

```text
Programming
└── Frontend
    └── React
```

This phase provides the category graph, admin management and a public active
tree. It does **not** add `categoryId` to courses, filter the catalog, or make a
category mandatory at publish time.

## Data Model

`backend/src/modules/categories/category.model.ts`

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Required, trimmed, 2–100 characters |
| `slug` | string | Required, unique, lowercase, server-generated, immutable |
| `description` | string? | Optional, trimmed, up to 1000 characters |
| `parentId` | ObjectId? | Absent for root categories; references `Category` |
| `isActive` | boolean | Default `true`; inactive branches are hidden publicly |
| `sortOrder` | number | Integer, default `0`, used for deterministic ordering |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps |

Internal-only fields (`committed`, `mutationToken`, `fenceGeneration`,
`leaseExpiresAt`) implement staged creation and the tree-mutation fence. They are
never mapped to API responses. Legacy rows with no `committed` field are treated
as committed.

Indexes:

- unique `slug`
- `{ parentId, sortOrder, name }` for child loading/order
- `{ isActive, parentId, sortOrder }` for public tree scans
- `{ committed, mutationToken, leaseExpiresAt }` for token-scoped release and
  expired staged-row cleanup
- `{ committed, fenceGeneration }` for generation-guarded lease refresh

The hierarchy uses an adjacency list (`parentId`), not a denormalized ancestor
path. A move therefore cannot leave stale descendant metadata.

### Slugs

Slugs are generated from `name` and are never changed by a rename:

```text
Programming  → programming
Programming  → programming-2
Programming  → programming-3
```

Non-latin names fall back to a random `category-<hex>` slug. The unique index is
the source of truth; creation retries on a duplicate-key race.

## Public API

### `GET /api/categories`

Returns only active categories whose entire ancestor chain is active. Inactive
nodes and their descendants are omitted. Management fields (`isActive`,
`sortOrder`, timestamps) are never exposed.

```json
{
  "success": true,
  "data": {
    "categories": [
      {
        "id": "665f…",
        "name": "Programming",
        "slug": "programming",
        "description": "Software development",
        "parentId": null,
        "children": [
          {
            "id": "665f…",
            "name": "Frontend",
            "slug": "frontend",
            "parentId": "665f…",
            "children": []
          }
        ]
      }
    ]
  }
}
```

Ordering is `sortOrder` ascending, then `name`, at every level. The tree builder
is defensive: a missing parent or a cycle inserted directly into the database is
omitted rather than causing infinite recursion.

## Admin API

All routes require an authenticated user with `role = "admin"`. State-changing
routes also require the `X-CSRF-Token` header.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/categories` | Flat list of all categories (active and inactive) |
| `POST` | `/api/admin/categories` | Create a category |
| `GET` | `/api/admin/categories/:categoryId` | Get one category |
| `PATCH` | `/api/admin/categories/:categoryId` | Update name/description/parent/active/order |
| `DELETE` | `/api/admin/categories/:categoryId` | Delete an unused leaf category |

Create body:

```json
{
  "name": "Frontend",
  "description": "Browser applications",
  "parentId": "665f…",
  "isActive": true,
  "sortOrder": 10
}
```

Update body accepts any subset. `parentId: null` moves a category to the root.
`description: null` clears the description. An empty update body is rejected.

Create and update bodies are strict: unknown fields such as `slug` or
`createdAt` are rejected with `422 VALIDATION_ERROR` rather than silently
stripped. `isActive` remains a documented admin field so an inactive branch can
be created or hidden intentionally. ObjectIds are case-insensitive hex; request
params and `parentId` are normalized to lowercase before comparison or storage.

The admin response includes management fields:

```json
{
  "id": "665f…",
  "name": "Frontend",
  "slug": "frontend",
  "description": "Browser applications",
  "parentId": "665f…",
  "isActive": true,
  "sortOrder": 10,
  "createdAt": "2026-10-22T00:00:00.000Z",
  "updatedAt": "2026-10-22T00:00:00.000Z"
}
```

## Hierarchy Rules

- A category cannot be its own parent.
- A category cannot be moved under one of its descendants.
- Maximum depth is 10 (roots have depth 0). A move is rejected if the moved
  subtree would exceed the cap.
- A parent must exist.
- Parent changes that would hide a branch containing `approved` or `published`
  courses are rejected once course references exist.
- Deactivation is rejected when the subtree contains `approved` or `published`
  courses.

The category graph is small, so mutations load the graph and validate it as a
unit. This avoids stale ancestor paths and makes cycle checks exhaustive.

### Tree mutation lock and write fence

MongoDB standalone deployments cannot use multi-document transactions, and a
category move touches parent/child relationships across documents. A singleton
`CategoryLock` document serializes category-tree mutations:

- acquire is an atomic `findOneAndUpdate` against an unlocked lock or one whose
  `expiresAt` is in the past. Both checks use MongoDB server time (`$$NOW`), not
  the application clock.
- the lease lasts 30 seconds and carries a random token
- the same atomic acquisition increments a monotonic `fenceGeneration` on the
  lock document. The generation survives release, so in normal operation a later
  acquisition has a higher generation than an earlier one
- immediately after acquisition, the lease reconciles its generation against the
  highest generation on a committed row. If the singleton was deleted, recreated
  or restored from an older snapshot, the counter can be lower than a fence that
  an earlier writer already copied onto rows. The lease is then raised above
  that row generation with a single token/generation/expiry-guarded atomic lock
  update while it still owns the lock, so the refresh below rewrites every older
  fence. The row query supplies only the floor; the guarded lock update is what
  makes the new generation authoritative and cannot interleave with another
  acquisition
- while holding the lease, the writer copies `mutationToken`, `fenceGeneration`
  and `leaseExpiresAt` onto committed category rows whose generation is missing
  or older. It never overwrites a newer generation
- after the refresh, acquisition re-checks that the same token/generation still
  owns the lock and that its database-time expiry is still in the future. If not,
  it aborts with `409 CATEGORY_BUSY` and performs only token-scoped cleanup
- a concurrent writer receives `409 CATEGORY_BUSY`
- a missing/malformed lock expiry is treated as stale instead of blocking the
  tree forever
- release retires the lease from committed rows, removes staged rows created by
  that lease, and only then clears the lock document. Release failures are
  logged; the lease expires on its own and the operation is not retroactively
  reported as failed. The lock's `fenceGeneration` is retained for the next
  acquisition.

The singleton lock is not the only safety mechanism. Every category write
carries a fence checked by MongoDB at write time:

- update/delete/commit filters require the current `mutationToken`, matching
  `fenceGeneration`, and `leaseExpiresAt > $$NOW`
- a create inserts a `committed: false` staged row and then performs a fenced
  commit. Staged rows are excluded from every admin/public read.
- a request that stalls past its lease cannot update, delete or commit a create,
  even if it already validated the tree and is about to write. It receives
  `409 CATEGORY_BUSY`; a stale staged row is invisible and is cleaned up on a
  later lock acquisition.

A stale token is therefore not treated as authority after takeover. The
database-time fence, not token-only release, is what prevents stale writes.

The generation guard is what prevents a late `refreshLease` from an older holder
from rewriting a newer fence. Because acquisition increments the generation in
the same atomic lock update that changes the token, a stale refresh can only
match rows that still have an older generation. If two refreshes overlap,
MongoDB serializes them per document: old-then-new ends at the newer fence, and
new-then-old makes the older refresh skip that row. The post-refresh
revalidation prevents the older holder from returning a usable lease after it
has lost ownership; its token-scoped release cannot clear the newer holder's
fences or staged rows.

The generation reconciliation closes the remaining lock-document-loss path. If
the singleton is deleted, recreated or restored at an older generation, the next
acquisition raises its generation above every fence observed on a committed row
before returning, so a holder that validated under the lost lock no longer
matches a row and its fenced update/delete/commit fails. A stale refresh that
races the reconciliation can only leave a foreign fence that fails the
post-refresh exclusivity check; that denies the current request with
`409 CATEGORY_BUSY` (fail-closed) and never authorizes the stale holders. A later
acquisition recovers.

Acquisition also deletes staged rows that this lease supersedes before
refreshing: older generations, plus a same-generation row with a different token
(possible when a recreated counter collides on its first acquisition). Their
creator's own fence could otherwise still commit them after the takeover. The
delete happens before the refresh, so a racing commit is either included in the
refresh (and fenced by the newer generation) or finds no staged row left to
commit. A staged row from a strictly newer generation is preserved.

The cleanup of expired staged rows only removes rows with a missing or
database-time-expired lease. A valid staged row from a newer holder is preserved
even while another acquisition is running.

Residual boundary: with no multi-document transaction, a live staged row whose
generation is strictly higher than the recreated lock's generation is
indistinguishable from a legitimately newer holder, so it is preserved and its
own live lease may still commit it. That is the documented preservation rule,
not an accidental stale-write path. Closing the ambiguity for a singleton
restored while no committed row supplies a generation floor would require
transactions on a replica set or a durable, non-resettable generation allocator;
the current design does not claim that case.

The lock protects category writes. Course writes that change category membership
must participate in the same boundary when the course-category phase lands.

## Deletion Rules

A category can be deleted only when:

1. it has no child categories, and
2. no course references it.

Deletion uses `409 CATEGORY_HAS_CHILDREN` or `409 CATEGORY_IN_USE` otherwise.
The course-reference check is already present and queries the `courses`
collection for `categoryId`, so the rule becomes effective as soon as the
course-category PR starts writing that field.

That forward-looking query deliberately does not add `categoryId` to the Course
model in this phase. The course-category PR must add a `courses.categoryId`
index for the guard and decide whether course writes that change category
membership participate in the category lock. Until then, the guard is correct
for any references written by future code, but it is not a substitute for that
integration work.

## Error Codes

| Code | HTTP | Meaning |
| --- | --- | --- |
| `CATEGORY_NOT_FOUND` | 404 | Category id does not exist |
| `CATEGORY_PARENT_NOT_FOUND` | 422 | Parent id does not exist |
| `CATEGORY_CYCLE` | 409 | Self-parent or move under a descendant |
| `CATEGORY_MAX_DEPTH` | 422 | Depth cap would be exceeded |
| `CATEGORY_HAS_CHILDREN` | 409 | Delete blocked by child categories |
| `CATEGORY_IN_USE` | 409 | Delete/deactivate blocked by course references |
| `CATEGORY_BUSY` | 409 | Tree mutation lock is held or the request's lease was replaced/expired before its fenced write |
| `VALIDATION_ERROR` | 422 | Zod body/param validation failed |

## Tests

`backend/tests/categories.test.ts` contains 35 integration tests covering:

- authentication/authorization and CSRF
- strict input validation, unknown fields and unknown-category 404s
- nested tree creation, public shape and admin visibility
- unique/stable slug generation
- self/descendant cycle rejection, moved-subtree depth and higher/root moves
- uppercase ObjectId normalization for get/update/delete/parentId
- safe deletion with children and course references
- active-only public visibility and branch hiding (approved and published)
- deterministic ordering
- atomic lock acquisition, stale-lock recovery and legacy locks without expiry
- a late release from an old holder cannot clear the newer holder's lock,
  category fences or staged rows
- a deterministic interleaving where an older holder's lease refresh is paused,
  a newer holder acquires and refreshes, and the older refresh cannot overwrite
  the newer fence; the newer generation is explicitly asserted to be greater and
  the newer holder's fenced write still succeeds
- the opposite refresh ordering: the older refresh lands first, the newer
  holder's strictly higher generation overwrites it, and the older holder's
  later token-scoped release cannot clear the newer fence
- lock-document loss and restore at an older generation: the next lease is
  raised above the existing row fence, the old holder's still-time-valid fence
  cannot write, and the new holder can
- a staged create from a lost lock is revoked before it can commit, including a
  recreated-counter collision with the same generation, while a newer live
  staged row survives
- update and delete rejection when the token/generation match but the
  database-time lease has expired
- a deterministic real-service interleaving where an expired writer is paused
  before its write, a newer writer takes over, and the stale write is rejected
- staged-create fencing after lease expiry and cleanup after a pre-commit crash
- cleanup preserves a newer staged row while its lease is still valid
- cycle safety against corrupt data

## Deferred

- `Course.categoryId`, teacher assignment and catalog `?category=` filtering
- category required at publish time
- category thumbnail/icon and translations
- drag-and-drop ordering UI (the backend `sortOrder` contract exists)
- frontend category administration and public navigation
