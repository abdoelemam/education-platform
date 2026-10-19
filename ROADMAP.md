# ROADMAP

# Phase 0 — Project Definition

Status: Completed

Defined:

* product concept
* users
* roles
* course structure
* architecture
* API strategy
* frontend architecture
* future requirements

---

# Phase 1 — Backend Foundation

Status: Completed

Tasks:

* [x] Initialize Node.js project
* [x] Configure TypeScript
* [x] Configure Express
* [x] Configure environment variables
* [x] Configure MongoDB
* [x] Create project structure
* [x] Add Helmet
* [x] Add CORS
* [x] Add error system
* [x] Add AppError
* [x] Add global error middleware
* [x] Add async handler
* [x] Add Zod validation
* [x] Standardize API responses
* [x] Add health endpoint
* [x] Add logging foundation

Definition of done:

```text
Server starts              ✅
MongoDB connects           ✅
/api/health works          ✅
Errors have standard format ✅
Validation works           ✅
TypeScript passes          ✅
```

---

# Phase 2 — Authentication & Users

Status: Completed

Tasks:

* [x] User model
* [x] Register
* [x] Password hashing
* [x] Login
* [x] Secure authentication cookies
* [x] Refresh lifecycle
* [x] Logout
* [x] GET /me
* [x] Authentication middleware
* [x] Role middleware
* [x] Teacher approval status
* [x] User profile
* [ ] Change password (future)
* [ ] Forgot password (future email provider)
* [ ] Reset password (future email provider)
* [ ] Email verification (future email provider)

Definition of done:

```text
User registration & login  ✅
Password hashing (bcrypt)  ✅
Access & Refresh tokens    ✅
Secure HttpOnly cookies    ✅
Auth & Role middleware     ✅
Teacher approval status    ✅
11 behavior tests passing  ✅
```

---

# Phase 3 — Categories

Tasks:

* [ ] Category model
* [ ] Nested category support
* [ ] Category tree
* [ ] Admin CRUD
* [ ] Public category listing
* [ ] Category filtering

---

# Phase 4 — Course Management

Tasks:

* [x] Course model
* [x] Course creation
* [x] Course editing
* [x] Course drafts
* [x] Course status
* [x] Course slug
* [ ] Thumbnail
* [ ] Category
* [ ] Pricing
* [ ] Level
* [ ] Language
* [ ] Learning outcomes
* [ ] Requirements
* [ ] Course preview
* [x] Course submission
* [ ] Course publishing
* [x] Admin moderation

Notes: the Course Builder delivered the Course model, creation/editing of course
metadata, draft status and a server-generated unique slug. The Teacher Workflow
phase added the review lifecycle (`draft`/`rejected` → `pending_review` →
`approved`/`rejected`), owner-only submission and admin-only moderation.
Publishing (`approved` → `published`) and the remaining metadata (thumbnail,
category, pricing, level, language, outcomes, requirements) stay deferred as
agreed.

---

# Phase 5 — Course Builder

Status: Backend complete (frontend deferred — the frontend app is not initialized yet)

Tasks:

* [x] Sections
* [x] Lessons
* [x] Lesson types
* [x] Add section
* [x] Edit section
* [x] Delete section
* [x] Reorder sections
* [x] Add lesson
* [x] Edit lesson
* [x] Delete lesson
* [x] Reorder lessons
* [x] Course builder API
* [ ] Course builder frontend

Notes: lesson types `video`, `text` and `document` are implemented. The `quiz`
lesson type exists in the domain model but cannot be created until the Quiz
System (Phase 10) exists; creating one returns `LESSON_TYPE_UNSUPPORTED`.
Video lessons reference the existing Video System by id and never duplicate
upload, storage, processing or playback.

Definition of done (backend):

```text
Course creation + metadata           ✅
Sections (CRUD + ordering)           ✅
Lessons (CRUD + ordering + types)    ✅
Ownership + role authorization       ✅
Video lesson linking                 ✅
Validation + standard responses      ✅
41 integration tests                 ✅
```

---

# Teacher Workflow — Course Review & Approval

Status: Backend complete (moderation UI deferred with the frontend)

Tasks:

