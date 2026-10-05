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
