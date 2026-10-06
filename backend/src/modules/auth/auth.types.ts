import type { UserRole, TeacherStatus, PublicUser } from '../users/user.types.js';

export interface AccessTokenPayload {
  sub: string; // User ID
  email: string;
  role: UserRole;
  teacherStatus: TeacherStatus;
}

export interface RefreshTokenPayload {
  sub: string; // User ID
  tokenId: string; // Unique refresh token record ID for rotation & revocation tracking
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RegisterDto {
  name: string;
  email: string;
  password: string;
  role?: 'student' | 'teacher';
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthResult {
  user: PublicUser;
  tokens: AuthTokens;
}
