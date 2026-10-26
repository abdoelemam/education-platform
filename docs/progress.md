# Progress System

Backend implementation of lesson progress, resume positions and course
completion (Roadmap Phase 9).

The frontend is not initialized yet, so this document is the API contract the
player UI will consume later. The progress UI and the resume control remain
deferred.

## Scope

Implemented in this phase:

- `LessonProgress` model with one row per student/lesson
- Video progress with an authoritative duration snapshot
- Server-calculated video completion at 90% of the stored duration
- Explicit text/document completion
- Course completion percentage over committed, progress-eligible lessons
- Resume position per lesson
- Idempotent enrollment completion through the existing
  `enrollmentRepository.markCompleted`
- Progress summaries in `GET /api/my-courses`
- Monotonic watched time, sticky completion and duplicate-row protection

Deliberately **not** implemented in this phase:

- Progress UI, resume control and player integration (frontend deferred)
- Quiz progress and quiz completion (Phase 10)
- Certificates (Phase 14)
- Analytics or teacher progress dashboards
- Realtime progress updates

## Model

`backend/src/modules/progress/progress.model.ts`

| Field | Type | Rules |
| --- | --- | --- |
| `studentId` | ObjectId → User | Required |
| `courseId` | ObjectId → Course | Required, denormalized |
| `sectionId` | ObjectId → Section | Required, denormalized |
| `lessonId` | ObjectId → Lesson | Required |
| `lessonType` | `video` \| `text` \| `document` | Required; quizzes excluded |
| `watchedSeconds` | Number | Server-accepted watched time; monotonic, clamped |
| `durationSeconds` | Number | Authoritative video duration snapshot; videos only |
| `lastPositionSeconds` | Number | Most recently reported playback position |
| `completed` | Boolean | Sticky; never reset by a later request |
| `completedAt` | Date | First server-determined completion time |
| `createdAt` / `updatedAt` | Date | Mongoose timestamps |

Indexes:

```text
unique (studentId, lessonId)   one row per student/lesson
(studentId, courseId)          course summary reads
(courseId, completed)          course completion aggregation
```

The unique `(studentId, lessonId)` index is the duplicate barrier for concurrent
progress writes. A losing concurrent upsert receives a duplicate-key error and
retries as a plain update, so exactly one row is persisted.

## Access policy

All three endpoints require an authenticated user with the `student` role. The
route-level role check is defense in depth; the service also verifies the
published-course + enrollment policy.

| Requester | Course state | Result |
| --- | --- | --- |
| Unauthenticated | any | `401 AUTH_UNAUTHORIZED` |
| Teacher or admin | any | `403 AUTH_FORBIDDEN` (progress is student-owned) |
| Student | published + `active`/`completed` enrollment | Allow |
| Student | published + no enrollment | `403 COURSE_FORBIDDEN` |
| Student | published + `cancelled`/`expired` enrollment | `403 COURSE_FORBIDDEN` |
| Student | any non-published status | `404 COURSE_NOT_FOUND` |
| Student | unknown course | `404 COURSE_NOT_FOUND` |

The student decision reuses the existing authoritative predicate
`canAccessCourse` in
`backend/src/modules/enrollments/enrollment.access.ts`. A free published course
still requires an enrollment; there is no preview or free-lesson bypass.

Teacher/admin preview is a Course Player capability only. It never creates or
reads student progress rows.

### Committed content

Lesson and section lookups are course-scoped and use
`COMMITTED_CONTENT_FILTER`. Cross-course ids, staged lessons and lessons whose
section is staged are treated as missing.

| Situation | Result |
| --- | --- |
| Lesson id is unknown, cross-course or staged | `404 LESSON_NOT_FOUND` |
| Lesson's section is missing or staged | `404 SECTION_NOT_FOUND` |
| Lesson type is `quiz` | `409 LESSON_TYPE_UNSUPPORTED` |

## Endpoints

### `PUT /api/courses/:courseId/lessons/:lessonId/progress`

Records the authenticated student's progress. Requires the `X-CSRF-Token`
header matching the CSRF cookie.

Request body (strict; unknown fields are rejected):

```json
{
  "positionSeconds": 42,
  "watchedSeconds": 95,
  "completed": true
}
```

All fields are optional. `positionSeconds` and `watchedSeconds` are finite
non-negative numbers, bounded by a defensive 7-day maximum and then clamped to
the authoritative video duration. `completed` is only meaningful for
text/document lessons.

`durationSeconds`, `ended`, `score`, `studentId`, `completedAt` and any other
field are rejected with `422 VALIDATION_ERROR`. The backend never accepts a
client duration or completion proof for a video.

Response:

```json
{
  "success": true,
  "data": {
    "lessonId": "665d...",
    "sectionId": "665e...",
    "lessonType": "video",
    "watchedSeconds": 95,
    "durationSeconds": 100,
    "lastPositionSeconds": 42,
    "completed": true,
    "completedAt": "2026-10-26T12:00:00.000Z"
  }
}
```

### `GET /api/courses/:courseId/progress`

Returns the student's full course summary and per-lesson progress. Lessons with
no stored row appear with zero progress.

```json
{
  "success": true,
  "data": {
    "courseId": "665f...",
    "completedLessons": 2,
    "totalLessons": 5,
    "percent": 40,
    "currentLessonId": "665d...",
    "lessons": [
      {
        "lessonId": "665d...",
        "sectionId": "665e...",
        "lessonType": "video",
        "watchedSeconds": 95,
        "durationSeconds": 100,
        "lastPositionSeconds": 42,
        "completed": true,
        "completedAt": "2026-10-26T12:00:00.000Z"
      }
    ]
  }
}
```

