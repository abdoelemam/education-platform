import bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import { userRepository, type UserRepository } from '../users/user.repository.js';
import { toPublicUser } from '../users/user.mapper.js';
import type { PublicUser, UserDocument } from '../users/user.types.js';
import { RefreshTokenModel } from './refresh-token.model.js';
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  generateRandomToken,
  verifyRefreshToken,
  parseDurationToMs,
} from './auth.tokens.js';
import { AUTH_ERRORS } from './auth.constants.js';
import { config } from '../../config/index.js';
import { AppError } from '../../errors/index.js';
import type { RegisterDto, LoginDto, AuthResult, AuthTokens } from './auth.types.js';

const BCRYPT_SALT_ROUNDS = 12;

export class AuthService {
  constructor(private readonly userRepo: UserRepository = userRepository) {}

  /**
   * Register a new user account.
   */
  async register(dto: RegisterDto): Promise<AuthResult> {
    const email = dto.email.toLowerCase().trim();

    // Check if user already exists
    const existing = await this.userRepo.findByEmail(email);
    if (existing) {
      throw new AppError(
        409,
        AUTH_ERRORS.USER_ALREADY_EXISTS,
        'An account with this email address already exists',
      );
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_SALT_ROUNDS);

    // Persist new user
    const user = await this.userRepo.create({
      name: dto.name.trim(),
      email,
      passwordHash,
      role: dto.role ?? 'student',
    });

    // Create session tokens
    const tokens = await this.createTokenSession(user);

    return {
      user: toPublicUser(user),
      tokens,
    };
  }

  /**
   * Authenticate user with email and password.
   */
  async login(dto: LoginDto): Promise<AuthResult> {
    const email = dto.email.toLowerCase().trim();

    // Retrieve user including passwordHash
    const user = await this.userRepo.findByEmail(email, true);
    if (!user) {
      // Use uniform error message to prevent account enumeration
      throw new AppError(
        401,
        AUTH_ERRORS.INVALID_CREDENTIALS,
        'Invalid email or password',
      );
    }

    // Verify password in constant-time
    const isPasswordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new AppError(
        401,
        AUTH_ERRORS.INVALID_CREDENTIALS,
        'Invalid email or password',
      );
    }

    // Verify account active status
    if (!user.isActive) {
      throw new AppError(
        403,
        AUTH_ERRORS.ACCOUNT_DISABLED,
        'Your account has been deactivated. Please contact support.',
      );
    }

    // Update last login timestamp
    await this.userRepo.updateLastLogin(user._id.toString());
    user.lastLoginAt = new Date();

    // Create session tokens
    const tokens = await this.createTokenSession(user);

    return {
      user: toPublicUser(user),
      tokens,
    };
  }

  /**
   * Rotate refresh token and issue a fresh access token.
   */
  async refresh(rawRefreshToken: string): Promise<AuthTokens> {
    const payload = verifyRefreshToken(rawRefreshToken);
    if (!payload || !payload.tokenId || !payload.sub) {
      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Invalid or expired refresh token',
      );
    }

    const incomingHash = hashToken(rawRefreshToken);
    const tokenRecord = await RefreshTokenModel.findById(payload.tokenId).exec();

    if (!tokenRecord) {
      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Refresh token not recognized',
      );
    }

    // Reuse detection: If a revoked token is presented again, invalidate all sessions for safety
    if (tokenRecord.isRevoked) {
      if (tokenRecord.replacedByTokenHash) {
        // Suspected token theft: revoke all sessions for this user
        await RefreshTokenModel.updateMany(
          { userId: new Types.ObjectId(payload.sub) },
          { isRevoked: true, revokedAt: new Date() },
        ).exec();
      }

      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Refresh token has been revoked',
      );
    }

    // Hash integrity verification
    if (tokenRecord.tokenHash !== incomingHash) {
      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Invalid refresh token signature',
      );
    }

    // Expiry check
    if (tokenRecord.expiresAt < new Date()) {
      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Refresh token has expired',
      );
    }

    // Check user status
    const user = await this.userRepo.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new AppError(
        401,
        AUTH_ERRORS.UNAUTHORIZED,
        'User account is no longer active',
      );
    }

    // Generate new refresh token record (rotation)
    const newSessionSecret = generateRandomToken();
    const newExpiresAt = new Date(Date.now() + parseDurationToMs(config.JWT_REFRESH_EXPIRES_IN));

    const newRecord = new RefreshTokenModel({
      userId: user._id,
      tokenHash: hashToken(newSessionSecret),
      expiresAt: newExpiresAt,
      isRevoked: false,
    });
    await newRecord.save();

    // Invalidate old token and link to replacement for reuse detection
    tokenRecord.isRevoked = true;
    tokenRecord.revokedAt = new Date();
    tokenRecord.replacedByTokenHash = newRecord.tokenHash;
    await tokenRecord.save();

    // Create new JWT pair
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user._id.toString(), newRecord._id.toString());

    return {
      accessToken,
      refreshToken,
    };
  }

  /**
   * Revoke an active refresh token session upon logout.
   */
  async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) {
      return;
    }

    const payload = verifyRefreshToken(rawRefreshToken);
    if (!payload || !payload.tokenId) {
      return;
    }

    await RefreshTokenModel.findByIdAndUpdate(payload.tokenId, {
      isRevoked: true,
      revokedAt: new Date(),
    }).exec();
  }

  /**
   * Retrieve the current authenticated user's profile.
   */
  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = await this.userRepo.findById(userId);
    if (!user || !user.isActive) {
      throw new AppError(
        401,
        AUTH_ERRORS.UNAUTHORIZED,
        'Authenticated user not found or inactive',
      );
    }

    return toPublicUser(user);
  }

  /**
   * Helper: Create and persist a new refresh token session and return access/refresh pair.
   */
  private async createTokenSession(user: UserDocument): Promise<AuthTokens> {
    const sessionSecret = generateRandomToken();
    const expiresAt = new Date(Date.now() + parseDurationToMs(config.JWT_REFRESH_EXPIRES_IN));

    const tokenDoc = new RefreshTokenModel({
      userId: user._id,
      tokenHash: hashToken(sessionSecret),
      expiresAt,
      isRevoked: false,
    });
    await tokenDoc.save();

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user._id.toString(), tokenDoc._id.toString());

    return {
      accessToken,
      refreshToken,
    };
  }
}

export const authService = new AuthService();
