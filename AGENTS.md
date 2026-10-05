# AGENTS.md

## Project

This repository contains a full-stack online education platform.

The platform allows teachers to create and publish educational courses containing video lessons, text lessons, documents, and quizzes. Students can enroll in courses, watch lessons, track progress, take quizzes, receive certificates, and review courses. Administrators manage the entire platform.

The project is designed to grow into a production-ready educational SaaS/platform.

---

# 1. Repository Structure

The repository is organized as:

```text
education-platform/
│
├── AGENTS.md
├── PROJECT_SPEC.md
├── ARCHITECTURE.md
├── ROADMAP.md
│
├── backend/
│
└── frontend/
```

Before implementing any feature, read:

1. `AGENTS.md`
2. `PROJECT_SPEC.md`
3. `ARCHITECTURE.md`
4. `ROADMAP.md`

These files are the persistent project context.

---

# 2. Core Technology

## Backend

Use:

* Node.js
* TypeScript
* Express 5
* MongoDB
* Mongoose
* Zod
* JWT/session authentication as defined by the architecture
* bcrypt for password hashing

## Frontend

Use:

* React
* TypeScript
* React Router
* TanStack Query
* Zustand
* Axios
* React Hook Form
* Zod
* Tailwind CSS

Do not introduce another major state-management library unless there is a strong architectural reason.

---

# 3. Architecture Rules

Follow the architecture defined in `ARCHITECTURE.md`.

Backend request flow:

```text
Request
   ↓
Middleware
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
Database / External Service
```

Do not place business logic directly inside controllers.

Controllers should remain thin.

Services contain business rules.

Repositories handle persistence operations.

---

# 4. Feature-Based Backend Organization

Backend modules should be organized by feature.

Example:

```text
src/modules/courses/

├── course.model.ts
├── course.routes.ts
├── course.controller.ts
├── course.service.ts
├── course.repository.ts
├── course.schema.ts
└── course.types.ts
```

Do not create a giant global controller/service file containing unrelated features.

---

# 5. Feature-Based Frontend Organization

Frontend features should also be organized by domain.

Example:

```text
src/features/courses/

├── api/
├── components/
├── hooks/
├── pages/
├── schemas/
└── types/
```

Keep reusable generic UI components in:

```text
src/components/
```

Do not put course-specific components into the generic component directory.

---

# 6. Server State vs Client State

Use TanStack Query for server state:

* courses
* course details
* enrollments
* progress
* reviews
* teacher analytics
* admin data
* notifications from the API

Use Zustand for client/application state:

* authentication UI state
* UI preferences
* sidebar state
* temporary client-only state
* other state that does not belong in the server cache

Do not duplicate server state unnecessarily inside Zustand.

---

# 7. API Rules

All APIs must use the `/api` prefix.

Example:

```text
/api/auth/login
/api/courses
/api/teacher/courses
/api/student/courses
/api/admin/users
```

Use a consistent response format.

Success:

```json
{
  "success": true,
  "data": {}
}
```

List response:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "SOME_ERROR",
    "message": "Human readable message",
    "details": {}
  }
}
```

---

# 8. Validation

All external input must be validated.

Validate:

* request body
* route parameters
* query parameters

Use Zod.

Never trust client-provided values such as:

* price
* role
* user ID
* teacher ID
* course ownership
* payment status
* enrollment status
* quiz score
* course completion

The backend is always the source of truth.

---

# 9. Authentication

Authentication must be implemented securely.

Never store plain-text passwords.

Use:

```text
password
   ↓
bcrypt
   ↓
passwordHash
```

Do not expose `passwordHash` through API responses.

Authentication should use secure HttpOnly cookies according to the authentication architecture.

Do not put authentication secrets in localStorage unless explicitly required by a future architectural decision.

---

# 10. Authorization

Authorization has multiple levels.

## Authentication

Is the user logged in?

## Role authorization

Is the user:

```text
student
teacher
admin
```

## Teacher authorization

A teacher must be approved before accessing teacher functionality.

## Resource ownership

A teacher can only modify resources they own unless the user is an admin.

Example:

```text
Teacher A
   ↓