`currentLessonId` is the most recently updated progress row, or `null` when the
student has not started the course.

### `GET /api/courses/:courseId/lessons/:lessonId/progress`

Returns the resume position and progress for one lesson. Before any progress
exists it returns a zeroed view with `completed: false`.

## Completion rules

### Video

A video is complete when the server-recorded `watchedSeconds` reaches 90% of the
authoritative `durationSeconds` stored on the Video document:

```text
watchedSeconds >= 0.9 × video.durationSeconds
```

The duration is never accepted from the client. A ready video without a positive
stored duration is rejected with `409 LESSON_PAYLOAD_REQUIRED` because
completion cannot be evaluated safely.

The client's `completed` flag and an `ended` event are ignored for video
lessons. Only the recorded watched time is evaluated.

### Text and document

Text and document lessons have no playback. They are completed only by an
explicit authenticated student request with `"completed": true` after the same
access and committed-content checks. A request without `completed: true` is
read-only and does not create a meaningless progress row.

### Quiz

Quiz lessons are excluded from progress tracking until the Quiz System exists
(Phase 10). A progress request for a quiz lesson returns
`409 LESSON_TYPE_UNSUPPORTED`.

## Course summary and enrollment completion

The completion percentage uses only committed lessons whose section is also
committed and whose type is `video`, `text` or `document`:

```text
percent = round(completedLessons / totalLessons × 100)
```

Quiz lessons, staged lessons, lessons in staged sections and stale progress rows
for removed content are excluded from both the numerator and denominator. A
course with zero eligible lessons returns
`{ completedLessons: 0, totalLessons: 0, percent: 0 }` and never completes the
enrollment.

When every eligible lesson is complete, the service calls the existing
idempotent `enrollmentRepository.markCompleted`. That method transitions an
`active` enrollment to `completed`, preserves the first `completedAt`, and
returns `null` for cancelled/expired rows. A cancelled or expired enrollment
cannot be completed through progress.

`GET /api/my-courses` exposes the same summary per enrolled course as
`progress: { completedLessons, totalLessons, percent }`. `course.totalLessons`
still counts every committed lesson, while `progress.totalLessons` counts only
progress-eligible lessons; the two can differ when a course contains quizzes.

## Monotonicity and sticky completion

- `watchedSeconds` uses a MongoDB `$max` update, so a later lower value cannot
  reduce recorded progress.
- `lastPositionSeconds` is updated only when the client supplies a position, so
  a watched-time-only update does not reset the resume position.
- Completion is written by a conditional update that only matches
  `completed: false`. Repeated requests therefore cannot clear completion or
  overwrite the original `completedAt`.
- Concurrent upserts are serialized by the unique `(studentId, lessonId)` index
  and a duplicate-key retry.

## Limits of client-reported progress

The 90% rule is a completion heuristic, not proof that the student genuinely
watched the lesson. A client controls the playback requests it sends and can
report arbitrary watched time, seek forward, or replay a request. The backend
prevents the client from choosing its own duration, completion flag or course
percentage, and it keeps watched time monotonic, but it cannot prove that every
second was rendered on screen. Stronger guarantees require provider-side
playback telemetry or signed playback events, which are out of scope for this
phase.

Progress updates should be throttled by the client (for example on pause, seek,
lesson exit and video end) rather than sent every second. The backend accepts
periodic updates and does not require a specific cadence.

## Errors

| Status | Code | Meaning |
| --- | --- | --- |
| `401` | `AUTH_UNAUTHORIZED` / `AUTH_INVALID_TOKEN` | Missing or invalid authentication |
| `403` | `AUTH_FORBIDDEN` | Teacher/admin account, or missing CSRF token |
| `403` | `COURSE_FORBIDDEN` | No enrollment or a revoked/expired enrollment |
| `404` | `COURSE_NOT_FOUND` | Unknown course, or unpublished course requested by a student |
| `404` | `LESSON_NOT_FOUND` | Unknown, cross-course or staged lesson |
| `404` | `SECTION_NOT_FOUND` | Lesson's section is missing or staged |
| `404` | `LESSON_VIDEO_NOT_FOUND` | Video reference is missing or owned by another teacher |
| `409` | `LESSON_PAYLOAD_REQUIRED` | A video lesson has no video, or the video has no positive duration |
| `409` | `LESSON_TYPE_UNSUPPORTED` | Quiz or other unsupported lesson type |
| `409` | `VIDEO_NOT_READY` | Video is not ready or has no playback URL |
| `422` | `VALIDATION_ERROR` | Malformed ids or invalid playback fields |

## Implementation

- `backend/src/modules/progress/` — constants, types, model, repository, mapper,
  service, controller, routes, validation and barrel export
- `backend/src/modules/courses/lesson-video.ts` — shared video readiness check
  reused by the Course Player and the Progress System
- `LessonRepository.listByCourseIds` / `SectionRepository.listByCourseIds` —
  batch committed-content reads for course summaries
- `enrollmentRepository.markCompleted` — existing idempotent completion entry
  point
- `backend/tests/progress.test.ts` — integration coverage for access, committed
  content, validation, completion thresholds, monotonicity, sticky timestamps,
  course percentages, zero-eligible courses, concurrency and the student course
  list
