# Course Publishing & Public Catalog

Backend implementation of the publishing phase. A course that an admin approved
is not public until its owner publishes it. Publishing validates completeness on
the server, and the public catalog exposes only published courses with safe
metadata and a curriculum outline.

The frontend is not initialized yet, so this document is the API contract the
frontend will consume later.

## Lifecycle

```text
draft ──submit (owner)──▶ pending_review ──approve (admin)──▶ approved
                                 │                              │
                                 └──reject (admin)──▶ rejected  │
                                                               ▼
                                        published ◀──publish (owner)
```

- Approval is a review outcome, not publication.
- Publishing is strictly an owner action. Admins cannot publish on a teacher's
  behalf (the same rule as submission).
- `published` is terminal in this phase: content cannot be edited, the course
  cannot be deleted, unpublished or archived, and no post-publication review
  cycle exists.
- Content is already frozen in `approved`, so publishing cannot race a content
  edit. The publish transition still requires the content-edit lease to be free
  as defense in depth, and recovers an abandoned lease exactly like submission.

## Publishing metadata

All fields are optional while a course is a draft. They are validated by Zod on
write and re-checked by the publishing rules against stored data.

| Field | Rules | Required to publish |
| --- | --- | --- |
| `description` | Trimmed, non-empty, up to 5000 chars | Yes |
| `thumbnailUrl` | Absolute HTTP(S) URL, up to 2048 chars | Yes |
| `level` | `beginner` \| `intermediate` \| `advanced` \| `all_levels` | Yes |
| `language` | `^[a-z]{2}(-[A-Za-z]{2,8})?$`, for example `ar`, `en-US` | Yes |
| `learningOutcomes` | Array of 1–20 non-empty strings, each up to 200 chars | Yes |
| `requirements` | Array of 0–20 non-empty strings, each up to 200 chars | No |
| `priceMinor` | Integer minor units, 0–999,999,999; `0` means free | Yes |
| `currency` | Active ISO 4217 code (for example `USD`, `EGP`), normalized to uppercase | Yes |
| `publishedAt` | Server-owned timestamp | — (set by publishing) |

`priceMinor` and `currency` must be sent together on `PATCH` and must be cleared
together with `null`. There is no default currency and no default price: the
owner must make the free/paid decision explicitly.

`thumbnailUrl`, `level` and `language` can be cleared with `null`.
`learningOutcomes` and `requirements` are replaced wholesale on update; an empty
array clears them (but an empty `learningOutcomes` blocks publishing).
`status`, `publishedAt` and all review/lease fields are server-owned and are
stripped from client payloads.

**Category is deliberately not part of publishing in this phase.** The
Category module (Phase 3) does not exist yet, so requiring it would block every
publication. It becomes an additional publishing requirement when that phase is
implemented.

## Completeness rules

Publishing reads only committed sections and lessons (`committed !== false`).
Staged rows from an in-flight create are never counted.

1. Status is `approved` and the requester owns the course.
2. Description is non-empty.
3. Thumbnail, level and language are present and valid.
4. At least one learning outcome exists and none is blank.
5. Price and currency are present and valid.
6. At least one committed section exists.
7. Every committed section contains at least one committed lesson.
8. Every committed lesson has a valid payload:
   - `text`: non-empty content.
   - `document`: absolute HTTP(S) URL.
   - `video`: the referenced video exists, belongs to the course owner,
     `processingStatus === 'ready'` and has a playback URL.
   - `quiz`: cannot be published until the Quiz System exists.

Failures return `422 COURSE_NOT_PUBLISHABLE` with machine-readable reasons in
`error.details.reasons`:

```text
DESCRIPTION_REQUIRED
THUMBNAIL_REQUIRED | THUMBNAIL_INVALID
LEVEL_REQUIRED | LEVEL_INVALID
LANGUAGE_REQUIRED | LANGUAGE_INVALID
LEARNING_OUTCOMES_REQUIRED
PRICE_REQUIRED | PRICE_INVALID
CURRENCY_REQUIRED | CURRENCY_INVALID
SECTIONS_REQUIRED
SECTION_WITHOUT_LESSONS
LESSON_PAYLOAD_INVALID
VIDEO_NOT_READY
```

The reasons are deduplicated and returned in a deterministic order.

## Concurrency

The publish transition is a compare-and-set on `status = approved` combined with
the submission guard (`submittedAt` must still be the reviewed submission) and
the edit-lease-free condition.

- **publish/publish**: the first request wins; the second returns
  `409 INVALID_STATUS_TRANSITION`.
- **publish/approve**: only sequential is possible; approving moves
  `pending_review → approved`, and publishing an unapproved course returns
  `409`. Approval after publication cannot happen because publishing requires
  `approved`.
