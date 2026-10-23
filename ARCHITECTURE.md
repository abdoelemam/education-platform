# ARCHITECTURE

## 1. High-Level Architecture

```text
                    Internet
                       │
                       ▼
                  Cloudflare
                       │
                       ▼
                 Reverse Proxy
                       │
              ┌────────┴────────┐
              │                 │
              ▼                 ▼
           React             Node.js API
          Frontend                │
                                  │
                ┌─────────────────┼─────────────────┐
                │                 │                 │
                ▼                 ▼                 ▼
             MongoDB          File/Video         Payment
                              Storage            Provider
```

---

# 2. Frontend Architecture

```text
React
 │
 ├── Routing
 │
 ├── Pages
 │
 ├── Feature Modules
 │
 ├── TanStack Query
 │
 ├── Zustand
 │
 ├── Axios
 │
 └── UI Components
```

Server data belongs primarily to TanStack Query.

Client-only state belongs primarily to Zustand.

---

# 3. Backend Architecture

```text
HTTP Request
     ↓
Express
     ↓
Security Middleware
     ↓
Authentication
     ↓
Authorization
     ↓
Validation
     ↓
Controller
     ↓
Service
     ↓
Repository
     ↓
Database / External Provider
```

---

# 4. Controllers

Controllers are responsible for:

* receiving HTTP input
* invoking services
* returning HTTP responses

Controllers should not contain large business rules.

Bad:

```text
Controller
 ├── payment calculations
 ├── enrollment logic
 ├── authorization rules
 ├── database queries
 └── email logic
```

Preferred:

```text
Controller
   ↓
Service
   ↓
Repository / Provider
```

---

# 5. Services

Services contain business logic.

Examples:

```text
CourseService
EnrollmentService
PaymentService
QuizService
ProgressService
CertificateService
```

Services can coordinate multiple repositories/providers.

---

# 6. Repositories

Repositories isolate persistence.

Examples:

```text
CourseRepository
UserRepository
EnrollmentRepository
PurchaseRepository
```

Repositories should not contain HTTP logic.

---

# 7. External Providers

External integrations should use adapter/provider layers.

Examples:

```text
PaymentProvider
VideoStorageProvider
EmailProvider
```

This prevents vendor-specific logic from spreading across the application.

---

# 8. Authentication Architecture

Preferred model:

```text
Browser
   ↓
Secure HttpOnly Cookie
   ↓
Authentication Middleware
   ↓
User
```

Authentication implementation should support access/refresh lifecycle where appropriate.

Secrets must live in environment variables.

---

# 9. Authorization Architecture

Authorization occurs after authentication.

```text
Authentication
       ↓
User
       ↓
Role Check
       ↓
Ownership Check
       ↓
Resource Access
```

Example:

```text
Teacher
   ↓
role = teacher
   ↓
teacherStatus = approved
   ↓
course.teacher = currentUser.id
   ↓
Allow
```

Admins may bypass ownership checks where appropriate.

---

# 10. Database Domain Model

Core entities:

```text
User
Category
Course
Section
Lesson
Video
Resource
Quiz
Question
QuizAttempt
Enrollment
LessonProgress
Review
Purchase
Transaction
Coupon
Certificate
Notification
Announcement
```

Relationships:

```text
User
 ├── teaches → Course
 ├── enrolls → Enrollment
 ├── creates → Review
 ├── owns → Purchase
 └── receives → Notification

Course
 ├── belongs to → Teacher/User
 ├── belongs to → Category
 ├── contains → Sections
 ├── contains → Lessons
 ├── has → Reviews
 ├── has → Enrollments
 └── has → Purchases

Section
 └── contains → Lessons

Lesson
 ├── may contain → Video
 ├── may contain → Resource
 └── may contain → Quiz

Quiz
 ├── contains → Questions
 └── has → QuizAttempts
```

---

# 11. Course Builder Architecture

Course Builder operates on:

```text
Course
   ↓
Sections
   ↓
Lessons
```

Ordering must be explicit.

Example:

```text
Section
{
  order: 1
}
```

Lesson:

```text
Lesson
{
  order: 3
}
```

Reordering must be persisted through dedicated APIs.

