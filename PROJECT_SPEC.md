# PROJECT SPECIFICATION

## 1. Product Overview

We are building a full-stack online education platform.

The platform allows teachers to create and sell educational courses and allows students to discover, purchase/enroll in, and consume those courses online.

The system is intended to eventually become a production-ready platform rather than a simple demo.

---

# 2. Main User Types

## Student

Students can:

* register
* login
* browse courses
* search courses
* filter courses
* view course details
* enroll in free courses
* purchase paid courses
* watch video lessons
* read text lessons
* download allowed resources
* complete lessons
* track course progress
* take quizzes
* view quiz results
* review courses
* receive certificates
* view purchases
* receive notifications
* manage their profile

---

## Teacher

Teachers can:

* register as teachers
* wait for teacher approval when required
* create courses
* edit courses
* save drafts
* upload course thumbnails
* create sections
* create lessons
* upload videos
* create text lessons
* upload documents
* create quizzes
* reorder sections
* reorder lessons
* preview courses
* submit courses for review
* publish approved courses
* manage announcements
* view enrolled students
* view course analytics
* view revenue
* manage teacher profile

---

## Admin

Admins can:

* manage users
* approve/reject teachers
* suspend users
* manage categories
* review courses
* approve/reject courses
* archive courses
* manage reviews
* inspect purchases
* inspect transactions
* manage platform settings
* view platform analytics
* manage coupons
* moderate platform content

---

# 3. Course Structure

A course contains:

```text
Course
│
├── Basic Information
│   ├── title
│   ├── slug
│   ├── description
│   ├── thumbnail
│   ├── category
│   ├── level
│   └── language
│
├── Pricing
│   ├── price
│   ├── currency
│   └── discount configuration
│
├── Sections
│   │
│   ├── Section
│   │   ├── Lesson
│   │   ├── Lesson
│   │   └── Quiz
│   │
│   └── Section
│       ├── Lesson
│       └── Lesson
│
├── Reviews
├── Enrollments
├── Progress
└── Analytics
```

---

# 4. Lesson Types

Supported lesson types:

```text
video
text
document
quiz
```

The architecture should allow additional lesson types later.

---

# 5. Course Lifecycle

Courses can move through:

```text
draft
pending_review
published
rejected
archived
```

Typical teacher workflow:

```text
Create Course
      ↓
Draft
      ↓
Build Content
      ↓
Preview
      ↓
Submit For Review
      ↓
Admin Review
      ↓
Approved
      ↓
Published
```

---

# 6. Course Discovery

The public course catalog must support:

* search
* pagination
* category filtering
* level filtering
* price filtering
* sorting

Possible sorting:

```text
popular
newest
rating
price_low
price_high
```

---

# 7. Course Details

The public course page should contain:

* title
* description
* instructor
* instructor information
* thumbnail
* rating
* review count
* price
* discount
* curriculum
* requirements
* learning outcomes
* course level
* language
* duration
* student count where appropriate
* enrollment/purchase CTA
* reviews

---

# 8. Student Learning Experience

The course player should contain:

```text
Course Header
Progress
Course Sidebar
Lesson Viewer
Resources
Lesson Navigation
```

The sidebar displays:

```text
Sections
   ↓
Lessons
   ↓
Completion state
```

The student should be able to resume video lessons from the last stored position.

---

# 9. Progress Requirements

Track:

* lesson completion
* video position
* course completion percentage
* current lesson
* completed lessons
* quiz completion

Course progress should be calculated from authoritative backend data.

---

# 10. Quiz Requirements

Quiz supports:

* title
* description
* questions
* multiple choice answers
* correct answer
* explanation
* passing score
* attempt limits if enabled
* attempt history
* score
* pass/fail result

The backend evaluates submitted answers.

---

# 11. Enrollment

Enrollment represents student access to a course.

Enrollment may originate from:

* free enrollment
* successful paid purchase

Enrollment should track relevant timestamps and status.

---

# 12. Purchases

Purchases should preserve historical financial information.

A purchase should be associated with:

* student
* course
* transaction
* original price
* discount
* final price
* currency
* payment provider
* payment status
* purchase date

---

# 13. Reviews

Students who satisfy the required eligibility rules can submit reviews.

Reviews contain:

```text
rating
comment
student
course
createdAt
updatedAt
status
```

Admins can moderate reviews.

---

# 14. Certificates

A certificate can be issued after successful course completion.

Certificate should contain:

* student
* course
* teacher
* issue date
* certificate number
* verification code

Public verification must be supported.

---

# 15. Notifications

Notification examples:

```text
Teacher approved
Course approved
Course rejected
Payment successful
Enrollment successful
Certificate issued
Course announcement
```

The notification system should support persistent notifications and future realtime delivery.

---

# 16. Teacher Analytics

Teacher analytics should eventually include:

* total students
* total enrollments
* course views
* course completion
* average rating
* revenue
* sales over time
* student activity
* quiz performance

---

# 17. Admin Analytics

Admin analytics should eventually include:

* total students
* total teachers
* active teachers
* total courses
* published courses
* total enrollments
* total purchases
* gross revenue
* platform revenue
* growth metrics

---

# 18. Payments

The payment system must support:

```text
Checkout
Payment confirmation
Webhook processing
Purchase creation
Enrollment creation
Refund support in future
```

Payment provider implementation must be isolated behind an adapter/service layer.

---

# 19. Video Requirements

Video system must support:

* large video uploads
* direct/resumable upload architecture
* video metadata
* thumbnail
* duration
* playback URL/reference
* upload status
* processing status

The Node.js server should not become the permanent storage layer for large video files.

---

# 20. Future Capabilities

The architecture should leave room for:

* coupons
* discounts
* teacher payouts
* refunds
* realtime notifications
* email notifications
* course announcements
* student discussions
* Q&A
* additional quiz types
* multiple payment providers
* multiple storage/video providers
* mobile application
* API clients
* advanced analytics
* recommendation systems

These features should not force a rewrite of the core architecture.

---

# 21. Non-Functional Requirements

The application should prioritize:

* security
* maintainability
* scalability
* clean architecture
* good UX
* predictable APIs
* testability
* observability
* performance

The system should be suitable for eventual Docker-based production deployment.

---

# 22. Important Principle

The project should be built as a real product architecture, not as a collection of unrelated CRUD pages.

Domain rules must live in the backend.

The frontend is a client of the API.

The backend is the source of truth.
