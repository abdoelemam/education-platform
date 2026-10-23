# Course Builder

Backend implementation of the Course Builder phase: teachers create a course and
build its section/lesson structure. The frontend is not initialized yet, so this
document is the API contract the frontend will consume later.

## Architecture

```text
Course (metadata, owner, status, slug)
   └── Section (ordered, belongs to one course)
          └── Lesson (ordered, typed, belongs to one section + course)
```

Decisions:

- **Separate collections** (`Course`, `Section`, `Lesson`) rather than embedded
  arrays. Structural operations stay simple, cascade deletes are explicit, and
  the models match the domain entities in `ARCHITECTURE.md`.
- **Ordering is explicit and persisted** as a 1-based `order` field. Add
  operations append after the current maximum; dedicated reorder endpoints
  receive the complete ordered id list and rewrite only the `order` fields.
  Gaps after deletion are allowed; a reorder renumbers contiguously.
- **Ownership is the authorization boundary.** Every operation loads the course
  and requires `course.ownerId === requester.id`, except admins. A section or
  lesson id from another course is treated as missing (`404`).
- **Server-owned fields.** `ownerId`, `slug`, `status`, `order`, `submittedAt`,
  `reviewedAt`, `reviewedBy`, `rejectionReason` and the internal `editLocked` /
  `editLockedAt` / `editLockToken` / `editLeaseExpiresAt` lease are never
  accepted from the client. Section/lesson `editToken`, `editLeaseExpiresAt`
  and `committed` staging fields are also internal. Unknown body fields are
  stripped by Zod.
- **Review state machine.** The Teacher Workflow owns the review transitions
  (`draft`/`rejected` → `pending_review` and `pending_review` →
  `approved`/`rejected`); the owner publishes an approved course
  (`approved` → `published`) after server-side completeness validation.
  Editing is frozen while a course is `pending_review`, `approved` or
  `published`, so an admin reviews exactly the version that was submitted and a
  published course cannot change underneath students.
- **Compare-and-set transitions.** Review transitions update the course only if
  its stored status and reviewed submission (`submittedAt`) are still the ones
  the reviewer loaded, so two concurrent reviewers (or an old review request
  racing a rejection/resubmission) cannot both win.
- **Exclusive content-edit lease with a database-enforced fence.** Every course,
  section and lesson mutation claims a per-course database lease before
  writing and releases it in a `finally` block. Acquiring the lease stamps the
  lease token and expiry onto every existing section and lesson. Every update,
  delete, reorder and create commit then includes the token and a
  MongoDB-server-time (`$$NOW`) expiry check in its write filter, so a stale
  request cannot write after its lease expired or was replaced. Creates are
  inserted as hidden staged rows and become visible only after a fenced
  course-authorization write and a fenced commit. Submission only transitions
  while that lease is free. Whichever request wins the lease/status race, a
  content write cannot land after the review snapshot is taken. A lease older
  than five minutes is treated as abandoned and can be recovered, so a process
  crash does not block the course forever.

## Lifecycle

```text
draft ──submit (owner)──▶ pending_review ──approve (admin)──▶ approved
                                 │                              │
                                 └──reject (admin + reason)──▶ rejected
                                                                  ▲
rejected ──edit + submit (owner)──▶ pending_review                │
                                                                  │
approved ──publish (owner)──▶ published                           │
```

| From | To | Actor | Notes |
| --- | --- | --- | --- |
| `draft` | `pending_review` | Course owner | Sets `submittedAt`; clears any previous review |
| `rejected` | `pending_review` | Course owner | Same; the old rejection reason is cleared |
| `pending_review` | `approved` | Admin | Sets `reviewedAt` / `reviewedBy` |
| `pending_review` | `rejected` | Admin | Sets `reviewedAt` / `reviewedBy` and the required `rejectionReason` |
| `approved` | `published` | Course owner | Validates completeness, sets `publishedAt` |

`published` (and `archived`) are terminal for this phase. An `approved` course
cannot be edited or resubmitted; the owner can publish it or leave it approved.
A published course cannot be edited, deleted, unpublished or archived yet.

A course may be deleted only while it is a `draft` or `rejected`. Courses under
review or already approved cannot be deleted (including by an admin), because
deletion would silently withdraw a submission or remove reviewed content. A
pending submission must be rejected before cleanup; an explicit withdrawal flow
is a future feature.

### Editing rules

- Editable: `draft`, `rejected`.
- Locked (`409 COURSE_NOT_EDITABLE`): `pending_review`, `approved`, `published`,
  `archived`.