PATCH /api/teacher/courses/courseB
   ↓
If courseB belongs to Teacher B
   ↓
403 Forbidden
```

Never rely only on frontend route protection.

Frontend protection is for UX.

Backend authorization is the real security boundary.

---

# 11. User Roles

Supported roles:

```text
student
teacher
admin
```

Teacher status:

```text
none
pending
approved
rejected
```

A teacher with:

```text
role = teacher
teacherStatus = pending
```

must not be allowed to perform approved teacher operations.

---

# 12. Course Status

Courses should support a lifecycle such as:

```text
draft
pending_review
published
rejected
archived
```

Do not reduce course publishing to only a boolean.

Publishing must perform backend validation.

Example requirements may include:

* title
* description
* category
* thumbnail
* pricing configuration
* at least one section
* valid lessons
* required lesson content

The backend must remain the source of truth for publication validation.

---

# 13. Course Structure

The platform supports:

```text
Course
   ↓
Sections
   ↓
Lessons
```

Lessons may have different types:

```text
video
text
document
quiz
```

Courses must support ordering.

Teachers should be able to reorder:

* sections
* lessons

Ordering must be persisted in the backend.

---

# 14. Video Architecture

Do not send large video files through the Node.js application server unless explicitly required.

Preferred flow:

```text
Teacher Browser
      ↓
Node.js
      ↓
Upload authorization / signed upload
      ↓
Video Storage Provider
      ↓
Video metadata/reference
      ↓
MongoDB
```

The database should store video metadata/reference, not the raw video file.

The video system must be designed to support large files and future resumable/direct uploads.

---

# 15. Enrollment

Enrollment must be created by trusted backend logic.

For free courses:

```text
Student
   ↓
Enroll
   ↓
Backend validation
   ↓
Enrollment
```

For paid courses:

```text
Student
   ↓
Checkout
   ↓
Payment Provider
   ↓
Webhook
   ↓
Verified payment
   ↓
Purchase
   ↓
Enrollment
```

Never grant paid course access merely because the browser returns from a checkout page.

Payment webhooks are the trusted source for payment confirmation.

---

# 16. Course Access

Before returning protected course content, the backend must verify:

```text
User authenticated
        ↓
Enrollment exists
        ↓
Enrollment is valid
        ↓
Access allowed
```

Students must not access paid course lessons through direct API requests without authorization.

---

# 17. Progress

The platform must support lesson progress.

For video lessons:

```text
watchedSeconds
duration
completed
lastPosition
```

Progress updates should not be sent every second.

Use reasonable periodic updates and important events such as:

* pause
* seek
* lesson exit
* video ended

The backend calculates authoritative completion.

---

# 18. Quiz System

Quiz scores must be calculated on the backend.

Never trust:

```text
score
correctAnswers
passed
```

sent by the client.

The client submits answers.

The backend evaluates them.

Flow:

```text
Start Attempt
      ↓
Submit Answers
      ↓
Backend Evaluation
      ↓
Calculate Score
      ↓
Save Attempt
      ↓
Return Result
```

---

# 19. Payments

Payment-related logic must be isolated.

Do not mix payment provider logic directly into controllers.

Prefer:

```text
Payment Controller
       ↓
Payment Service
       ↓
