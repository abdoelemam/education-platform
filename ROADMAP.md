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

Status: In Progress

Tasks:

* [ ] Initialize Node.js project
* [ ] Configure TypeScript
* [ ] Configure Express
* [ ] Configure environment variables
* [ ] Configure MongoDB
* [ ] Create project structure
* [ ] Add Helmet
* [ ] Add CORS
* [ ] Add error system
* [ ] Add AppError
* [ ] Add global error middleware
* [ ] Add async handler
* [ ] Add Zod validation
* [ ] Standardize API responses
* [ ] Add health endpoint
* [ ] Add logging foundation

Definition of done:

```text
Server starts
MongoDB connects
/api/health works
Errors have standard format
Validation works
TypeScript passes
```

---

# Phase 2 — Authentication & Users

Tasks:

* [ ] User model
* [ ] Register
* [ ] Password hashing
* [ ] Login
* [ ] Secure authentication cookies
* [ ] Refresh lifecycle
* [ ] Logout
* [ ] GET /me
* [ ] Authentication middleware
* [ ] Role middleware
* [ ] Teacher approval status
* [ ] User profile
* [ ] Change password
* [ ] Forgot password
* [ ] Reset password
* [ ] Email verification

Definition of done:

A student can register/login/logout and access protected endpoints.

Teacher authorization must distinguish pending and approved teachers.

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

* [ ] Course model
* [ ] Course creation
* [ ] Course editing
* [ ] Course drafts
* [ ] Course status
* [ ] Course slug
* [ ] Thumbnail
* [ ] Category
* [ ] Pricing
* [ ] Level
* [ ] Language
* [ ] Learning outcomes
* [ ] Requirements
* [ ] Course preview
* [ ] Course submission
* [ ] Course publishing
* [ ] Admin moderation

---

# Phase 5 — Course Builder

Tasks:

* [ ] Sections
* [ ] Lessons
* [ ] Lesson types
* [ ] Add section
* [ ] Edit section
* [ ] Delete section
* [ ] Reorder sections
* [ ] Add lesson
* [ ] Edit lesson
* [ ] Delete lesson
* [ ] Reorder lessons
* [ ] Course builder API
* [ ] Course builder frontend

---

# Phase 6 — Video System

Tasks:

* [ ] Video provider abstraction
* [ ] Upload authorization
* [ ] Direct/resumable upload
* [ ] Video metadata
* [ ] Processing status
* [ ] Thumbnail
* [ ] Duration
* [ ] Playback reference
* [ ] Upload UI
* [ ] Upload progress
* [ ] Retry handling
* [ ] Video lesson preview

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

# Current Position

Current phase:

```text
Phase 1 — Backend Foundation
```

Immediate next tasks:

```text
1. Error system
2. Validation
3. Standard response format
4. User model
5. Authentication
```

After authentication:

```text
Categories
→ Courses
→ Course Builder
→ Video System
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