* [x] Explicit review state machine
* [x] Owner submission (`draft`/`rejected` → `pending_review`)
* [x] Admin moderation queue and detail view
* [x] Admin approval (`pending_review` → `approved`)
* [x] Admin rejection with a validated reason (`pending_review` → `rejected`)
* [x] Edit locking while submitted/approved
* [x] Exclusive content-edit lease with crash recovery
* [x] Rejected-course editing and resubmission
* [x] Server-owned review fields
* [x] Concurrent approve/reject/submission protection
* [x] Stale review decisions pinned to the reviewed submission
* [x] Deletion policy for pending/approved courses
* [ ] Moderation UI
* [ ] Course publishing (`approved` → `published`)

Notes: submission is owner-only; approval/rejection is admin-only. A rejected
course can be edited and resubmitted, which clears the previous review outcome.
Approval is a review result, not publication. Content edits and deletion use an
exclusive per-course lease; pending/approved courses cannot be deleted. Stale
submit/review requests are pinned to the submission they loaded. Runtime checks
are covered by 35 integration tests in
`backend/tests/teacher-workflow.test.ts`.

---

# Phase 6 — Video System

Tasks:

* [x] Video provider abstraction
* [x] Upload authorization
* [ ] Direct/resumable upload
* [x] Video metadata
* [x] Processing status
* [x] Thumbnail
* [x] Duration
* [x] Playback reference
* [ ] Upload UI
* [ ] Upload progress
* [ ] Retry handling
* [ ] Video lesson preview

Notes:

* Direct upload authorization is implemented with signed, provider-neutral
  upload instructions. Resumable uploads are not implemented yet.
* Upload UI, progress, retry handling and lesson preview require the frontend
  and course lessons; they are deferred.

Definition of done (foundational backend):

```text
Video provider abstraction          ✅
Secure direct-upload authorization  ✅
Video metadata persistence          ✅
Server-verified processing status   ✅
Playback gated until provider ready ✅
27 integration + 9 provider tests  ✅
```

---

# Phase 7 — Student Enrollment

Tasks:

* [ ] Enrollment model
* [ ] Free enrollment
* [ ] Enrollment validation
* [ ] Student course list
* [ ] Course access authorization
* [ ] Enrollment history

---

# Phase 8 — Course Player

Tasks:

* [ ] Course player layout
* [ ] Course sidebar
* [ ] Lesson viewer
* [ ] Video lesson
* [ ] Text lesson
* [ ] Document lesson
* [ ] Resources
* [ ] Previous/next navigation
* [ ] Resume lesson
* [ ] Mobile responsive player

---

# Phase 9 — Progress System

Tasks:

* [ ] LessonProgress model
* [ ] Video progress
* [ ] Lesson completion
* [ ] Course completion percentage
* [ ] Resume position
* [ ] Course progress API
* [ ] Progress UI
* [ ] Completion rules

---

# Phase 10 — Quiz System

Tasks:

* [ ] Quiz model
* [ ] Question model
* [ ] Answer model
* [ ] Quiz builder
* [ ] Quiz attempt
* [ ] Start attempt
* [ ] Submit answers
* [ ] Server-side scoring
* [ ] Pass/fail
* [ ] Attempt history
* [ ] Quiz analytics

---

# Phase 11 — Reviews

Tasks:

* [ ] Review model
* [ ] Create review
* [ ] Edit review
* [ ] Delete review
* [ ] Review eligibility
* [ ] Rating aggregation
* [ ] Admin moderation
* [ ] Review UI

---

# Phase 12 — Payments

Tasks:

* [ ] Payment provider abstraction
* [ ] Checkout
* [ ] Transaction model
* [ ] Purchase model
* [ ] Webhook
* [ ] Webhook verification
* [ ] Idempotency
* [ ] Successful payment flow
* [ ] Enrollment after payment
* [ ] Purchase history

---

# Phase 13 — Coupons

Tasks:

* [ ] Coupon model
* [ ] Coupon validation
* [ ] Percentage discount
* [ ] Fixed discount
* [ ] Course-specific coupons
* [ ] Global coupons
* [ ] Expiration
* [ ] Usage limits
* [ ] Teacher management
* [ ] Admin management

---

# Phase 14 — Certificates

Tasks:

* [ ] Certificate model
* [ ] Completion eligibility
* [ ] Certificate generation
* [ ] Certificate PDF
* [ ] Verification code
* [ ] Student certificate page
* [ ] Public verification

---

# Phase 15 — Notifications

Tasks:

* [ ] Notification model
* [ ] Notification service
* [ ] Notification API
* [ ] Read/unread
* [ ] Mark all read
* [ ] Notification UI
* [ ] Event-based notification creation

Future:

* [ ] Socket.IO realtime notifications
* [ ] Email notifications

