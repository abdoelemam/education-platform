# Enrollment System

Backend implementation of student course enrollment (Roadmap Phase 7).

The frontend is not initialized yet, so this document is the API contract the
frontend will consume later.

## Scope

Implemented in this phase:

- Enrollment model and unique student/course constraint
- Free enrollment in published courses
- Idempotent duplicate and concurrent enrollment
- Student course list (`GET /api/my-courses`)
- Student enrollment status for one course
- Teacher/admin course roster (owner-scoped)
- Backend authorization and course-eligibility enforcement
- A reusable enrollment/course access predicate, consumed by the Course Player
  (Phase 8)
- Startup index initialization before the HTTP server accepts traffic
- Legacy published-course and legacy enrollment-row compatibility

Deliberately **not** implemented in this phase: lesson progress, quizzes,
certificates, cancellation/expiry flows and payment-provider integration.
Protected lesson delivery is implemented separately by the Course Player
(Phase 8); see [`course-player.md`](course-player.md).

## Enrollment model

`backend/src/modules/enrollments/`

| Field | Type | Rules |
| --- | --- | --- |
| `studentId` | ObjectId → User | Required |
| `courseId` | ObjectId → Course | Required |
| `status` | `active` \| `completed` \| `cancelled` \| `expired` | Default `active` |
| `enrolledAt` | Date | Set once at enrollment; may be absent on raw legacy rows |
| `completedAt` | Date | Written by completion logic together with `status = completed`; not enforced by a schema validator |
| `source` | `free` \| `purchase` | Default `free`; `purchase` belongs to Phase 12 |
| `orderId` | ObjectId → Order | Optional; reserved for verified payments (no Order model yet) |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps; `updatedAt` advances on update operations |

The enrollment stores **relationship state only**. Course metadata stays on
Course, student profile data on User, lesson progress on LessonProgress (Phase 9)
and financial history on Order (Phase 12). No price, title, email or progress
counter is duplicated.

Indexes:

```text
unique (studentId, courseId)   duplicate barrier
(courseId, enrolledAt)         teacher roster
(studentId, enrolledAt)        student course list
```

Mongoose schema defaults are not used as the source of truth when reading:
repository reads use `lean()` so legacy rows that never stored `status`,
`enrolledAt` or `source` are normalized by the mapper instead of appearing to
have been created at read time.

Startup waits for `Model.init()` on every registered model before creating the
HTTP listener. The unique enrollment index is therefore in place before traffic
can arrive, and an index-build failure aborts startup instead of silently
serving without the duplicate barrier. `Model.init()` only creates declared
indexes; it does not drop or synchronize existing indexes.

## Eligibility

Enrollment is created only by a trusted backend decision. The request body is
rejected unless empty; price, status, source, order and timestamps are never
accepted from the client.

| Course state | Result |
| --- | --- |
| `published`, `priceMinor` missing or exactly `0` | Free enrollment (`201`, or `200` if it already exists) |
| `published`, `priceMinor > 0` | `409 ENROLLMENT_PAYMENT_REQUIRED` with `details.priceMinor` / `details.currency`; **no enrollment row** |
| `published`, invalid legacy `priceMinor` (negative, `NaN`, non-finite) | `409 ENROLLMENT_PAYMENT_REQUIRED`; **no enrollment row** |
| Any non-published status (`draft`, `pending_review`, `approved`, `rejected`, `archived`) | `404 COURSE_NOT_FOUND` |
| Missing course | `404 COURSE_NOT_FOUND` |

`priceMinor` is optional only on legacy published courses created before the
publishing phase. Enrollment and the public catalog share one predicate,
`isCourseFree`, which treats a missing price as free but never treats an invalid
stored price as free. Newly published courses always carry an explicit price
and currency.

There is no checkout endpoint in this phase. A paid course can never be enrolled
by stating that payment succeeded; only a verified payment integration
(Phase 12) may create a `purchase` enrollment with an `orderId`.

## Duplicate and concurrent requests

