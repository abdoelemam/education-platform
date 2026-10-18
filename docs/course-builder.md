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
- **Server-owned fields.** `ownerId`, `slug`, `status` and `order` are never
  accepted from the client. Unknown body fields are stripped by Zod.

## Authentication and CSRF

All routes are mounted under `/api/teacher/courses` and require:

- an authenticated **approved teacher** (admins bypass teacher verification);
- a valid `X-CSRF-Token` header on state-changing requests (`POST`, `PATCH`,
  `PUT`, `DELETE`).

Students and pending teachers receive `403`.

## Data model

### Course

| Field | Notes |
| --- | --- |
| `ownerId` | Teacher who owns the course |
| `title` | Required, 1–200 chars |
| `slug` | Server-generated, unique, stable (not regenerated on rename) |
| `description` | Optional, up to 5000 chars |
| `status` | Lifecycle enum; the Course Builder only creates `draft` |
| `createdAt`, `updatedAt` | Timestamps |

Index: `{ ownerId: 1, createdAt: -1 }`, unique `{ slug: 1 }`.

### Section

| Field | Notes |
| --- | --- |
| `courseId` | Owning course |
| `title` | Required, 1–200 chars |
| `description` | Optional, up to 2000 chars |
| `order` | 1-based position in the course |

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
| `VALIDATION_ERROR` | 422 | Request body/params/query failed Zod validation |

## Deletion semantics

- Deleting a **lesson** removes only that lesson.
- Deleting a **section** removes the section and all of its lessons.
- Deleting a **course** removes the course, its sections and its lessons.
- Videos are independent assets and are **never** deleted by the course module;
  the same video may be reused by other lessons.

## Tests

`backend/tests/course.test.ts` covers authentication/authorization, ownership
isolation, slug generation, metadata updates, section/lesson CRUD, validation,
ordering persistence, video ownership rules, type switching and cascading
deletes (38 integration tests).

## Known limitations / follow-ups

- The frontend Course Builder UI is not implemented (the frontend app is not
  initialized yet).
- `quiz` lessons wait for the Quiz System (Phase 10).
- Document lessons store an external URL; a document storage/upload provider is
  a future concern.
- Deleting a video that a lesson references does not clear the lesson's
  `videoId`. Playback resolution will surface a missing video until a follow-up
  adds cross-module cleanup.
- Cascade deletes are sequential rather than transactional. If a mid-delete
  database error occurs, retrying the same delete removes any remaining
  sections/lessons.
- Course publishing, submission, categories, pricing and the remaining Course
  Management metadata belong to later phases and are intentionally absent.