## Implementation Notes (Phase 5)

* `Course`, `Section` and `Lesson` are separate MongoDB collections. Sections
  reference their course and lessons reference both their section and course,
  which keeps ordering, scoped lookups and cascade deletes simple.
* Ordering is stored as a 1-based `order` field. Add operations append after the
  current maximum; dedicated reorder endpoints accept the complete ordered id
  list and rewrite only the `order` fields.
* Every course operation is scoped to the course owner. Admins may bypass
  ownership. A section or lesson id from another course is treated as missing.
* Video lessons store a `videoId` reference to the existing Video System. The
  video must exist and belong to the course owner; upload, storage, processing
  and playback remain owned by the Video System.
* Lesson types are `video`, `text`, `document` and `quiz`. `quiz` is reserved
  until the Quiz System exists and is rejected on write.
* Deleting a course cascades to its sections and lessons. Videos are
  independent assets and are never deleted by the course module.

## Teacher Workflow Notes (Phase 5 follow-up)

The review lifecycle is an explicit service-owned state machine:

```text
draft ──owner submit──▶ pending_review ──admin approve──▶ approved
  ▲                            │
  │                            └──admin reject (reason)──▶ rejected
  └──────── owner edits ◀────────────────────────────────────┘
```

* Submission is owner-only; admins cannot submit on a teacher's behalf.
* Approval/rejection is admin-only and only valid from `pending_review`.
* `approved` means "review approved", not published. The owner publishes it
  separately (`approved` → `published`) after server-side completeness
  validation.
* Content edits are allowed only in `draft` or `rejected`. A submitted,
  approved or published course is frozen so the reviewed version cannot change
  underneath the reviewer or students.
* Every content mutation claims an exclusive per-course edit lease in MongoDB
  before writing and releases it afterwards. Acquisition stamps the token and
  database-time expiry onto every existing section/lesson. Every course,
  section and lesson write filter then requires the matching token and an
  unexpired lease (`$$NOW`), so a request that resumes after expiry/recovery
  cannot commit. Creates are staged as hidden rows and activated only after a
  fenced course-authorization write and a fenced commit; stale recovery
  snapshots existing rows and removes anything staged or created during the
  takeover. Submission only transitions while the lease is free, so an edit
  that began just before submission cannot land after the review snapshot is
  taken. A five-minute lease is recoverable after a crash, and a
  per-acquisition token prevents an old request from releasing a newer holder's
  lease.
* A rejected course is editable and resubmittable. Resubmission clears the old
  rejection reason, reviewer and review timestamp, then records a new
  `submittedAt`.
* Status, reviewer identity, review timestamps and rejection reasons are
  server-owned; clients cannot set them through course/lesson payloads. Review
  metadata is mapped only into owner/admin responses.
* Transitions use a compare-and-set update (`status` must still match). Both
  submission and review decisions pin the `submittedAt` value the caller loaded,
  so a stale submit or review request cannot act on a newer review cycle.
* A course can be deleted only in `draft` or `rejected`; pending and approved
  courses return `COURSE_NOT_DELETABLE` rather than silently withdrawing a
  submission or deleting reviewed content. Deletion also takes the edit lease.
  The parent is deleted under the fence before content cleanup, so a cleanup
  failure can leave unreachable orphan sections/lessons but never visible
  partial course content. Transactions or resumable cleanup remain follow-ups.
* Admins get a read-only moderation queue and detail view under
  `/api/admin/courses`; all review mutations require CSRF.

The full HTTP contract is documented in [`docs/course-builder.md`](docs/course-builder.md).

## Publishing and Public Catalog Notes

```text
approved ──owner publish + completeness validation──▶ published
                              │
                              ▼
                     GET /api/courses
                     GET /api/courses/:slug
```

* Publishing is a separate owner action from admin approval. Admins cannot
  publish on a teacher's behalf.
* Completeness is validated on the backend against committed sections/lessons
  only. Missing metadata, empty sections, invalid lesson payloads and videos that
  are not provider-ready block publication with `422 COURSE_NOT_PUBLISHABLE` and
  machine-readable `details.reasons`.