`POST /api/courses/:courseId/enroll` is idempotent.

- One atomic `findOneAndUpdate(..., { upsert: true, $setOnInsert })` is used.
- The unique `(studentId, courseId)` index is the authoritative barrier.
- If two upserts race, the loser receives duplicate-key error `11000`, re-reads
  the winner's row and returns it.
- Business fields are insert-only. A repeated request cannot reset `status`,
  `enrolledAt`, `completedAt` or `source`. Mongoose timestamps may advance
  `updatedAt`; that is not treated as a lifecycle transition.
- Response: `201` with `created: true` for the first request, `200` with
  `created: false` for duplicates. Exactly one row exists in all cases.
- A repeated request for a `cancelled` or `expired` row returns that row
  unchanged with `created: false` and `hasAccess: false`. It never reactivates
  the enrollment or restores access. Reactivation requires an explicit future
  lifecycle endpoint with its own authorization policy.

## Access control

| Endpoint | Access |
| --- | --- |
| `POST /api/courses/:courseId/enroll` | Authenticated `student` + CSRF |
| `GET /api/courses/:courseId/enrollment` | Authenticated `student` |
| `GET /api/my-courses` | Authenticated `student` |
| `GET /api/teacher/courses/:courseId/enrollments` | Approved `teacher` who owns the course, or `admin` |

Enrollment is a student action; teachers and admins receive `403` on the student
endpoints. The single-role user model does not allow a teacher account to be an
enrolled student as well.

### Record existence vs course access

`enrolled` means only that an enrollment row exists. It is **not**
authorization. The API exposes a separate `hasAccess` field computed by the
reusable server-side predicate in
`backend/src/modules/enrollments/enrollment.access.ts`:

| Enrollment status | `hasAccess` | Notes |
| --- | --- | --- |
| `active` | `true` | Subject to the course still being published and all normal authorization |
| `completed` | `true` | Retains access so the student can revisit the finished course |
| `cancelled` | `false` | Revoked; never reactivated implicitly by `POST /enroll` |
| `expired` | `false` | Access window ended; never reactivated implicitly by `POST /enroll` |

`hasAccess` is `false` when the course is not currently published, even if the
enrollment lifecycle would otherwise allow access. Legacy rows without a stored
`status` resolve to `completed` when `completedAt` exists, otherwise `active`.

The Course Player verifies, on every protected read:

```text
authenticated
   ↓
course still published
   ↓
enrollment exists and status is active or completed
   ↓
allow lesson content
```

`enrolled: true` alone must never be used as the authorization decision, and
frontend flags are informational only. Every protected backend route must call
the same access predicate (or an equivalent service method) against the
authoritative database records.

This policy is implemented by `GET /api/courses/:courseId/lessons/:lessonId`.
See [`course-player.md`](course-player.md) for the endpoint contract, response
shapes and the owner-teacher/admin preview rules.

## API

### `POST /api/courses/:courseId/enroll`

No request body. Requires the `X-CSRF-Token` header matching the CSRF cookie.

```json
{
  "success": true,
  "data": {
    "created": true,
    "hasAccess": true,
    "enrollment": {
      "id": "665f...",
      "studentId": "665e...",
      "courseId": "665d...",
      "status": "active",
      "enrolledAt": "2026-10-23T12:00:00.000Z",
      "source": "free"
    }
  }
}
```

Errors: `401` unauthenticated, `403` non-student/CSRF, `404 COURSE_NOT_FOUND`,
`409 ENROLLMENT_PAYMENT_REQUIRED`, `422` malformed course id or non-empty body.

### `GET /api/courses/:courseId/enrollment`

Returns the caller's status. The course must be published; otherwise `404`.

```json
{
  "success": true,
  "data": {
    "enrolled": true,
    "hasAccess": true,
    "enrollment": { "...": "same shape as above" }
  }
}
```

When not enrolled:
`{ "enrolled": false, "hasAccess": false, "enrollment": null }`.

A cancelled/expired enrollment returns `enrolled: true, hasAccess: false` with
the stored record.

