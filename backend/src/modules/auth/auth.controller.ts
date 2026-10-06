import type { Request, Response } from 'express';
import { authService, type AuthService } from './auth.service.js';
import { setAuthCookies, clearAuthCookies } from './auth.cookies.js';
import { AUTH_COOKIES } from './auth.constants.js';
import { sendSuccess } from '../../utils/api-response.js';
import { AppError } from '../../errors/index.js';
import type { RegisterInput, LoginInput } from './auth.validation.js';

export class AuthController {
  constructor(private readonly authSvc: AuthService = authService) {}

  /**
   * POST /api/auth/register
   */
  register = async (req: Request, res: Response): Promise<void> => {
    const input = req.body as RegisterInput;
    const result = await this.authSvc.register(input);

    // Set secure HttpOnly cookies for both access and refresh tokens
    setAuthCookies(res, result.tokens);

    sendSuccess(res, { user: result.user }, 201);
  };

  /**
   * POST /api/auth/login
   */
  login = async (req: Request, res: Response): Promise<void> => {
    const input = req.body as LoginInput;
    const result = await this.authSvc.login(input);

    // Set secure HttpOnly cookies
    setAuthCookies(res, result.tokens);

    sendSuccess(res, { user: result.user }, 200);
  };

  /**
   * POST /api/auth/refresh
   */
  refresh = async (req: Request, res: Response): Promise<void> => {
    // Read refresh token from HttpOnly cookie or authorization header fallback
    const rawRefreshToken = (req.cookies?.[AUTH_COOKIES.REFRESH_TOKEN] as string | undefined) ??
      (req.headers['x-refresh-token'] as string | undefined);

    if (!rawRefreshToken) {
      throw AppError.unauthorized('Refresh token is required');
    }

    const tokens = await this.authSvc.refresh(rawRefreshToken);

    // Set updated HttpOnly cookies
    setAuthCookies(res, tokens);

    sendSuccess(res, { message: 'Token refreshed successfully' }, 200);
  };

  /**
   * POST /api/auth/logout
   */
  logout = async (req: Request, res: Response): Promise<void> => {
    const rawRefreshToken = req.cookies?.[AUTH_COOKIES.REFRESH_TOKEN] as string | undefined;

    // Revoke server session
    await this.authSvc.logout(rawRefreshToken);

    // Clear HttpOnly cookies
    clearAuthCookies(res);

    sendSuccess(res, { message: 'Logged out successfully' }, 200);
  };

  /**
   * GET /api/auth/me
   */
  me = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw AppError.unauthorized();
    }

    const user = await this.authSvc.getCurrentUser(req.user.id);
    sendSuccess(res, { user }, 200);
  };
}

export const authController = new AuthController();