- Content mutations are exclusive per course. A second edit while another edit
  holds the lease gets `409 COURSE_EDIT_IN_PROGRESS`; retry after it completes.
- Submission is conditional on the content lease being free. If an edit claimed
  the lease first, submission gets `409 COURSE_EDIT_IN_PROGRESS`; if submission
  wins first, the edit gets `409 COURSE_NOT_EDITABLE`. A content write therefore
  cannot land after the course is submitted.
- A lease older than five minutes is considered abandoned (for example, after a
  crashed process) and is cleared by the next edit or submission. Lease
  ownership is rechecked in the database at each write, not only when the
  request starts: the write must match the current token and an unexpired
  MongoDB-server-time lease. A stalled request that resumes after recovery
  therefore gets `409 COURSE_EDIT_IN_PROGRESS` instead of committing.
- Creates are staged with `committed: false`. The service first performs a
  fenced authorization write on the course, then commits the staged row with
  the same fence. A stale creator can leave only an invisible staged row, which
  the next lease acquisition cleans up. When recovering a stale lease, the new
  holder snapshots the rows that existed and discards rows created during
  recovery, including a staged row that the old holder flips to committed just
  before cleanup.
- A rejected course can be edited freely and then resubmitted. Resubmission
  clears `rejectionReason`, `reviewedAt` and `reviewedBy`, and replaces
  `submittedAt` with the new submission time.
- Submission is pinned to the `submittedAt` value the owner loaded, and review
  decisions are pinned to the `submittedAt` value the admin loaded. A stale
  submit or review request cannot act on a newer review cycle.
- Submission does not require content completeness; the new publishing endpoint
  validates completeness before allowing publication. See
  [`course-publishing.md`](course-publishing.md).

## Authentication and CSRF

Teacher routes are mounted under `/api/teacher/courses` and require:

- an authenticated **approved teacher** (admins bypass teacher verification);
- a valid `X-CSRF-Token` header on state-changing requests (`POST`, `PATCH`,
  `PUT`, `DELETE`).

Students and pending teachers receive `403`.

Moderation routes are mounted under `/api/admin/courses` and require an
authenticated **admin**. Non-admin users receive `403`; state-changing review
decisions also require a valid CSRF token. Submission is owner-only: an admin
cannot submit a teacher's course on their behalf.

## Data model

### Course

| Field | Notes |
| --- | --- |
| `ownerId` | Teacher who owns the course |
| `title` | Required, 1–200 chars |
| `slug` | Server-generated, unique, stable (not regenerated on rename) |
| `description` | Optional, up to 5000 chars |
| `status` | `draft` \| `pending_review` \| `approved` \| `rejected` \| `published` \| `archived` |
| `submittedAt` | Set on each owner submission |
| `reviewedAt`, `reviewedBy` | Set by the admin decision for the current submission |
| `rejectionReason` | Present only on `rejected`; cleared on resubmission |
| `thumbnailUrl` | External HTTP(S) image URL; required to publish |
| `level` | `beginner` \| `intermediate` \| `advanced` \| `all_levels`; required to publish |
| `language` | Language tag such as `ar` or `en-US`; required to publish |
| `learningOutcomes` | Up to 20 strings; at least one required to publish |
| `requirements` | Up to 20 strings; optional |
| `priceMinor` | Integer minor units (0 = free); required to publish, no defaults |
| `currency` | ISO 4217 code; required together with `priceMinor` |
| `publishedAt` | Server-owned; set only by the publish transition |
| `editLocked`, `editLockedAt`, `editLockToken`, `editLeaseExpiresAt` | Internal content-edit lease; never serialized or client-controlled |
| `createdAt`, `updatedAt` | Timestamps |

Indexes: `{ ownerId: 1, createdAt: -1 }`, unique `{ slug: 1 }`,
`{ status: 1, createdAt: -1 }` (moderation queue).

### Section

| Field | Notes |
| --- | --- |
| `courseId` | Owning course |
| `title` | Required, 1–200 chars |
| `description` | Optional, up to 2000 chars |
| `order` | 1-based position in the course |
| `editToken`, `editLeaseExpiresAt` | Internal write fence, updated on lease acquisition |
| `committed` | Internal staging flag for creates; missing/true means visible |

Index: `{ courseId: 1, order: 1 }`.

### Lesson