---

# Phase 16 — Announcements

Tasks:

* [ ] Teacher announcements
* [ ] Course announcements
* [ ] Student announcement feed
* [ ] Notification integration

---

# Phase 17 — Teacher Dashboard

Tasks:

* [ ] Teacher dashboard
* [ ] Course management UI
* [ ] Student list
* [ ] Revenue dashboard
* [ ] Course analytics
* [ ] Completion analytics
* [ ] Quiz analytics
* [ ] Teacher profile

---

# Phase 18 — Admin Dashboard

Tasks:

* [ ] Admin dashboard
* [ ] User management
* [ ] Teacher approval
* [ ] Course moderation
* [ ] Review moderation
* [ ] Transaction management
* [ ] Coupon management
* [ ] Platform analytics
* [ ] System settings

---

# Phase 19 — Frontend Completion

Tasks:

* [ ] Public homepage
* [ ] Course catalog
* [ ] Course details
* [ ] Authentication pages
* [ ] Student dashboard
* [ ] Learning player
* [ ] Teacher dashboard
* [ ] Course builder
* [ ] Admin dashboard
* [ ] Responsive design
* [ ] Loading states
* [ ] Error states
* [ ] Empty states
* [ ] Accessibility improvements

---

# Phase 20 — Testing

Tasks:

* [ ] Unit tests
* [ ] Service tests
* [ ] API integration tests
* [ ] Authentication tests
* [ ] Authorization tests
* [ ] Course ownership tests
* [ ] Enrollment tests
* [ ] Payment webhook tests
* [ ] Quiz scoring tests
* [ ] Progress tests
* [ ] Frontend critical-path tests

---

# Phase 21 — Production Hardening

Tasks:

* [ ] Production environment configuration
* [ ] Security review
* [ ] Rate limiting
* [ ] Logging
* [ ] Monitoring
* [ ] Database indexes
* [ ] API performance review
* [ ] File upload restrictions
* [ ] Error handling review
* [ ] Backup strategy

---

# Phase 22 — Docker & Deployment

Tasks:

* [ ] Backend Dockerfile
* [ ] Frontend Dockerfile/build
* [ ] Docker Compose
* [ ] Environment configuration
* [ ] Reverse proxy
* [ ] HTTPS
* [ ] Cloudflare
* [ ] Production deployment
* [ ] Database connectivity
* [ ] Storage connectivity
* [ ] Health checks
* [ ] Restart policies

Target:

```text
Cloudflare
    ↓
Nginx
    ↓
Docker Network
    ├── Frontend
    └── Backend
          ├── MongoDB / Managed MongoDB
          ├── Video Storage
          └── Payment Provider
```

---

# Development Rule

Only mark a task complete after it has been implemented and verified.

Do not mark a task complete because code was merely generated.

For every completed phase:

1. Run the application.
2. Run type checking.
3. Run tests where applicable.
4. Verify important API flows.
5. Update this roadmap.
6. Update architecture/specification if necessary.

---

# Agreed Implementation Order

The original plan implemented Categories and Course Management before the Video
System. For the next work, that ordering is superseded by the agreed sequence
below. No requirement of the listed phases is changed by this decision.

```text
Video System
   ↓
Course Builder
   ↓
Teacher Workflow
```

Categories and the remaining Course Management work stay defined in this
roadmap and continue after the agreed sequence.

---

# Current Position

Current phase:

```text
Phase 5 — Course Builder + Teacher Workflow (backends complete; frontends deferred)
```

Completed:

```text
Phase 0 — Project Definition
Phase 1 — Backend Foundation
Phase 2 — Authentication & Users
Phase 6 — Video System foundational backend
Phase 5 — Course Builder backend
Teacher Workflow — course submission, review and approval backend
```

Immediate next tasks:

```text
1. Course Builder + moderation frontend (once the frontend app is initialized)
2. Course publishing (approved → published)
```

The remaining Video System items (resumable uploads, upload UI, upload progress,
retry handling, lesson preview) depend on the frontend and course lessons and
are deferred until those exist.

Next sequence:

```text
Video System (foundational backend complete)
→ Course Builder (backend complete)
→ Teacher Workflow (backend complete)
```

Deferred until after that sequence:

```text
Categories
→ Course Management (remaining)
→ Enrollment
→ Course Player
→ Progress
→ Quiz
→ Reviews
→ Payments
→ Certificates
→ Notifications
→ Analytics
→ Admin
→ Testing
→ Deployment
```