Payment Provider Adapter
```

This allows changing payment providers later.

Payment webhook handling must be idempotent.

The same webhook may arrive more than once.

---

# 20. Certificates

Certificates are generated only when the backend determines that the student has completed the required course requirements.

Certificate verification must use a unique verification code.

Public verification endpoint:

```text
/api/certificates/verify/:verificationCode
```

---

# 21. Notifications

Notifications should be represented as persistent data.

Possible events:

* course approval
* course rejection
* successful payment
* enrollment
* course completion
* certificate issued
* teacher approval

Future realtime delivery may use Socket.IO.

Do not tightly couple core business logic to Socket.IO.

Business events should be able to work even if realtime delivery is unavailable.

---

# 22. Error Handling

Use a central error system.

Expected structure:

```text
AppError
Global Error Middleware
```

Known application errors should provide:

```text
statusCode
code
message
details
```

Unexpected errors must not expose sensitive internal information in production.

---

# 23. Logging

Use structured logging as the project grows.

Never log:

* passwords
* tokens
* payment secrets
* private user data
* sensitive credentials

---

# 24. Security

The implementation should consider:

* Helmet
* CORS
* rate limiting
* secure cookies
* input validation
* authorization
* ownership checks
* webhook verification
* password hashing
* file validation
* upload restrictions
* pagination
* query filtering protection
* protection against unauthorized course access

Do not implement security only on the frontend.

---

# 25. Database Rules

Use MongoDB/Mongoose.

Models must represent real domain entities.

Avoid creating unnecessary duplicate data.

Use references where appropriate.

Denormalization is allowed when it provides a clear performance or historical-data benefit.

For financial records, preserve immutable historical information where necessary.

For example, a purchase should preserve the purchased price even if the course price changes later.

---

# 26. Payments and Financial Data

Never calculate historical revenue from the current course price.

Store transaction/purchase snapshots.

Example:

```text
coursePriceAtPurchase
discountAmount
taxAmount
platformFee
paymentProviderFee
netAmount
currency
```

Financial records should be treated as historical records.

---

# 27. Course Builder

The Course Builder is a major feature.

It must support:

```text
Create course
Edit course
Add section
Edit section
Delete section
Reorder sections

Add lesson
Edit lesson
Delete lesson
Reorder lessons

Add video lesson
Add text lesson
Add document lesson
Add quiz

Save draft
Preview
Submit for review
Publish when approved
```

The backend must support all of these operations even if the first frontend implementation exposes only a subset.

---

# 28. Do Not Break Future Architecture

When implementing an early phase, do not create temporary architecture that blocks future phases.

For example:

Bad:

```text
Course model only contains:
title
description
```

if future requirements clearly require:

* pricing
* category
* instructor
* sections
* status
* publishing
* analytics
* reviews

Instead, design the domain model so future capabilities can be added cleanly.

However, do not implement speculative complexity that has no relation to the project requirements.

---

# 29. Backward Compatibility

Before changing:

* API contracts
* database fields
* route names
* authentication behavior
* response formats

inspect existing code and determine whether existing functionality depends on them.

Do not casually break working features.

---

# 30. Coding Style

Prefer:

* small functions
* clear names
* explicit types
* reusable utilities
* feature-based modules
* single responsibility
* readable code

Avoid:

* giant files
* giant controllers
* deeply nested logic
* duplicated business logic
* magic strings
* unexplained constants

---

# 31. Before Implementing a Feature

The agent must:

1. Read the relevant specification.
2. Inspect the existing code.
3. Identify dependencies.
4. Check existing API/model conventions.
5. Implement the feature.
6. Update tests.
7. Update documentation if architecture changed.
8. Run type checking.
9. Run tests.
10. Fix errors before declaring completion.

Do not blindly overwrite existing code.

---

# 32. Definition of Done

A feature is not considered complete merely because the UI exists.

A feature is complete when applicable:

* backend logic exists
* validation exists
* authorization exists
* database changes exist
* API exists
* frontend integration exists
* loading state exists
* error state exists
* empty state exists
* tests exist
* type checking passes
* documentation is updated

---

# 33. Current Development Rule

The project is being developed incrementally.

The architecture must account for the complete platform from the beginning, but implementation should proceed according to `ROADMAP.md`.

Do not skip ahead randomly.

Complete the current roadmap phase, verify it, then continue to the next phase.

---

# 34. Important Instruction

Do not replace the architecture with a simpler architecture merely to make implementation faster.

If an implementation decision conflicts with:

* `PROJECT_SPEC.md`
* `ARCHITECTURE.md`
* `ROADMAP.md`

stop and explain the conflict before making a major architectural change.

Small implementation details can be decided autonomously.

Major architectural decisions should be documented.
