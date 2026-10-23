import mongoose, { Schema } from 'mongoose';
import {
  ENROLLMENT_SOURCES,
  ENROLLMENT_STATUSES,
  type IEnrollment,
} from './enrollment.types.js';

/**
 * Enrollment model: the student ↔ course relationship and its lifecycle.
 *
 * Only relationship state lives here. Course metadata stays on Course, student
 * profile data on User, lesson progress on LessonProgress (Phase 9) and money
 * on Order (Phase 12). Historical values such as the purchase price are never
 * copied into an enrollment.
 */
const enrollmentSchema = new Schema<IEnrollment>(
  {
    studentId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    courseId: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    status: {
      type: String,
      enum: {
        values: ENROLLMENT_STATUSES,
        message: 'Invalid enrollment status: {VALUE}',
      },
      default: 'active',
    },
    enrolledAt: {
      type: Date,
      default: () => new Date(),
    },
    completedAt: {
      type: Date,
      default: undefined,
    },
    source: {
      type: String,
      enum: {
        values: ENROLLMENT_SOURCES,
        message: 'Invalid enrollment source: {VALUE}',
      },
      default: 'free',
    },
    /**
     * Paid-enrollment reference. Reserved for verified payment/order records;
     * no order is created in this phase.
     */
    orderId: {
      type: Schema.Types.ObjectId,
      ref: 'Order',
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

/**
 * One enrollment per student per course.
 *
 * This unique index is the authoritative duplicate barrier. It also makes
 * concurrent upserts safe: at most one insert commits and racing requests
 * resolve to the same row.
 */
enrollmentSchema.index({ studentId: 1, courseId: 1 }, { unique: true });

// Teacher roster: enrolled students of one course, newest enrollment first.
enrollmentSchema.index({ courseId: 1, enrolledAt: -1 });

// Student course list: a student's enrollments, newest enrollment first.
enrollmentSchema.index({ studentId: 1, enrolledAt: -1 });

export const EnrollmentModel = mongoose.model<IEnrollment>(
  'Enrollment',
  enrollmentSchema,
);