### `GET /api/my-courses?page=1&limit=20`

Standard paginated response. Only the caller's enrollments are returned, newest
enrollment first. `limit` is capped at 100 and `page` is capped at 1,000,000 so
the computed MongoDB skip stays within a safe integer range.

Enrollments whose course no longer exists (legacy/raw orphan rows) are excluded
from both the returned page and `meta.total`, so `total`/`totalPages` always
describe the returned set.

```json
{
  "success": true,
  "data": [
    {
      "enrollment": {
        "id": "665f...",
        "studentId": "665e...",
        "courseId": "665d...",
        "status": "active",
        "enrolledAt": "2026-10-23T12:00:00.000Z",
        "source": "free"
      },
      "course": {
        "id": "665d...",
        "title": "Course title",
        "slug": "course-title",
        "thumbnailUrl": "https://cdn.example.com/thumb.png",
        "level": "beginner",
        "language": "en",
        "priceMinor": 0,
        "currency": "USD",
        "isFree": true,
        "publishedAt": "2026-10-20T09:00:00.000Z",
        "instructor": { "name": "Instructor Name" },
        "totalSections": 4,
        "totalLessons": 18
      },
      "hasAccess": true,
      "progress": null
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

`progress` is always `null` until the Progress System exists. The API never
fabricates a percentage. `hasAccess` uses the same lifecycle/publication
predicate as the status endpoint; it is a UI convenience, not a substitute for
backend authorization. `totalSections` / `totalLessons` count committed content
only. Owner ids, review metadata, category internals and lesson payloads are not
exposed. Instructor data is limited to name and avatar.

### `GET /api/teacher/courses/:courseId/enrollments?page=1&limit=20`

Owner or admin. Paginated roster, newest enrollment first.

```json
{
  "success": true,
  "data": [
    {
      "id": "665f...",
      "student": { "id": "665e...", "name": "Student Name" },
      "status": "active",
      "enrolledAt": "2026-10-23T12:00:00.000Z",
      "source": "free"
    }
  ],
  "meta": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Student email is deliberately not included. `enrolledAt` is `null` only for a
raw legacy row that has neither `enrolledAt` nor `createdAt`. A deleted user
record renders as `Unknown student`. A non-owner teacher receives
`403 COURSE_FORBIDDEN`; a pending/unapproved teacher receives
`403 AUTH_FORBIDDEN`; admins bypass the ownership check following the existing
convention.

## Legacy compatibility

| Legacy data | Behavior |
| --- | --- |
| Published course without `priceMinor` / `currency` | Treated as free, matching the public catalog |
| Published course without a category | Unaffected; enrollment does not require a category |
| Enrollment row without `status` | `completedAt` present → `completed`; otherwise `active` |
| Enrollment row without `enrolledAt` but with `createdAt` | Falls back to the row's `createdAt` |
| Enrollment row without both `enrolledAt` and `createdAt` | `enrolledAt` is `null`; no timestamp is fabricated |
| Enrollment row without `source` | `purchase` when `orderId` exists, otherwise `free` |
| Enrollment row without `completedAt` | Returned without a completion timestamp; nothing is invented |

No backfill or migration is performed.

## Completion state

`status = completed` and `completedAt` are part of the model so Phase 9 can mark
completion without a schema change. The authoritative entry point is
`enrollmentRepository.markCompleted`:

- It transitions an `active` enrollment, or a legacy row with no stored
  `status`, to `completed`.
- It returns the updated row on a transition and `null` when no transition
  occurred (missing row, already completed, cancelled or expired).
- It never changes a cancelled/expired row, and the first completion timestamp
  is preserved because an already-completed row is not updated again.

No HTTP endpoint for completion exists in this phase; completion must never be
accepted from a client.

## Deferred work

- Lesson progress and course completion rules (Phase 9)
- Checkout, verified webhooks, Order/Purchase records and paid enrollment
  (Phase 12)
- Enrollment cancellation/expiry endpoints
- Certificate issuance (Phase 14)
