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
* `approved` means "review approved", not published. Publishing
  (`approved` → `published`) and archiving are later phases.
* Content edits are allowed only in `draft` or `rejected`. A submitted or
  approved course is frozen so the reviewed version cannot change underneath
  the reviewer.
* A rejected course is editable and resubmittable. Resubmission clears the old
  rejection reason, reviewer and review timestamp, then records a new
  `submittedAt`.
* Status, reviewer identity, review timestamps and rejection reasons are
  server-owned; clients cannot set them through course/lesson payloads.
* Transitions use a compare-and-set update (`status` must still match), so
  concurrent review decisions cannot both succeed.
* Admins get a read-only moderation queue and detail view under
  `/api/admin/courses`; all review mutations require CSRF.

The full HTTP contract is documented in [`docs/course-builder.md`](docs/course-builder.md).

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
