import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../../config/index.js';
import type { AccessTokenPayload, RefreshTokenPayload } from './auth.types.js';
import type { UserDocument } from '../users/user.types.js';

/**
 * Hash a refresh token string using SHA-256 for secure server-side storage and fast indexed lookup.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a cryptographically secure random token secret/identifier.
 */
export function generateRandomToken(): string {
  return crypto.randomBytes(40).toString('hex');
}

/**
 * Generate a short-lived Access Token.
 */
export function generateAccessToken(user: UserDocument): string {
  const payload: AccessTokenPayload = {
    sub: user._id.toString(),
    email: user.email,
    role: user.role,
    teacherStatus: user.teacherStatus,
  };

  const options: jwt.SignOptions = {
    expiresIn: config.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  };

  return jwt.sign(payload, config.JWT_ACCESS_SECRET, options);
}

/**
 * Generate a longer-lived Refresh Token with unique tokenId.
 */
export function generateRefreshToken(userId: string, tokenId: string): string {
  const payload: RefreshTokenPayload = {
    sub: userId,
    tokenId,
  };

  const options: jwt.SignOptions = {
    expiresIn: config.JWT_REFRESH_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  };

  return jwt.sign(payload, config.JWT_REFRESH_SECRET, options);
}

/**
 * Verify and decode an Access Token. Returns null if invalid or expired.
 */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, config.JWT_ACCESS_SECRET) as AccessTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Verify and decode a Refresh Token. Returns null if invalid or expired.
 */
export function verifyRefreshToken(token: string): RefreshTokenPayload | null {
  try {
    return jwt.verify(token, config.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Converts a standard duration string (e.g., '15m', '7d', '1h') to milliseconds.
 */
export function parseDurationToMs(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match || !match[1] || !match[2]) {
    // Default fallback: 7 days
    return 7 * 24 * 60 * 60 * 1000;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}
