import type { Response, CookieOptions } from 'express';
import { config } from '../../config/index.js';
import { AUTH_COOKIES } from './auth.constants.js';
import { parseDurationToMs } from './auth.tokens.js';
import type { AuthTokens } from './auth.types.js';

/**
 * Returns base cookie options configured for environment and deployment architecture.
 */
export function getBaseCookieOptions(): CookieOptions {
  const isProduction = config.NODE_ENV === 'production';

  return {
    httpOnly: true,
    secure: isProduction || config.COOKIE_SAME_SITE === 'none',
    sameSite: config.COOKIE_SAME_SITE,
    domain: config.COOKIE_DOMAIN,
    path: '/',
  };
}

/**
 * Sets secure HttpOnly cookies for access and refresh tokens.
 */
export function setAuthCookies(res: Response, tokens: AuthTokens): void {
  const baseOptions = getBaseCookieOptions();

  const accessMaxAge = parseDurationToMs(config.JWT_ACCESS_EXPIRES_IN);
  const refreshMaxAge = parseDurationToMs(config.JWT_REFRESH_EXPIRES_IN);

  // Access Token Cookie
  res.cookie(AUTH_COOKIES.ACCESS_TOKEN, tokens.accessToken, {
    ...baseOptions,
    maxAge: accessMaxAge,
  });

  // Refresh Token Cookie
  res.cookie(AUTH_COOKIES.REFRESH_TOKEN, tokens.refreshToken, {
    ...baseOptions,
    maxAge: refreshMaxAge,
  });
}

/**
 * Clears authentication cookies upon logout.
 */
export function clearAuthCookies(res: Response): void {
  const baseOptions = getBaseCookieOptions();

  res.clearCookie(AUTH_COOKIES.ACCESS_TOKEN, baseOptions);
  res.clearCookie(AUTH_COOKIES.REFRESH_TOKEN, baseOptions);
}