- **publish/edit lease**: an active lease returns
  `409 COURSE_EDIT_IN_PROGRESS`. A lease older than five minutes is treated as
  abandoned, cleared, and publishing is retried.
- **stale review request**: a publish request pinned to an older
  `submittedAt` cannot publish a newer review cycle.

## Endpoints

### Publish

```text
POST /api/teacher/courses/:courseId/publish
```

- Requires an authenticated, approved teacher and a valid CSRF token.
- Owner-only; admins who do not own the course receive `403 COURSE_FORBIDDEN`.
- No request body. Client-supplied state is never accepted.
- Success: `200` with the full course structure:

```json
{
  "success": true,
  "data": {
    "course": {
      "id": "…",
      "status": "published",
      "publishedAt": "2026-10-21T18:00:00.000Z",
      "priceMinor": 1999,
      "currency": "USD",
      "sections": [ … ]
    }
  }
}
```

### Public list

```text
GET /api/courses?page=1&limit=20
```

Published courses only, newest `publishedAt` first, with the standard `meta`
pagination object. No authentication is required. Search, filters and sorting
are deferred to the course discovery phase.

Catalog card shape:

```json
{
  "id": "…",
  "title": "Intro to Physics",
  "slug": "intro-to-physics",
  "description": "Mechanics and waves",
  "thumbnailUrl": "https://cdn.example.com/thumb.png",
  "level": "beginner",
  "language": "en",
  "priceMinor": 1999,
  "currency": "USD",
  "isFree": false,
  "publishedAt": "2026-10-21T18:00:00.000Z",
  "instructor": { "name": "Teacher Name", "avatar": "https://…" }
}
```

`instructor` contains only `name` and `avatar`. Email, role, teacher status and
other user fields are never returned.

### Public detail

```text
GET /api/courses/:slug
```

Returns the catalog card plus `learningOutcomes`, `requirements` and a
curriculum outline:

```json
{
  "curriculum": [
    {
      "id": "…",
      "title": "Section 1",
      "order": 1,
      "lessonCount": 2,
      "lessons": [
        { "id": "…", "title": "Lecture 1", "type": "video", "order": 1 },
        { "id": "…", "title": "Reading", "type": "text", "order": 2 }
      ]
    }
  ],
  "totalSections": 1,
  "totalLessons": 2
}
```

The public response deliberately excludes:

- lesson bodies (`content`), `videoId`, `documentUrl`, `documentName` and any
  playback URL;
- `ownerId`, review metadata and edit-lease/staging internals;
- instructor email and other private user data.

Non-published and unknown slugs both return `404 COURSE_NOT_FOUND`, so draft
existence is not leaked. Invalid slugs and pagination return `422
VALIDATION_ERROR`.

## Data model additions

`Course` gains `thumbnailUrl`, `level`, `language`, `learningOutcomes`,
`requirements`, `priceMinor`, `currency` and `publishedAt`, plus the index
`{ status: 1, publishedAt: -1 }` for the catalog.

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `COURSE_NOT_FOUND` | 404 | Course or published slug does not exist |
| `COURSE_FORBIDDEN` | 403 | Caller is not the owner (publishing is owner-only) |
| `INVALID_STATUS_TRANSITION` | 409 | Course is not `approved`, or a concurrent transition won |
| `COURSE_EDIT_IN_PROGRESS` | 409 | A content edit holds the lease; reload and retry |
| `COURSE_NOT_PUBLISHABLE` | 422 | Completeness validation failed; see `details.reasons` |
| `VALIDATION_ERROR` | 422 | Request body/params/query failed Zod validation |

## Tests

`backend/tests/course-publishing.test.ts` (27 integration tests) covers
authorization, lifecycle rejection, metadata validation/clearing, every
completeness category, staged and legacy rows, video readiness/ownership,
concurrent publishes, active and stale leases, approval ordering, and the public
catalog (published-only filtering, pagination, instructor summary, free pricing,
protected-content exclusion and 404/422 behavior).

The full backend suite has 186 passing tests.

## Deferred

- Categories and category filtering.
- Archive, unpublish, delete-published and edit-after-publication flows.
- Search, filters, sorting and ratings in the catalog.
- Thumbnail upload/storage provider (this phase stores an external URL).
- Payments, checkout, coupons and enrollment. `priceMinor`/`currency` are
  publication metadata only; no purchase or revenue calculation exists.
- Protected lesson delivery and playback authorization (Enrollment/Course
  Player phases).
- Instructor profiles beyond `name` and `avatar`.
- Quiz lessons (Quiz System phase).
