export const AUTH_COOKIES = {
  ACCESS_TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
} as const;

export const AUTH_ERRORS = {
  INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  FORBIDDEN: 'AUTH_FORBIDDEN',
  ACCOUNT_DISABLED: 'AUTH_ACCOUNT_DISABLED',
  TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
  REFRESH_TOKEN_INVALID: 'AUTH_REFRESH_TOKEN_INVALID',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  CSRF_TOKEN_MISSING: 'CSRF_TOKEN_MISSING',
  CSRF_TOKEN_INVALID: 'CSRF_TOKEN_INVALID',
} as const;

/**
 * Grace period (in milliseconds) allowed for in-flight concurrent refresh requests.
 * Sibling requests presenting the recently rotated token within this window are rejected
 * safely without triggering user session revocation.
 */
export const REFRESH_ROTATION_GRACE_PERIOD_MS = 15 * 1000; // 15 seconds
