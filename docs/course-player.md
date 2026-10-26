# Course Player

Backend implementation of protected lesson delivery for Roadmap Phase 8.

The frontend is not initialized yet, so this document is the API contract the
player UI will consume later. The player layout, sidebar, responsive behavior
and resume controls remain deferred.

## Scope

Implemented in this phase:

- Protected text-lesson content
- Protected document-lesson resource references
- Protected video playback references using the existing provider-agnostic
  video system
- Previous/next lesson navigation metadata
- Server-side authorization on every protected read
- Owner-teacher and admin preview of unpublished course content
- Committed-only content visibility (staged sections/lessons stay hidden)

Deliberately **not** implemented in this phase:

- Player UI, sidebar or responsive layout
- Lesson progress, resume position or completion (Phase 9)
- Quiz content (Phase 10)
- Certificates (Phase 14)
- Payments or paid-content entitlements (Phase 12)

## Endpoint

### `GET /api/courses/:courseId/lessons/:lessonId`

Requires authentication. The route is course-scoped: `lessonId` must belong to
`courseId`.

The endpoint is mounted before the public catalog but declares authentication
per route, so `GET /api/courses` and `GET /api/courses/:slug` remain anonymous.

## Access policy

Every request loads the course, authorizes the requester, and only then resolves
the lesson. Unauthorized callers therefore cannot probe lesson ids.

| Requester | Course state | Result |
| --- | --- | --- |
| Unauthenticated | any | `401 AUTH_UNAUTHORIZED` |
| Student | `published` + `active` or `completed` enrollment | Allow |
| Student | `published` + no enrollment | `403 COURSE_FORBIDDEN` |
| Student | `published` + `cancelled`/`expired` enrollment | `403 COURSE_FORBIDDEN` |
| Student | any non-published status | `404 COURSE_NOT_FOUND` |
| Approved teacher who owns the course | any status | Allow (preview) |
| Approved teacher, non-owner | any status | `403 COURSE_FORBIDDEN` |
| Pending/rejected teacher who owns the course | any status | `403 AUTH_FORBIDDEN` |
| Admin | any status | Allow |

The student decision uses the existing authoritative predicate
`canAccessCourse` in
`backend/src/modules/enrollments/enrollment.access.ts`. It requires the course
to be published **and** the enrollment lifecycle to be `active` or `completed`.
Legacy enrollment rows without a stored `status` normalize from `completedAt`.
`enrolled: true` alone is never authorization.

The teacher decision mirrors the Course Builder: only an approved teacher may
preview, and only their own course. Admins bypass both checks, matching the
existing admin review and roster behavior. This phase does not broaden teacher
or admin access.

### Preview and free lessons

There is **no** preview-lesson or free-lesson bypass in the current product
rules, and no `preview`/`isFreeLesson` field exists on the lesson model. A free
published course still requires a free enrollment before any protected content
is returned. The public catalog remains an outline only and never includes
lesson bodies, document URLs, video ids or playback references.

Owner/admin preview is a management capability, not a student-facing preview
bypass.

### Staged content

Sections and lessons are read with `COMMITTED_CONTENT_FILTER`. A staged lesson
is invisible to everyone, including its owner and admins. A committed lesson
whose section is missing or staged is also unavailable.

| Situation | Result |
| --- | --- |
| Lesson id is unknown or belongs to another course | `404 LESSON_NOT_FOUND` |
| Lesson is staged (`committed: false`) | `404 LESSON_NOT_FOUND` |
| Lesson's section is missing or staged | `404 SECTION_NOT_FOUND` |

## Response

```json
{
  "success": true,
  "data": {
    "course": {
      "id": "665f...",
      "title": "Course title",
      "slug": "course-title"
    },
    "section": {
      "id": "665e...",
      "title": "Section title",
      "order": 1
    },
    "lesson": {
      "id": "665d...",
      "title": "Lesson title",
      "description": "Optional lesson description",
      "type": "text",
      "order": 1,
      "text": {
        "content": "Lesson body"
      }
    },
    "navigation": {
      "previous": null,
      "next": {
        "lessonId": "665c...",
        "sectionId": "665e...",
        "title": "Next lesson",
        "type": "video"
      }
    }
  }
}
```

Exactly one of the type-specific payloads is present, matching `lesson.type`:

### Text

```json
{
  "type": "text",
  "text": {
    "content": "Lesson body"
  }
}
```

### Document

```json
{
  "type": "document",
  "document": {
    "url": "https://files.example.com/handout.pdf",
    "name": "handout.pdf"
  }
}
```

`document.name` is optional. The URL is the externally hosted resource
reference; the API server does not proxy document bytes. It must be an absolute
http(s) URL. A stored legacy value with another scheme is rejected with
`409 LESSON_PAYLOAD_REQUIRED`.

### Video

```json
{
  "type": "video",
  "video": {
    "playbackUrl": "https://cdn.example.com/video.mp4",
    "durationSeconds": 321,
    "thumbnailUrl": "https://cdn.example.com/thumb.jpg"
  }
}
```

`durationSeconds` and `thumbnailUrl` are optional. The response never includes
the video id, provider name, provider asset id, upload/processing status,
failure reason or storage credentials. `playbackUrl` is only returned after the
video system reports the asset as ready.

## Navigation

Navigation is built from committed content only:

1. Sections are ordered by `order`, then creation time.
2. Lessons are ordered by `order` within each section, then creation time.
3. The current lesson is located in the flattened sequence.

`navigation.previous` is `null` for the first lesson and `navigation.next` is
`null` for the last lesson. Adjacent references contain only `lessonId`,
`sectionId`, `title` and `type`; they do not duplicate full lesson content.

## Errors

| Status | Code | Meaning |
| --- | --- | --- |
| `401` | `AUTH_UNAUTHORIZED` / `AUTH_INVALID_TOKEN` | Missing or invalid authentication |
| `403` | `AUTH_FORBIDDEN` | Teacher account is not approved |
| `403` | `COURSE_FORBIDDEN` | No enrollment, revoked enrollment, or non-owner teacher |
| `404` | `COURSE_NOT_FOUND` | Unknown course, or unpublished course requested by a student |
| `404` | `LESSON_NOT_FOUND` | Unknown, cross-course or staged lesson |
| `404` | `SECTION_NOT_FOUND` | Lesson's section is missing or staged |
| `404` | `LESSON_VIDEO_NOT_FOUND` | Video reference points to a missing video, or the video is owned by another teacher |
| `409` | `LESSON_PAYLOAD_REQUIRED` | Stored text/document/video lesson is missing its payload, or a stored document URL is not http(s) |
| `409` | `LESSON_TYPE_UNSUPPORTED` | Quiz or other unsupported lesson type |
| `409` | `VIDEO_NOT_READY` | Video is pending/processing/failed or has no playback URL |
| `422` | `VALIDATION_ERROR` | Malformed `courseId` or `lessonId` |

No new error codes are introduced; the endpoint reuses the existing course,
video and authentication vocabularies.

## Implementation

- `backend/src/modules/course-player/` — routes, controller, service, mapper,
  validation and types
- `LessonRepository.findByCourseAndId` — committed, course-scoped lesson lookup
- `backend/tests/course-player.test.ts` — integration coverage for access,
  content types, staged content, navigation and public-catalog regressions