| Field | Notes |
| --- | --- |
| `courseId`, `sectionId` | Owning section and course |
| `title` | Required, 1–200 chars |
| `description` | Optional, up to 2000 chars |
| `type` | `video` \| `text` \| `document` \| `quiz` |
| `order` | 1-based position in the section |
| `videoId` | Video lessons: reference to a Video owned by the course owner |
| `content` | Text lessons: body, up to 20000 chars |
| `documentUrl`, `documentName` | Document lessons: external http(s) reference |
| `editToken`, `editLeaseExpiresAt` | Internal write fence, updated on lease acquisition |
| `committed` | Internal staging flag for creates; missing/true means visible |

Indexes: `{ sectionId: 1, order: 1 }`, `{ courseId: 1 }`.

Only the payload matching a lesson's type is populated. Switching type clears
the other payload fields so stale data cannot linger.

## Lesson types

| Type | Required payload | Notes |
| --- | --- | --- |
| `video` | `videoId` | Existing video owned by the course owner |
| `text` | `content` | Inline body |
| `document` | `documentUrl` | Absolute `http(s)` URL (external reference) |
| `quiz` | – | Rejected with `LESSON_TYPE_UNSUPPORTED` until the Quiz System exists |

A video may be referenced by more than one lesson and does not need to have
finished processing at link time; the Video System gates playback separately.

## Endpoints

All responses use the standard envelope:

```json
{ "success": true, "data": { ... } }
```

List responses add `meta`:

```json
{
  "success": true,
  "data": [],
  "meta": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 }
}
```

Errors:

```json
{ "success": false, "error": { "code": "COURSE_NOT_FOUND", "message": "…" } }
```

### Courses

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/teacher/courses` | Create a draft course |
| `GET` | `/api/teacher/courses?page=&limit=` | List the caller's courses |
| `GET` | `/api/teacher/courses/:courseId` | Get a course with sections and lessons |
| `PATCH` | `/api/teacher/courses/:courseId` | Update `title` / `description` |
| `DELETE` | `/api/teacher/courses/:courseId` | Delete the course and cascade its content |
| `POST` | `/api/teacher/courses/:courseId/submit` | Owner submits a draft/rejected course for review |
| `POST` | `/api/teacher/courses/:courseId/publish` | Owner publishes an approved, complete course |

Create body:

```json
{ "title": "Intro to Physics", "description": "Mechanics and waves" }
```

Create returns `201` with the full course structure (`sections: []`). Metadata
updates, section mutations and lesson mutations return the full updated course:

```json
{ "success": true, "data": { "course": { "id": "…", "sections": [ … ] } } }
```

`PATCH` accepts `title`, `description`, or both. Send `"description": ""` to
clear it. Renaming does **not** change the slug — it is a stable identifier.

### Sections

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/teacher/courses/:courseId/sections` | Add a section |
| `PATCH` | `/api/teacher/courses/:courseId/sections/:sectionId` | Edit a section |
| `DELETE` | `/api/teacher/courses/:courseId/sections/:sectionId` | Delete a section and its lessons |
| `PUT` | `/api/teacher/courses/:courseId/sections/reorder` | Reorder all sections |

Reorder body (every current section id, exactly once):

```json
{ "sectionIds": ["<id-c>", "<id-a>", "<id-b>"] }
```

### Lessons

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/teacher/courses/:courseId/sections/:sectionId/lessons` | Add a lesson |
| `PATCH` | `/api/teacher/courses/:courseId/sections/:sectionId/lessons/:lessonId` | Edit a lesson |
| `DELETE` | `/api/teacher/courses/:courseId/sections/:sectionId/lessons/:lessonId` | Delete a lesson |
| `PUT` | `/api/teacher/courses/:courseId/sections/:sectionId/lessons/reorder` | Reorder lessons in a section |

Lesson creation bodies:

```json
{ "type": "video", "title": "Lecture 1", "videoId": "<video-id>" }
{ "type": "text", "title": "Reading", "content": "…" }
{ "type": "document", "title": "Handout", "documentUrl": "https://example.com/handout.pdf" }
```

Lesson update is partial. If `type` changes, the payload required by the new type
must be supplied in the same request, for example:

```json
{ "type": "text", "content": "Now an inline lesson" }
```

Reorder body:

```json
{ "lessonIds": ["<id-3>", "<id-1>", "<id-2>"] }
```

### Teacher submission

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/teacher/courses/:courseId/submit` | Submit a `draft` or `rejected` course for admin review |

