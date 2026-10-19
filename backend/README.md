# Backend

Backend API for the education platform.

## Tech Stack

- **Runtime:** Node.js
- **Language:** TypeScript
- **Framework:** Express 5
- **Database:** MongoDB / Mongoose
- **Validation:** Zod
- **Security:** Helmet, CORS

## Project Structure

```text
src/
├── config/          # Environment and app configuration
├── database/        # MongoDB connection management
├── errors/          # AppError and error classes
├── middleware/       # Express middleware (error handler, validation, logging)
├── modules/         # Feature-based modules
│   ├── auth/        # Authentication and sessions
│   ├── courses/     # Course Builder (courses, sections, lessons)
│   ├── users/       # User accounts and roles
│   ├── videos/      # Provider-agnostic video system
│   └── health/      # Health check endpoint
├── utils/           # Shared utilities (logger, async handler, API responses)
├── app.ts           # Express app factory
└── server.ts        # Server entry point
```

## Getting Started

1. Copy `.env.example` to `.env` and fill in required values
2. Ensure MongoDB is running
3. Install dependencies: `npm install`
4. Run in development: `npm run dev`
5. Build for production: `npm run build`
6. Start production: `npm start`

## Scripts

- `npm run dev` — Start development server with hot reload
- `npm run build` — Compile TypeScript to JavaScript
- `npm start` — Run compiled production build
- `npm test` — Run automated test suite with Vitest
- `npm run typecheck` — Run TypeScript type checking
- `npm run lint` — Run ESLint
- `npm run lint:fix` — Run ESLint with auto-fix

## API Endpoints

### Health

- `GET /api/health` — Application health check

### Authentication

- `POST /api/auth/register` — Register a new account (`name`, `email`, `password`, optional `role`)
- `POST /api/auth/login` — Sign in with `email` and `password`
- `POST /api/auth/refresh` — Rotate refresh token and issue new token pair
- `POST /api/auth/logout` — Revoke session and clear authentication cookies
- `GET /api/auth/me` — Retrieve authenticated user profile (protected)

### Videos (approved teachers)

- `POST /api/teacher/videos` — Create video metadata
- `GET /api/teacher/videos` — List the caller's videos
- `GET /api/teacher/videos/:videoId` — Get video metadata
- `POST /api/teacher/videos/:videoId/upload-authorization` — Get signed direct-upload instructions
- `POST /api/teacher/videos/:videoId/upload-complete` — Verify upload with the provider
- `GET /api/teacher/videos/:videoId/playback` — Get playback reference (only once ready)
- `DELETE /api/teacher/videos/:videoId` — Delete metadata and provider asset

State-changing routes require the `X-CSRF-Token` header. Video bytes are
uploaded directly to the storage provider; see [`../docs/video-system.md`](../docs/video-system.md)
for the full contract and provider configuration.

### Courses (approved teachers)

- `POST /api/teacher/courses` — Create a draft course
- `GET /api/teacher/courses` — List the caller's courses (paginated)
- `GET /api/teacher/courses/:courseId` — Get a course with its sections and lessons
- `PATCH /api/teacher/courses/:courseId` — Update course metadata
- `DELETE /api/teacher/courses/:courseId` — Delete a draft/rejected course and cascade its content
- `POST /api/teacher/courses/:courseId/sections` — Add a section
- `PATCH /api/teacher/courses/:courseId/sections/:sectionId` — Edit a section
- `DELETE /api/teacher/courses/:courseId/sections/:sectionId` — Delete a section and its lessons
- `PUT /api/teacher/courses/:courseId/sections/reorder` — Reorder sections
- `POST /api/teacher/courses/:courseId/sections/:sectionId/lessons` — Add a lesson
- `PATCH /api/teacher/courses/:courseId/sections/:sectionId/lessons/:lessonId` — Edit a lesson
- `DELETE /api/teacher/courses/:courseId/sections/:sectionId/lessons/:lessonId` — Delete a lesson
- `PUT /api/teacher/courses/:courseId/sections/:sectionId/lessons/reorder` — Reorder lessons
- `POST /api/teacher/courses/:courseId/submit` — Submit a draft/rejected course for review

State-changing routes require the `X-CSRF-Token` header. Video lessons reference
an existing video by id and never duplicate the video pipeline. See
[`../docs/course-builder.md`](../docs/course-builder.md) for the full contract.

### Course moderation (admins)

- `GET /api/admin/courses?status=&page=&limit=` — Moderation queue (defaults to `pending_review`)
- `GET /api/admin/courses/:courseId` — Full course content for review
- `POST /api/admin/courses/:courseId/approve` — Approve a pending submission
- `POST /api/admin/courses/:courseId/reject` — Reject a pending submission with `{ "reason": "…" }`

Only the course owner may submit a course; only admins may approve or reject.
Approval is a review outcome; publishing remains a later phase. Content edits
claim an exclusive per-course lease, so a write that starts just before
submission cannot land after review. Pending/approved courses cannot be deleted
(`409 COURSE_NOT_DELETABLE`).

