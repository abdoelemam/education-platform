import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { AppError } from '../errors/index.js';

/**
 * CSRF Protection — Double-Submit Cookie Pattern
 *
 * Supported Deployment Scenarios:
 *
 * 1. Same-Origin Architecture (Reverse Proxy / Single Domain)
 *    - Example: Frontend at https://example.com, API at https://example.com/api
 *    - COOKIE_SAME_SITE: 'lax'
 *    - COOKIE_DOMAIN: (unset/omitted — host-only cookie, most secure)
 *    - CORS_ORIGIN: 'https://example.com'
 *    - Security: Browsers only attach cookies on first-party requests. The Double-Submit
 *      cookie pattern provides defence-in-depth against subtle cross-site POST attacks.
 *
 * 2. Shared-Domain / Subdomain Architecture (Separate Subdomains)
 *    - Example: Frontend at https://app.example.com, API at https://api.example.com
 *    - COOKIE_SAME_SITE: 'lax' (both origins share the same registrable domain 'example.com')
 *    - COOKIE_DOMAIN: '.example.com' (enables cookie sharing across subdomains)
 *    - CORS_ORIGIN: 'https://app.example.com' with credentials: true
 *    - Security: Both subdomains belong to the same site. The double-submit CSRF cookie
 *      is accessible to app.example.com, while external domains (*.attacker.com) cannot
 *      read it. Note: Subdomain security assumes all other subdomains on example.com are trusted.
 *
 * 3. Cross-Site Cross-Origin Architecture (Distinct Domains)
 *    - Example: Frontend at https://my-app.vercel.app, API at https://api.render.com
 *    - COOKIE_SAME_SITE: 'none' (mandatory for cross-site cookie transmission)
 *    - Secure flag: ALWAYS true (enforced automatically in getBaseCookieOptions)
 *    - CORS_ORIGIN: 'https://my-app.vercel.app' with credentials: true
 *    - Security: When SameSite=None is used, ambient cookies are sent with all cross-site
 *      requests. The Double-Submit cookie pattern is the PRIMARY defense: external sites
 *      cannot read the non-HttpOnly csrf_token cookie across origins, so they cannot
 *      populate the required X-CSRF-Token header.
 *    - Limitation: Strict browsers (e.g., Safari ITP or Chrome third-party cookie phase-out)
 *      may partition or block cross-site cookies. For production SaaS, Scenario 1 or 2 is
 *      strongly recommended over Scenario 3.
 *
 * Why CORS alone is not enough:
 *    CORS prevents cross-origin scripts from READING responses, but does NOT prevent
 *    browsers from executing state-changing POST/PUT requests with ambient cookies.
 *    Custom headers (X-CSRF-Token) trigger CORS preflight and cannot be forged by
 *    third-party HTML forms or scripts.
 *
 * Local Development:
 *    When NODE_ENV !== 'production' and COOKIE_SAME_SITE !== 'none', cookies are set
 *    without the Secure flag to allow seamless testing over http://localhost without TLS.
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
