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
│   ├── categories/  # Nested category hierarchy, admin CRUD and public tree
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
- `POST /api/teacher/courses/:courseId/publish` — Publish an approved, complete course

State-changing routes require the `X-CSRF-Token` header. A draft may optionally
carry `categoryId`; approval and publishing require a committed category whose
full ancestor chain is active. Video lessons reference an existing video by id and
never duplicate the video pipeline. See
[`../docs/course-builder.md`](../docs/course-builder.md) for the full contract;
publishing, category filtering and the public catalog are documented in
[`../docs/course-publishing.md`](../docs/course-publishing.md).

### Course moderation (admins)

- `GET /api/admin/courses?status=&page=&limit=` — Moderation queue (defaults to `pending_review`)
- `GET /api/admin/courses/:courseId` — Full course content for review
- `POST /api/admin/courses/:courseId/approve` — Approve a pending submission
- `POST /api/admin/courses/:courseId/reject` — Reject a pending submission with `{ "reason": "…" }`
- `PATCH /api/admin/courses/:courseId/category` — Category-only repair for an approved, unpublished course

Only the course owner may submit or publish a course; only admins may approve or
reject. Approval is a review outcome; owners publish separately after server-side
completeness validation. Content edits
claim an exclusive per-course lease, and every course/section/lesson write
carries a token plus a MongoDB-server-time expiry fence. A stalled request whose
lease expired or was replaced gets `409 COURSE_EDIT_IN_PROGRESS` instead of
committing; creates are staged until a fenced authorization/commit succeeds,
and stale recovery discards rows staged or created during the takeover.
Pending/approved/published courses cannot be deleted (`409 COURSE_NOT_DELETABLE`).

### Categories

- `GET /api/categories` — Public active category tree
- `GET /api/admin/categories` — Flat list of all categories (admin)
- `POST /api/admin/categories` — Create a category (admin)
- `GET /api/admin/categories/:categoryId` — Get a category (admin)
- `PATCH /api/admin/categories/:categoryId` — Update name, description, parent, active state or order (admin)
- `DELETE /api/admin/categories/:categoryId` — Delete an unused leaf category (admin)

Admin writes require the `X-CSRF-Token` header. The public endpoint returns only
active categories with active ancestors and never exposes management fields.
Create/update bodies reject unknown fields; ObjectIds are case-insensitive and
normalized. Cycles, the depth cap, safe deletion, the generation-guarded
database-time write fence, staged creation and all error codes are documented in
[`../docs/categories.md`](../docs/categories.md). Courses store an optional
`categoryId`; assignment, approval and publishing share the category lock.
Durable `courseRefs`/`protectedCourseRefs` are written before course rows and
checked atomically by category delete/deactivate/move, so the 30-second category
lease is not the only guarantee. Catalog filtering uses public category slugs.

### Public catalog

- `GET /api/courses?page=&limit=&category=` — Published courses only, newest first
- `GET /api/courses/:slug` — Published course metadata and curriculum outline

The public responses never include lesson bodies, video ids, document URLs,
review metadata or owner identifiers. Instructor data is limited to name and
avatar. `category` filters by a public slug and includes descendants. Non-published
slugs and unknown/hidden categories return `404`.