* The transition is a compare-and-set on `approved`, pinned to the reviewed
  `submittedAt`, and requires the content-edit lease to be free. A stale or
  abandoned lease is recovered like submission.
* `published` is terminal in this phase. Archive, unpublish and a
  post-publication edit/re-review flow remain later phases.
* The public catalog reads published courses only and exposes metadata plus a
  curriculum outline. Lesson bodies, video ids, document URLs and playback
  references are never returned: protected content requires the Enrollment and
  Course Player authorization boundary.
* Instructor data in the catalog is limited to display name and avatar.
* `priceMinor` (integer minor units) and `currency` are publication metadata.
  Payments, coupons and enrollment are separate phases and no revenue is derived
  from the current price.
* Category is not required to publish yet. The Category backend foundation
  exists, but courses do not reference categories until the course-category PR.

The full publishing contract is documented in
[`docs/course-publishing.md`](docs/course-publishing.md).

## Category Foundation

Categories use an adjacency list (`parentId`) rather than denormalized ancestor
paths, so moving a node cannot leave stale descendant metadata. The model stores
`name`, an immutable unique `slug`, optional `description`, `isActive` and
`sortOrder`.

* Public reads build a tree from the category collection and expose only active
  nodes whose entire ancestor chain is active. Management fields are never
  returned publicly.
* Admin CRUD requires `role = "admin"`; writes are CSRF-protected. Create and
  update bodies are strict Zod objects, and ObjectIds are normalized before
  comparison.
* The service rejects self-parenting, moves under a descendant, missing parents
  and trees deeper than 10 levels.
* Category-tree mutations are serialized by a short-lived lease because
  standalone MongoDB cannot transact across parent/child documents. Acquisition
  uses MongoDB server time. The same atomic acquisition increments a monotonic
  generation and copies the token, generation and expiry onto committed category
  rows that carry an older generation; every write must match all three at
  database time, and creates are staged until a fenced commit succeeds. A late
  refresh from an older holder cannot overwrite a newer fence, and acquisition
  revalidates token/generation/expiry after refreshing. A stalled writer cannot
  land after its lease expired or a newer writer took over. A concurrent/
  conflicted write gets `409 CATEGORY_BUSY`; expired and malformed locks are
  recoverable. Acquisition also reconciles the lease generation against the
  highest committed row fence and raises it with a guarded atomic lock update
  when the singleton was deleted, recreated or restored at an older generation.
  The following refresh then rewrites every older fence, so a holder that
  validated under the lost lock cannot write. Staged rows from older or
  same-generation foreign tokens are revoked before the refresh; expired ones
  are cleaned up and a strictly newer live staged row is preserved. Standalone
  MongoDB cannot atomically couple the lock with a staged commit, so a restored
  singleton with no committed generation floor cannot classify a strictly newer
  live staged row; that boundary needs transactions or a durable non-resettable
  allocator and is documented as a residual limitation.
* Deletion is blocked by child categories or course references. Deactivation and
  moves that would hide a branch are blocked when the subtree contains
  approved/published courses. The course reference checks are forward-compatible
  with the next phase; that phase must add the course `categoryId` index and
  decide whether category-changing course writes share this lock.
* The tree builder is cycle-safe even if corrupt rows are inserted directly.

Course ↔ category linking, catalog `?category=` filtering and the category
publishing requirement are deliberately a separate phase. The full contract is
documented in [`docs/categories.md`](docs/categories.md).

---

# 12. Video Architecture

Preferred:

```text
Teacher
   ↓
Request Upload Authorization
   ↓
Backend
   ↓
Video Provider
   ↓
Direct/Resumable Upload
   ↓
Processing
   ↓
Video Metadata
   ↓
Lesson
```

The application database stores the provider reference and metadata.

The exact provider should remain replaceable.

Implementation (Phase 6 foundational backend):

```text
backend/src/modules/videos/
├── video.model.ts
├── video.repository.ts
├── video.service.ts
├── video.controller.ts
├── video.routes.ts
├── video.validation.ts
└── providers/
    ├── video-provider.interface.ts
    ├── cloudinary.video-provider.ts
    └── unconfigured.video-provider.ts
```

- `VideoProvider` isolates provider-specific upload authorization, asset
  verification and deletion, so providers can be replaced without touching the
  service or routes.
