import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../modules/auth/auth.tokens.js';
import { AUTH_COOKIES, AUTH_ERRORS } from '../modules/auth/auth.constants.js';
import { userRepository } from '../modules/users/user.repository.js';
import type { UserRole } from '../modules/users/user.types.js';
import { AppError } from '../errors/index.js';

/**
 * Extracts the access token from cookies or Authorization Bearer header.
 */
function extractAccessToken(req: Request): string | null {
  // 1. Try secure HttpOnly cookie first
  if (req.cookies && typeof req.cookies[AUTH_COOKIES.ACCESS_TOKEN] === 'string') {
    return req.cookies[AUTH_COOKIES.ACCESS_TOKEN];
  }

  // 2. Fallback to Authorization header: "Bearer <token>"
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  return null;
}

/**
 * Middleware: Requires the request to be authenticated with a valid access token.
 * Attaches the active user context to `req.user`.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractAccessToken(req);

  if (!token) {
    throw new AppError(
      401,
      AUTH_ERRORS.UNAUTHORIZED,
      'Authentication required. Please sign in.',
    );
  }

  const payload = verifyAccessToken(token);
  if (!payload || !payload.sub) {
    throw new AppError(
      401,
      AUTH_ERRORS.INVALID_TOKEN,
      'Invalid or expired authentication token',
    );
  }

  // Verify the user exists and is active in the database
  const user = await userRepository.findById(payload.sub);
  if (!user) {
    throw new AppError(
      401,
      AUTH_ERRORS.UNAUTHORIZED,
      'User account no longer exists',
    );
  }

  if (!user.isActive) {
    throw new AppError(
      403,
      AUTH_ERRORS.ACCOUNT_DISABLED,
      'Account is disabled',
    );
  }

  // Attach strongly-typed user context to request
  req.user = {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    teacherStatus: user.teacherStatus,
    isActive: user.isActive,
  };

  next();
}

/**
 * Middleware factory: Enforces that the authenticated user possesses one of the allowed roles.
 * Usage:
 *   router.post('/courses', requireAuth, requireRole('teacher', 'admin'), controller.create);
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new AppError(
        401,
        AUTH_ERRORS.UNAUTHORIZED,
        'Authentication required',
      );
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new AppError(
        403,
        AUTH_ERRORS.FORBIDDEN,
        `Access restricted. Requires one of: ${allowedRoles.join(', ')}`,
      );
    }

    next();
  };
}

/**
 * Middleware: Requires that a teacher is in 'approved' status before performing approved teacher actions.
 */
export function requireApprovedTeacher(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    throw new AppError(401, AUTH_ERRORS.UNAUTHORIZED, 'Authentication required');
  }

  if (req.user.role === 'admin') {
    // Admin can bypass teacher verification
    next();
    return;
  }

  if (req.user.role !== 'teacher') {
    throw new AppError(403, AUTH_ERRORS.FORBIDDEN, 'Teacher access required');
  }

  if (req.user.teacherStatus !== 'approved') {
    throw new AppError(
      403,
      AUTH_ERRORS.FORBIDDEN,
      'Teacher account is pending review or not approved',
    );
  }

  next();
}
