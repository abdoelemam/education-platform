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
   *    - Persists the replacement before atomically claiming and linking the old token
   *      on standalone deployments. A replay revocation therefore either invalidates
   *      the old token before it can be claimed or sees and revokes the replacement.
   * 3. Replay vs Concurrency Policy:
   *    - Confirmed Reuse:
   *      (a) Token rotated outside the grace window (> REFRESH_ROTATION_GRACE_PERIOD_MS).
   *      (b) Token whose replacement has already been consumed/rotated (chain advanced).
   *      (c) Repeated presentation of an already-rotated token (atomic reuseCount > 1).
   *      Action: Invalidate ALL sessions for the user to contain the breach.
   *    - Concurrent Sibling Request:
   *      (a) Token rotated within grace window (<= REFRESH_ROTATION_GRACE_PERIOD_MS).
   *      (b) Replacement has no verified rotation successor.
   *      (c) First re-presentation attempt on this token (atomic reuseCount == 1).
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

    // Step 3: Execute rotation with transactional or atomic-claim failure-safety
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
    incomingHash: string,
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

    if (
      existingRecord.userId.toString() !== userId ||
      existingRecord.tokenHash !== incomingHash
    ) {
      throw new AppError(
        401,
        AUTH_ERRORS.REFRESH_TOKEN_INVALID,
        'Refresh token is invalid, expired, or has already been used',
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
    if (
      existingRecord.replacedByTokenHash &&
      (existingRecord.revocationReason === 'rotation' || !existingRecord.revocationReason)
    ) {
      // This conditional write is the replay check's linearization point. It
      // serializes with rotation's isRevoked:false claim on the replacement,
      // so chain evidence cannot be a stale read from before that rotation.
      const activeReplacement = await RefreshTokenModel.findOneAndUpdate(
        {
          tokenHash: existingRecord.replacedByTokenHash,
          userId: existingRecord.userId,
          isRevoked: false,
        },
        { $set: { lastReplayCheckAt: now } },
        { new: true },
      ).exec();

      let replacementDoc = activeReplacement;
      if (!replacementDoc) {
        replacementDoc = await RefreshTokenModel.findOne({
          tokenHash: existingRecord.replacedByTokenHash,
          userId: existingRecord.userId,
        }).exec();
      }
      const replacementAlreadyConsumed =
        replacementDoc?.isRevoked === true &&
        (replacementDoc.revocationReason === 'rotation' ||
          (!replacementDoc.revocationReason && Boolean(replacementDoc.replacedByTokenHash)));

      // Atomically assign the first sibling retry. Concurrent replays receive
      // distinct incremented values, so only one can be treated as in-flight.
      const replayRecord = await RefreshTokenModel.findOneAndUpdate(
        {
          _id: existingRecord._id,
          userId: existingRecord.userId,
          isRevoked: true,
          replacedByTokenHash: existingRecord.replacedByTokenHash,
          revocationReason: { $in: ['rotation', null] },
        },
        { $inc: { reuseCount: 1 } },
        { new: true },
      ).exec();

      if (!replayRecord) {
        throw new AppError(
          401,
          AUTH_ERRORS.REFRESH_TOKEN_INVALID,
          'Refresh token has been revoked',
        );
      }

      const revokedTime = replayRecord.revokedAt ? replayRecord.revokedAt.getTime() : 0;
      const elapsedMs = now.getTime() - revokedTime;
      const isOutsideGracePeriod = elapsedMs > REFRESH_ROTATION_GRACE_PERIOD_MS;
      const isRepeatedAttempt = (replayRecord.reuseCount ?? 1) > 1;

      const isConfirmedReuse =
        isOutsideGracePeriod || isRepeatedAttempt || replacementAlreadyConsumed;

      if (isConfirmedReuse) {
        // Revoke only active sessions belonging to this user. Preserve the
        // original revocation cause on already-consumed tokens in the chain.
        await RefreshTokenModel.updateMany(
          { userId: existingRecord.userId, isRevoked: false },
          {
            $set: {
              isRevoked: true,
              revokedAt: now,
              revocationReason: 'security_replay',
            },
          },
        ).exec();

        throw new AppError(
          401,
          AUTH_ERRORS.REFRESH_TOKEN_INVALID,
          'Refresh token reuse detected. All sessions have been revoked for security.',
        );
      }

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
   * Executes token rotation transactionally when supported. On standalone deployments,
   * persists the private replacement candidate before atomically claiming the old token.
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
    const accessToken = generateAccessToken(user);

    // -------------------------------------------------------------------------
    // Strategy A: Multi-document transaction (if supported by MongoDB cluster)
    // -------------------------------------------------------------------------
    if (isTransactionSupported()) {
      let session: mongoose.ClientSession | null = null;
      try {
        session = await mongoose.startSession();
        session.startTransaction();

        await newRecord.save({ session });

        const tokenRecord = await RefreshTokenModel.findOneAndUpdate(
          {
            _id: new Types.ObjectId(tokenId),
            userId: new Types.ObjectId(userId),
            tokenHash: incomingHash,
            isRevoked: false,
            expiresAt: { $gt: now },
          },
          {
            $set: {
              isRevoked: true,
              revokedAt: now,
              revocationReason: 'rotation',
              replacedByTokenHash: newRecord.tokenHash,
            },
          },
          { new: false, session },
        ).exec();

        if (!tokenRecord) {
          await session.abortTransaction();
          await session.endSession();
          return this.handleUnclaimedToken(tokenId, userId, incomingHash, now);
        }

        await session.commitTransaction();
        await session.endSession();

        return { accessToken, refreshToken: newRefreshToken };
      } catch (err: unknown) {
        const cleanupErrors: unknown[] = [];
        if (session) {
          if (session.inTransaction()) {
            try {
              await session.abortTransaction();
            } catch (cleanupError: unknown) {
              cleanupErrors.push(cleanupError);
            }
          }
          try {
            await session.endSession();
          } catch (cleanupError: unknown) {
            cleanupErrors.push(cleanupError);
          }
        }

        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [err, ...cleanupErrors],
            'Refresh token transaction failed and cleanup could not be completed',
          );
        }

        const isCapabilityError =
          err instanceof Error &&
          err.message.includes('Transaction numbers are only allowed');

        if (!isCapabilityError) {
          throw err;
        }
        newRecord.isNew = true;
        // If transactions are not supported, proceed to Strategy B below
      }
    }

    // -------------------------------------------------------------------------
    // Strategy B: Persist candidate first, then atomically claim and link the old token.
    // The ordering serializes session-wide replay revocation with concurrent rotations.
    // -------------------------------------------------------------------------
    try {
      await newRecord.save();
    } catch (saveError: unknown) {
      try {
        await RefreshTokenModel.findByIdAndDelete(newRecord._id).exec();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [saveError, cleanupError],
          'Refresh token candidate persistence failed and cleanup could not be completed',
        );
      }
      throw saveError;
    }

    let tokenRecord: RefreshTokenDocument | null;
    try {
      tokenRecord = await RefreshTokenModel.findOneAndUpdate(
        {
          _id: new Types.ObjectId(tokenId),
          userId: new Types.ObjectId(userId),
          tokenHash: incomingHash,
          isRevoked: false,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            isRevoked: true,
            revokedAt: now,
            revocationReason: 'rotation',
            replacedByTokenHash: newRecord.tokenHash,
          },
        },
        { new: false },
      ).exec();
    } catch (claimError: unknown) {
      let currentRecord: RefreshTokenDocument | null;
      try {
        currentRecord = await RefreshTokenModel.findOne({
          _id: new Types.ObjectId(tokenId),
          userId: new Types.ObjectId(userId),
        }).exec();
      } catch (reconciliationError: unknown) {
        throw new AggregateError(
          [claimError, reconciliationError],
          'Refresh token claim failed and its persisted state could not be verified',
        );
      }

      if (
        currentRecord?.isRevoked &&
        currentRecord.revocationReason === 'rotation' &&
        currentRecord.replacedByTokenHash === newRecord.tokenHash
      ) {
        return { accessToken, refreshToken: newRefreshToken };
      }

      try {
        await RefreshTokenModel.findByIdAndDelete(newRecord._id).exec();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [claimError, cleanupError],
          'Refresh token claim failed and candidate cleanup could not be completed',
        );
      }

      if (currentRecord?.isRevoked) {
        return this.handleUnclaimedToken(tokenId, userId, incomingHash, now);
      }
      throw claimError;
    }

    if (!tokenRecord) {
      await RefreshTokenModel.findByIdAndDelete(newRecord._id).exec();
      return this.handleUnclaimedToken(tokenId, userId, incomingHash, now);
    }

    return { accessToken, refreshToken: newRefreshToken };
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

    await RefreshTokenModel.findOneAndUpdate(
      { _id: payload.tokenId, isRevoked: false },
      {
        $set: {
          isRevoked: true,
          revokedAt: new Date(),
          revocationReason: 'logout',
        },
      },
    ).exec();
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
