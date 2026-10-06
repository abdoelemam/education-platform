import type { Document, Types } from 'mongoose';

/**
 * Platform user roles.
 * Strongly typed and reusable across the platform.
 */
export const USER_ROLES = ['student', 'teacher', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Teacher approval status lifecycle.
 */
export const TEACHER_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export type TeacherStatus = (typeof TEACHER_STATUSES)[number];

/**
 * Core User entity interface representing database structure.
 */
export interface IUser {
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  teacherStatus: TeacherStatus;
  avatar?: string;
  isActive: boolean;
  isEmailVerified: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Mongoose document representation of a User.
 */
export interface UserDocument extends IUser, Document<Types.ObjectId> {
  _id: Types.ObjectId;
}

/**
 * Sanitized public user profile safe for API responses.
 * Never includes passwordHash or internal Mongoose fields.
 */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  teacherStatus: TeacherStatus;
  avatar?: string;
  isActive: boolean;
  isEmailVerified: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Authenticated user payload attached to Express requests (req.user).
 */
export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  teacherStatus: TeacherStatus;
  isActive: boolean;
}
