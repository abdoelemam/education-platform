import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { AppError } from '../errors/index.js';

/**
 * CSRF Protection — Double-Submit Cookie Pattern
 *
 * Deployment model:
 *   - React SPA (frontend) served from its own origin (e.g. https://app.example.com)
 *   - Express API (backend) served from its API origin (e.g. https://api.example.com)
 *   - HTTPS in production; both origins share a parent domain (or SameSite=None+Secure)
 *   - Authentication uses HttpOnly cookies for token storage
 *
 * Why CORS alone is not enough:
 *   CORS restricts which origins can READ cross-origin responses, but a forged form
 *   POST or a request from a malicious origin with `credentials: 'include'` can still
 *   cause cookie-authenticated state changes.  A CSRF token carried in a custom header
 *   (X-CSRF-Token) closes this gap because the Same-Origin Policy prevents a third-party
 *   page from reading or setting arbitrary request headers on cross-origin fetch.
 *
 * How it works:
 *   1. After login/register the server calls `setCsrfCookie()` to set a READABLE
 *      (non-HttpOnly) cookie containing a cryptographically random token.
 *   2. The React client reads this cookie and includes the value in the X-CSRF-Token
 *      header on every state-changing request (POST / PUT / PATCH / DELETE).
 *   3. `verifyCsrfToken` middleware validates that the header value matches the cookie
 *      value.  A forged cross-site request cannot set custom headers, so it fails.
 *
 * Local development:
 *   When NODE_ENV !== 'production' the CSRF cookie is not Secure and SameSite defaults
 *   to 'lax', which keeps local http:// development working without TLS.
 *
 * SameSite consideration:
 *   - Same-origin deployment (frontend+backend same domain): SameSite=Lax is sufficient
 *     and CSRF tokens are a defence-in-depth measure.
 *   - Cross-origin deployment (separate domains): SameSite=None+Secure is required for
 *     cookies to be sent at all; CSRF tokens remain the primary cross-site guard.
 */

import { AUTH_ERRORS } from '../modules/auth/auth.constants.js';

export const CSRF_COOKIE_NAME = 'csrf_token';
export const CSRF_HEADER_NAME = 'x-csrf-token';

/**
 * Generate and set the CSRF double-submit cookie.
 * Call this after a successful login or registration.
 */
export function setCsrfCookie(res: Response): void {
  const token = crypto.randomBytes(32).toString('hex');
  const isProduction = config.NODE_ENV === 'production';

  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // MUST be readable by JavaScript (the SPA reads and echoes it)
    secure: isProduction || config.COOKIE_SAME_SITE === 'none',
    sameSite: config.COOKIE_SAME_SITE,
    domain: config.COOKIE_DOMAIN,
    path: '/',
    // No maxAge — session cookie; rotated on each login/register/refresh
  });
}

/**
 * Clear the CSRF cookie on logout.
 */
export function clearCsrfCookie(res: Response): void {
  const isProduction = config.NODE_ENV === 'production';

  res.clearCookie(CSRF_COOKIE_NAME, {
    httpOnly: false,
    secure: isProduction || config.COOKIE_SAME_SITE === 'none',
    sameSite: config.COOKIE_SAME_SITE,
    domain: config.COOKIE_DOMAIN,
    path: '/',
  });
}

/**
 * Middleware: Verify that the X-CSRF-Token request header matches the csrf_token cookie.
 *
 * Apply to all state-changing routes that use cookie authentication:
 *   POST /api/auth/refresh
 *   POST /api/auth/logout
 *   POST /api/courses   (future)
 *   etc.
 *
 * Read-only endpoints (GET) are exempt — they cannot change state.
 */
export function verifyCsrfToken(req: Request, _res: Response, next: NextFunction): void {
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME] as string | undefined;
  const headerToken = (req.headers[CSRF_HEADER_NAME] as string | undefined) ??
    (req.headers['x-xsrf-token'] as string | undefined);

  if (!cookieToken || !headerToken) {
    throw new AppError(403, AUTH_ERRORS.CSRF_TOKEN_MISSING, 'CSRF token is required');
  }

  // Constant-time comparison prevents timing attacks
  const cookieBuf = Buffer.from(cookieToken);
  const headerBuf = Buffer.from(headerToken);

  if (
    cookieBuf.length !== headerBuf.length ||
    !crypto.timingSafeEqual(cookieBuf, headerBuf)
  ) {
    throw new AppError(403, AUTH_ERRORS.CSRF_TOKEN_INVALID, 'Invalid CSRF token');
  }

  next();
}
