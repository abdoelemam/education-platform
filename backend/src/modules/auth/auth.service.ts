import bcrypt from 'bcrypt';
import mongoose, { Types } from 'mongoose';
import { userRepository, type UserRepository } from '../users/user.repository.js';
import { toPublicUser } from '../users/user.mapper.js';
import type { PublicUser, UserDocument } from '../users/user.types.js';
import { RefreshTokenModel, type RefreshTokenDocument } from './refresh-token.model.js';
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  verifyRefreshToken,
  parseDurationToMs,
} from './auth.tokens.js';
import { AUTH_ERRORS, REFRESH_ROTATION_GRACE_PERIOD_MS } from './auth.constants.js';
import { config } from '../../config/index.js';
import { AppError } from '../../errors/index.js';
import type { RegisterDto, LoginDto, AuthResult, AuthTokens } from './auth.types.js';

const BCRYPT_SALT_ROUNDS = 12;

/**
 * Detects whether the active MongoDB deployment topology supports multi-document transactions.
 * Transactions require a replica set or sharded cluster (mongos). Standalone deployments do not support transactions.
 */
function isTransactionSupported(): boolean {
  const client = mongoose.connection.getClient() as unknown as {
    topology?: { description?: { type?: string } };
  };
  const type = client?.topology?.description?.type;
  return type === 'ReplicaSetWithPrimary' || type === 'Sharded' || type === 'LoadBalanced';
}

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
   *
   * Security & Failure-Safety Policy:
   * 1. Pre-validation:
   *    - Verify user exists and is active before performing any token mutations.
   * 2. Failure-Safety during rotation:
   *    - Uses multi-document MongoDB transaction when supported by the cluster.
   *    - Uses atomic claim with compensating rollback on standalone deployments:
   *      If persistence of the replacement token fails, the claim on the old token
   *      is rolled back, keeping the session active so transient DB glitches do not log the user out.
   * 3. Replay vs Concurrency Policy:
   *    - Confirmed Reuse (Theft):
   *      (a) Token rotated outside the grace window (> REFRESH_ROTATION_GRACE_PERIOD_MS).
   *      (b) Token whose replacement has already been consumed/rotated (chain advanced).
   *      (c) Repeated presentation of an already-rotated token (reuseCount >= 1).
   *      Action: Invalidate ALL sessions for the user to contain the breach.
   *    - Concurrent Sibling Request:
   *      (a) Token rotated within grace window (<= REFRESH_ROTATION_GRACE_PERIOD_MS).
   *      (b) Replacement token is still active (chain has not advanced).
   *      (c) First re-presentation attempt on this token (reuseCount == 0).
   *      Action: Increment reuseCount, reject safely with 401 without revoking the active session.
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

    // Step 1: Pre-validate user status before mutating token state
    const user = await this.userRepo.findById(payload.sub);
    if (!user || !user.isActive) {
      throw new AppError(
        401,
        AUTH_ERRORS.UNAUTHORIZED,
        'User account is no longer active',
      );
    }

    const incomingHash = hashToken(rawRefreshToken);

    // Step 2: Prepare replacement token document
    const newRecordId = new Types.ObjectId();
    const newRefreshToken = generateRefreshToken(user._id.toString(), newRecordId.toString());
    const newExpiresAt = new Date(Date.now() + parseDurationToMs(config.JWT_REFRESH_EXPIRES_IN));

    const newRecord = new RefreshTokenModel({
      _id: newRecordId,
      userId: user._id,
      tokenHash: hashToken(newRefreshToken),
      expiresAt: newExpiresAt,
      isRevoked: false,
      reuseCount: 0,
    });

    // Step 3: Execute rotation with transactional or compensating failure-safety
    return this.executeRotationWithSafety({
      tokenId: payload.tokenId,
      userId: user._id.toString(),
      incomingHash,
      newRecord,
      user,
      newRefreshToken,
    });
  }

  /**
   * Evaluates an already-claimed or unrecognized refresh token according to the Replay Policy.
   */
  private async handleUnclaimedToken(
    tokenId: string,
    userId: string,
    now: Date,
  ): Promise<never> {
    const existingRecord = await RefreshTokenModel.findById(
      new Types.ObjectId(tokenId),
    ).exec();

    if (!existingRecord) {
      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Refresh token is invalid, expired, or has already been used',
      );
    }

    if (existingRecord.expiresAt <= now) {
      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Refresh token has expired',
      );
    }

    if (!existingRecord.isRevoked) {
      // Token exists and is not revoked, but failed the hash match
      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Invalid refresh token signature',
      );
    }

    // -------------------------------------------------------------------------
    // The token was previously revoked. Check if it was part of a rotation.
    // -------------------------------------------------------------------------
    if (existingRecord.replacedByTokenHash) {
      const revokedTime = existingRecord.revokedAt ? existingRecord.revokedAt.getTime() : 0;
      const elapsedMs = now.getTime() - revokedTime;
      const isOutsideGracePeriod = elapsedMs > REFRESH_ROTATION_GRACE_PERIOD_MS;
      const isRepeatedAttempt = (existingRecord.reuseCount ?? 0) >= 1;

      // Check whether the replacement token has already advanced (been rotated/revoked)
      const replacementDoc = await RefreshTokenModel.findOne({
        tokenHash: existingRecord.replacedByTokenHash,
      }).exec();
      const replacementAlreadyConsumed = replacementDoc?.isRevoked === true;

      const isConfirmedReuse =
        isOutsideGracePeriod || isRepeatedAttempt || replacementAlreadyConsumed;

      if (isConfirmedReuse) {
        // Confirmed Theft / Replay Policy:
        // Revoke all active sessions for this user to contain the breach.
        await RefreshTokenModel.updateMany(
          { userId: new Types.ObjectId(userId) },
          { isRevoked: true, revokedAt: now },
        ).exec();

        throw new AppError(
          401,
          AUTH_ERRORS.REFRESH_TOKEN_INVALID,
          'Refresh token reuse detected. All sessions have been revoked for security.',
        );
      }

      // Legitimate Concurrent Request Policy:
      // Within grace window, replacement still active, and first concurrent attempt.
      // Increment reuseCount to detect subsequent replays.
      await RefreshTokenModel.findByIdAndUpdate(existingRecord._id, {
        $inc: { reuseCount: 1 },
      }).exec();

      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Refresh token was recently rotated. Please use the newly issued session.',
      );
    }

    // Revoked without replacement (e.g. explicitly logged out or in-flight rollback)
    const revokedTime = existingRecord.revokedAt ? existingRecord.revokedAt.getTime() : 0;
    const elapsedMs = now.getTime() - revokedTime;
    if (elapsedMs <= REFRESH_ROTATION_GRACE_PERIOD_MS) {
      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Refresh token was recently rotated. Please use the newly issued session.',
      );
    }

    throw new AppError(
      401,
      AUTH_ERRORS.REFRESH_TOKEN_INVALID,
      'Refresh token has been revoked',
    );
  }

  /**
   * Executes token rotation with multi-document transaction when supported by MongoDB,
   * or compensating rollback when running on standalone deployments without transaction support.
   */
  private async executeRotationWithSafety(params: {
    tokenId: string;
    userId: string;
    incomingHash: string;
    newRecord: RefreshTokenDocument;
    user: UserDocument;
    newRefreshToken: string;
  }): Promise<AuthTokens> {
    const { tokenId, userId, incomingHash, newRecord, user, newRefreshToken } = params;
    const now = new Date();

    // -------------------------------------------------------------------------
    // Strategy A: Multi-document transaction (if supported by MongoDB cluster)
    // -------------------------------------------------------------------------
    if (isTransactionSupported()) {
      let session: mongoose.ClientSession | null = null;
      try {
        session = await mongoose.startSession();
        session.startTransaction();

        const tokenRecord = await RefreshTokenModel.findOneAndUpdate(
          {
            _id: new Types.ObjectId(tokenId),
            tokenHash: incomingHash,
            isRevoked: false,
            expiresAt: { $gt: now },
          },
          {
            isRevoked: true,
            revokedAt: now,
          },
          { new: false, session },
        ).exec();

        if (!tokenRecord) {
          await session.abortTransaction();
          await session.endSession();
          return this.handleUnclaimedToken(tokenId, userId, now);
        }

        await newRecord.save({ session });

        await RefreshTokenModel.findByIdAndUpdate(
          tokenRecord._id,
          { replacedByTokenHash: newRecord.tokenHash },
          { session },
        ).exec();

        await session.commitTransaction();
        await session.endSession();

        const accessToken = generateAccessToken(user);
        return { accessToken, refreshToken: newRefreshToken };
      } catch (err: unknown) {
        if (session) {
          await session.abortTransaction().catch(() => {});
          await session.endSession().catch(() => {});
        }

        const isCapabilityError =
          err instanceof Error &&
          err.message.includes('Transaction numbers are only allowed');

        if (!isCapabilityError) {
          throw err;
        }
        // If transactions are not supported, proceed to Strategy B below
      }
    }

    // -------------------------------------------------------------------------
    // Strategy B: Atomic Claim with Compensating Rollback (Fallback for Standalone)
    // -------------------------------------------------------------------------
    // 1. Claim the old token atomically
    const tokenRecord = await RefreshTokenModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(tokenId),
        tokenHash: incomingHash,
        isRevoked: false,
        expiresAt: { $gt: now },
      },
      {
        isRevoked: true,
        revokedAt: now,
      },
      { new: false },
    ).exec();

    if (!tokenRecord) {
      return this.handleUnclaimedToken(tokenId, userId, now);
    }

    let newRecordSaved = false;

    try {
      // 2. Persist the replacement token
      await newRecord.save();
      newRecordSaved = true;

      // 3. Link the old token to the replacement hash
      await RefreshTokenModel.findByIdAndUpdate(tokenRecord._id, {
        replacedByTokenHash: newRecord.tokenHash,
      }).exec();

      const accessToken = generateAccessToken(user);
      return { accessToken, refreshToken: newRefreshToken };
    } catch (rotationError) {
      // -----------------------------------------------------------------------
      // Compensating rollback:
      // A failure occurred after claiming the old token. Roll back the claim
      // so the user is NOT left unexpectedly logged out due to transient error!
      // -----------------------------------------------------------------------
      if (newRecordSaved) {
        await RefreshTokenModel.findByIdAndDelete(newRecord._id).catch(() => {});
      }

      await RefreshTokenModel.findByIdAndUpdate(tokenRecord._id, {
        isRevoked: false,
        revokedAt: undefined,
        replacedByTokenHash: undefined,
      }).catch(() => {});

      throw rotationError;
    }
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
    const tokenId = new Types.ObjectId();
    const refreshToken = generateRefreshToken(user._id.toString(), tokenId.toString());
    const expiresAt = new Date(Date.now() + parseDurationToMs(config.JWT_REFRESH_EXPIRES_IN));

    const tokenDoc = new RefreshTokenModel({
      _id: tokenId,
      userId: user._id,
      tokenHash: hashToken(refreshToken),
      expiresAt,
      isRevoked: false,
    });
    await tokenDoc.save();

    const accessToken = generateAccessToken(user);

    return {
      accessToken,
      refreshToken,
    };
  }
}

export const authService = new AuthService();