No request body is required. Client-supplied `status`, `reviewedBy`,
`reviewedAt`, `submittedAt`, `rejectionReason` or edit-lease values are ignored.
Returns the updated course with `status: "pending_review"` and a fresh
`submittedAt`. All content mutations are then locked until the admin decides.

If a content edit is in progress, submission returns
`409 COURSE_EDIT_IN_PROGRESS`; reload and retry after the edit finishes. A
concurrent second submission returns `409 INVALID_STATUS_TRANSITION`.

### Admin moderation

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/admin/courses?status=&page=&limit=` | Moderation queue; defaults to `pending_review` |
| `GET` | `/api/admin/courses/:courseId` | Full course content for review, regardless of owner |
| `POST` | `/api/admin/courses/:courseId/approve` | Approve a `pending_review` course |
| `POST` | `/api/admin/courses/:courseId/reject` | Reject a `pending_review` course with a reason |

The queue returns metadata-only course summaries (`ManagedCourse`) with the
standard pagination `meta`. `status` accepts any lifecycle value, so admins can
also inspect drafts, rejected, approved or archived courses. `ManagedCourse`
includes review metadata because the endpoint is admin-only; the future public
catalog mapper (`PublicCourse`) deliberately excludes it.

Rejection body:

```json
{ "reason": "Add a course thumbnail and a second section before resubmitting." }
```

`reason` is required, trimmed, 1–1000 characters. The trimmed reason is stored
in `rejectionReason` and exposed to the owner (and to admins). It is cleared
when the owner resubmits. Approving or rejecting a course that is not
`pending_review` returns `409 INVALID_STATUS_TRANSITION`; a decision based on an
older submission also returns `409` instead of deciding the newer version.

Review metadata (`submittedAt`, `reviewedAt`, `reviewedBy`, `rejectionReason`)
is returned only by owner/admin course-management responses. It is never
accepted as input. The audience-neutral `PublicCourse` mapper excludes it for
future public catalog use.

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `COURSE_NOT_FOUND` | 404 | Course does not exist |
| `COURSE_FORBIDDEN` | 403 | Caller is not the owner and is not an admin |
| `SECTION_NOT_FOUND` | 404 | Section missing or belongs to another course |
| `LESSON_NOT_FOUND` | 404 | Lesson missing or belongs to another section |
| `LESSON_TYPE_UNSUPPORTED` | 400 | `quiz` lessons are not available yet |
| `LESSON_PAYLOAD_REQUIRED` | 422 | A type switch omitted the new type's payload |
| `LESSON_VIDEO_NOT_FOUND` | 404 | Referenced video does not exist |
| `LESSON_VIDEO_FORBIDDEN` | 403 | Referenced video is owned by someone else |
| `INVALID_REORDER` | 400 | Reorder list is not an exact permutation of current ids |
| `INVALID_STATUS_TRANSITION` | 409 | The requested review transition is not allowed from the current status, or a concurrent request won first |
| `COURSE_NOT_EDITABLE` | 409 | Content was edited while the course is under review or approved |
| `COURSE_NOT_DELETABLE` | 409 | A pending/approved/published/archived course cannot be deleted |
| `COURSE_EDIT_IN_PROGRESS` | 409 | Another content edit holds the per-course lease; reload and retry |
| `COURSE_NOT_PUBLISHABLE` | 422 | The approved course is missing publishing requirements; `details.reasons` lists them |
| `VALIDATION_ERROR` | 422 | Request body/params/query failed Zod validation |

## Deletion semantics

- Deleting a **lesson** removes only that lesson.
- Deleting a **section** removes the section and all of its lessons.
- Deleting a **course** removes the course, its sections and its lessons.
- A course can be deleted only in `draft` or `rejected` status. `pending_review`,
  `approved`, `published` and `archived` courses return `409 COURSE_NOT_DELETABLE`
  for the owner and for admins.
- Deletion participates in the content-edit lease: a deletion during another
  edit returns `409 COURSE_EDIT_IN_PROGRESS`, and a submission during deletion
  fails rather than freezing a course that is being removed.
- Videos are independent assets and are **never** deleted by the course module;
  the same video may be reused by other lessons.

## Tests

- `backend/tests/course.test.ts` (41 integration tests) covers
  authentication/authorization, ownership isolation, slug generation, metadata
  updates, section/lesson CRUD, validation, ordering persistence, video
  ownership rules, type switching and cascading deletes.
- `backend/tests/teacher-workflow.test.ts` (43 integration tests) covers
  submission, non-owner/admin submission attempts, admin queue/detail, approve
  and reject transitions, rejection reason validation, non-admin moderation
  attempts, server-owned field tampering, edit locking and rejected-course
  editing/resubmission. It also covers concurrent approve/reject/submit
  decisions, stale submit/review requests against newer review cycles,
  edit-lease races and recovery, submission retry after a competing edit
  releases, deletion policy, fenced-delete failure and retry, a delete/submit
  race and review-metadata exposure.
  Deterministic stall tests cover a recovered lease, a new holder, and the old
  course/section update or create attempting to finish, including a submission
  winning the lease race. A fence matrix verifies that every course, section
  and lesson update, delete, reorder and create commit is rejected for a stale
  holder.

- `backend/tests/course-publishing.test.ts` (27 integration tests) covers
  owner-only publishing, admin/other-teacher denial, state-machine rejection,
  metadata validation and clearing, completeness reasons (including staged rows
  and legacy invalid lessons), video readiness and ownership, concurrent
  publishes, active/stale edit leases, the approval-before-publish ordering,
  and the public catalog (published-only filtering, pagination, instructor
  summary, free pricing and protected-content exclusion).
- `backend/tests/course-category.test.ts` (32 integration tests) covers
  category assignment/clearing, approval/publish-time category validation
  (missing, inactive and hidden-ancestor cases), admin category-only repair and
  its authorization/CSRF/strict-body guards, catalog category filtering with
  descendants and pagination, legacy `category: null` behavior, category
  deletion/deactivation/move guards, and deterministic lease-expiry races for
  approval, publishing, course create/update and admin repair against category
  delete/deactivate/move.

These are integration tests against a local MongoDB test database
(`education-platform-test` on loopback), not mocked repositories. Concurrency
coverage combines real parallel HTTP requests with deterministic stall wrappers
that delegate to the real Mongoose repositories. The suite runs against a
standalone MongoDB server, so multi-document transactions are not exercised.

The full backend suite currently has 253 passing tests.

## Known limitations / follow-ups

- The frontend Course Builder and moderation UI are not implemented (the
  frontend app is not initialized yet).
- `quiz` lessons wait for the Quiz System (Phase 10).
- Document lessons store an external URL; a document storage/upload provider is
  a future concern.
- Deleting a video that a lesson references does not clear the lesson's
  `videoId`. Playback resolution will surface a missing video until a follow-up
  adds cross-module cleanup.
- Publishing is implemented for `approved` → `published`; archiving,
  unpublishing and a post-publication edit/re-review flow are later phases.
  Submission still does not validate content completeness; publishing does.
  A pending course cannot be deleted; it must be rejected
  first until an explicit withdrawal flow exists.
- Content edit leases are recovered after five minutes so a crashed process
  cannot block a course forever. This assumes a legitimate content write
  finishes well within that window; a write that exceeds it is rejected rather
  than allowed to commit. All write filters use MongoDB server time for the
  expiry check, but lease acquisition and stale detection still use the
  application clock, so large cross-instance clock skew remains a limitation.
- Reordering updates each section/lesson with its own fenced write and is not a
  transaction. If a lease expires mid-bulk, the remaining writes fail and the
  caller receives `409`; writes that completed before expiry may leave a partial
  order. The next successful reorder repairs it.
- Cascade deletes are sequential rather than transactional. The parent
  course/section is deleted under the fence first, then the remaining content is
  removed. If cleanup fails or the process crashes after the parent delete, the
  remaining sections/lessons are unreachable through the API but stay in
  MongoDB; retrying `DELETE` returns `404` because the parent is already gone,
  so an operational cleanup is required. This is an orphan-storage risk rather
  than visible partial course content, and a transactional or resumable cleanup
  is a follow-up.
- A stale create that inserts after the new holder's cleanup, or after the
  parent course/section was deleted, can leave an invisible `committed: false`
  row. It is never returned by reads. For an existing course, the next lease
  acquisition removes it; for a deleted parent there is no later acquisition,
  so it remains an orphan until manual cleanup.
- Course ↔ category linking is implemented: `categoryId` is optional while
  drafting and required at publish time, with category-tree locking documented
  in [`categories.md`](categories.md). Thumbnail upload, course preview,
  archive/unpublish and post-publication editing remain separate phases.
  Publishing and the public catalog, including `?category=` filtering, are
  documented in [`course-publishing.md`](course-publishing.md). Pricing is
  stored for future checkout but no payment, coupon or enrollment logic exists
  yet.
