import type { UserDocument, PublicUser, IUser } from './user.types.js';

/**
 * Maps a User Mongoose document or User entity into a sanitized PublicUser object.
 * Guarantee: never exposes passwordHash, mongo internal versions, or internal tokens.
 */
export function toPublicUser(user: UserDocument | (IUser & { _id: unknown })): PublicUser {
  const id = typeof user._id === 'object' && user._id !== null
    ? user._id.toString()
    : String(user._id);

  return {
    id,
    name: user.name,
    email: user.email,
    role: user.role,
    teacherStatus: user.teacherStatus,
    avatar: user.avatar,
    isActive: user.isActive,
    isEmailVerified: user.isEmailVerified,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : undefined,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
