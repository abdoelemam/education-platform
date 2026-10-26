import mongoose, { Schema } from 'mongoose';
import {
  USER_ROLES,
  TEACHER_STATUSES,
  TEACHER_REJECTION_REASON_MAX,
  type UserDocument,
} from './user.types.js';

const userSchema = new Schema<UserDocument>(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters long'],
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required'],
      select: false, // Protected by default from queries
    },
    role: {
      type: String,
      enum: {
        values: USER_ROLES,
        message: 'Invalid user role: {VALUE}',
      },
      default: 'student',
      index: true,
    },
    teacherStatus: {
      type: String,
      enum: {
        values: TEACHER_STATUSES,
        message: 'Invalid teacher status: {VALUE}',
      },
      default: 'none',
    },
    avatar: {
      type: String,
      default: undefined,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    lastLoginAt: {
      type: Date,
      default: undefined,
    },
    teacherRejectionReason: {
      type: String,
      trim: true,
      maxlength: [
        TEACHER_REJECTION_REASON_MAX,
        `Teacher rejection reason cannot exceed ${TEACHER_REJECTION_REASON_MAX} characters`,
      ],
      default: undefined,
    },
    teacherReviewedAt: {
      type: Date,
      default: undefined,
    },
    teacherReviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: undefined,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete (ret as Record<string, unknown>).passwordHash;
        delete (ret as Record<string, unknown>).__v;
        return ret;
      },
    },
  },
);

// Supports the admin teacher-approval queue without scanning all users.
userSchema.index({ role: 1, teacherStatus: 1, createdAt: 1 });

export const UserModel = mongoose.model<UserDocument>('User', userSchema);