- The browser uploads directly to the provider with short-lived signed
  instructions; the API never proxies video bytes.
- MongoDB stores only metadata and the provider reference.
- Duration, dimensions, processing status and playback URLs come from
  server-side provider verification, never from the client.
- Without configuration the fail-closed adapter returns `503` instead of faking
  a successful upload.

---

# 13. Payment Architecture

```text
Student
   ↓
Checkout API
   ↓
Payment Service
   ↓
Payment Provider
   ↓
Webhook
   ↓
Webhook Verification
   ↓
Transaction
   ↓
Purchase
   ↓
Enrollment
```

Webhook handling must be idempotent.

---

# 14. Progress Architecture

```text
Video Player
   ↓
Progress Events
   ↓
Learning API
   ↓
Progress Service
   ↓
LessonProgress
   ↓
Course Progress
```

Do not persist every video time update.

Use throttled updates.

---

# 15. Quiz Architecture

```text
Student
   ↓
Start Attempt
   ↓
Attempt ID
   ↓
Submit Answers
   ↓
Quiz Service
   ↓
Server-side Evaluation
   ↓
QuizAttempt
```

The client cannot determine its own score.

---

# 16. Certificate Architecture

```text
Course Completion
       ↓
Eligibility Check
       ↓
Certificate Service
       ↓
Certificate Record
       ↓
PDF Generation
       ↓
Storage
       ↓
Student Download
```

Verification:

```text
Public Request
       ↓
Verification Code
       ↓
Certificate Record
       ↓
Valid / Invalid
```

---

# 17. Notification Architecture

Business operation:

```text
Payment Successful
```

should conceptually produce:

```text
Payment Event
     ↓
Notification Service
     ↓
Persist Notification
     ↓
Optional Realtime Delivery
```

Realtime delivery must not be required for the core transaction to succeed.

---

# 18. API Organization

Public APIs:

```text
/api/auth/*
/api/courses/*
/api/categories/*
/api/certificates/verify/*
```

Student APIs:

```text
/api/student/*
/api/learning/*
```

Teacher APIs:

```text
/api/teacher/*
/api/teacher/videos/*
```

Admin APIs:

```text
/api/admin/*
```

Payment APIs:

```text
/api/payments/*
```

---

# 19. Frontend Feature Structure

```text
src/
│
├── app/
│   ├── router/
│   ├── providers/
│   └── store/
│
├── features/
│   ├── auth/
│   ├── courses/
│   ├── learning/
│   ├── quizzes/
│   ├── enrollment/
│   ├── payments/
│   ├── reviews/
│   ├── certificates/
│   ├── teacher/
│   ├── student/
│   ├── admin/
│   └── notifications/
│
├── components/
│   ├── ui/
│   ├── layout/
│   └── common/
│
├── lib/
├── hooks/
└── assets/
```

---

# 20. Frontend Data Flow

```text
React Component
      ↓
Feature Hook
      ↓
TanStack Query
      ↓
API Function
      ↓
Axios
      ↓
Node.js API
```

---

# 21. Frontend Authentication Flow

```text
Application Start
      ↓
GET /api/auth/me
      ↓
Backend checks cookie
      ↓
User returned
      ↓
Auth state updated
```

The frontend should not assume authentication based only on local storage.

---

# 22. Error Flow

Backend:

```text
Error
 ↓
AppError
 ↓
Global Error Middleware
 ↓
Standard JSON
```

Frontend:

```text
API Error
 ↓
Axios Error Handling
 ↓
TanStack Query
 ↓
UI Error State
```

---

# 23. Security Boundary

The frontend is untrusted.

Never trust:

```text
role
price
userId
teacherId
course ownership
payment status
score
completion
```

sent by the frontend.

The backend validates and calculates authoritative values.

---

# 24. Deployment Architecture

The target deployment may eventually be:

```text
Cloudflare
     ↓
Nginx / Reverse Proxy
     ↓
Docker Network
     ├── React / Static Frontend
     ├── Node.js API
     └── supporting services
```

Database and video storage may be managed externally depending on production requirements.

The deployment architecture should not require major application-code changes.
