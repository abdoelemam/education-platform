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

function isTransientTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const mongoError = error as {
    code?: unknown;
    hasErrorLabel?: (label: string) => boolean;
  };
  return (
    mongoError.code === 112 ||
    mongoError.hasErrorLabel?.('TransientTransactionError') === true
  );
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
   *    - The replay decision is derived entirely from the authoritative state returned by the
   *      atomic increment of the replacement token's `predecessorReuseCount`. No separate
   *      "confirmed" verdict is persisted, so a tolerated attempt cannot poison the chain.
   *    - Confirmed Reuse:
   *      (a) Token rotated outside the grace window (> REFRESH_ROTATION_GRACE_PERIOD_MS).
   *      (b) Token whose replacement has already been consumed/rotated (chain advanced).
   *      (c) Repeated presentation of an already-rotated token (atomic replacement reuse count > 1).
   *      Action: Invalidate ALL sessions for the user to contain the breach.
   *    - Concurrent Sibling Request:
   *      (a) Token rotated within grace window (<= REFRESH_ROTATION_GRACE_PERIOD_MS).
   *      (b) Replacement has no verified rotation successor.
   *      (c) First re-presentation attempt on this token (atomic replacement reuse count == 1).
   *      Action: Reject safely with 401 without revoking the active session.
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

    if (existingRecord.revocationReason === 'security_replay') {
      return this.revokeActiveSessionsForReplay(existingRecord.userId, now);
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
      // Count the replay on the replacement itself. This atomic single-document
      // increment is the linearization point shared with rotation's conditional
      // claim of the same document, so the decision below is derived from the
      // authoritative post-update state rather than a stale read. Only the count
      // and timestamps are persisted; the confirmed/rejected verdict is not a
      // durable flag, so a tolerated attempt cannot poison a later rotation.
      const replacementDoc = await RefreshTokenModel.findOneAndUpdate(
        {
          tokenHash: existingRecord.replacedByTokenHash,
          userId: existingRecord.userId,
        },
        { $inc: { predecessorReuseCount: 1 } },
        { new: true },
      ).exec();

      if (!replacementDoc) {
        // The replacement document is unavailable (e.g. expired and removed by
        // TTL). Fall back to counting on the predecessor token itself.
        const fallbackRecord = await RefreshTokenModel.findByIdAndUpdate(
          existingRecord._id,
          { $inc: { reuseCount: 1 } },
          { new: true },
        ).exec();

        if (!fallbackRecord) {
          throw new AppError(
            401,
            AUTH_ERRORS.REFRESH_TOKEN_INVALID,
            'Refresh token is invalid, expired, or has already been used',
          );
        }

        const fallbackOutsideGrace =
          now.getTime() - (fallbackRecord.revokedAt?.getTime() ?? now.getTime()) >
          REFRESH_ROTATION_GRACE_PERIOD_MS;
        const fallbackRepeated = (fallbackRecord.reuseCount ?? 1) > 1;

        if (fallbackOutsideGrace || fallbackRepeated) {
          return this.revokeActiveSessionsForReplay(fallbackRecord.userId, now);
        }

        throw new AppError(
          401,
          AUTH_ERRORS.REFRESH_TOKEN_INVALID,
          'Refresh token was recently rotated. Please use the newly issued session.',
        );
      }

      // Grace is measured from when the predecessor was rotated. The
      // predecessor's revokedAt is set once at rotation and never mutated by
      // later logouts or replay revocation (both only touch active tokens), so
      // it is stable evidence rather than a stale read.
      const rotatedAt = existingRecord.revokedAt ?? replacementDoc.predecessorRotatedAt ?? now;
      const isOutsideGracePeriod =
        now.getTime() - rotatedAt.getTime() > REFRESH_ROTATION_GRACE_PERIOD_MS;
      const isRepeatedAttempt = (replacementDoc.predecessorReuseCount ?? 1) > 1;
      const replacementAlreadyConsumed =
        replacementDoc.isRevoked === true &&
        (replacementDoc.revocationReason === 'rotation' ||
          replacementDoc.revocationReason === 'security_replay' ||
          (!replacementDoc.revocationReason && Boolean(replacementDoc.replacedByTokenHash)));

      const isConfirmedReuse =
        isOutsideGracePeriod || isRepeatedAttempt || replacementAlreadyConsumed;

      if (isConfirmedReuse) {
        return this.revokeActiveSessionsForReplay(existingRecord.userId, now);
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

  private async revokeActiveSessionsForReplay(
    userId: Types.ObjectId,
    now: Date,
  ): Promise<never> {
    await RefreshTokenModel.updateMany(
      { userId, isRevoked: false },
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

  private async rejectUnclaimedRotationCandidate(params: {
    tokenId: string;
    userId: string;
    incomingHash: string;
    now: Date;
    candidateId: Types.ObjectId;
  }): Promise<never> {
    let rejection: unknown;
    try {
      await this.handleUnclaimedToken(
        params.tokenId,
        params.userId,
        params.incomingHash,
        params.now,
      );
    } catch (error: unknown) {
      rejection = error;
    }

    try {
      await RefreshTokenModel.findByIdAndDelete(params.candidateId).exec();
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [rejection, cleanupError],
        'Refresh token candidate cleanup failed after rotation was rejected',
      );
    }

    throw rejection;
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
    newRecord.predecessorReuseCount = 0;
    newRecord.predecessorRotatedAt = now;

    // -------------------------------------------------------------------------
    // Strategy A: Multi-document transaction (if supported by MongoDB cluster)
    // -------------------------------------------------------------------------
    if (isTransactionSupported()) {
      const outcome = await this.runTransactionalRotation({
        tokenId,
        userId,
        incomingHash,
        newRecord,
        now,
      });

      if (outcome === 'rotated') {
        return { accessToken, refreshToken: newRefreshToken };
      }

      if (outcome === 'unclaimed') {
        // The session is fully closed at this point, so an expected 401 from
        // replay evaluation is surfaced as-is and never mistaken for a
        // transaction failure or trigger a second session cleanup.
        return this.handleUnclaimedToken(tokenId, userId, incomingHash, now);
      }

      // outcome === 'unsupported': the cluster cannot run transactions.
      // Fall through to Strategy B below.
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

      if (this.isOwnRotationCommitted(currentRecord, newRecord.tokenHash)) {
        return { accessToken, refreshToken: newRefreshToken };
      }

      if (currentRecord?.isRevoked) {
        return this.rejectUnclaimedRotationCandidate({
          tokenId,
          userId,
          incomingHash,
          now,
          candidateId: newRecord._id,
        });
      }

      try {
        await RefreshTokenModel.findByIdAndDelete(newRecord._id).exec();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [claimError, cleanupError],
          'Refresh token claim failed and candidate cleanup could not be completed',
        );
      }
      throw claimError;
    }

    if (!tokenRecord) {
      return this.rejectUnclaimedRotationCandidate({
        tokenId,
        userId,
        incomingHash,
        now,
        candidateId: newRecord._id,
      });
    }

    return { accessToken, refreshToken: newRefreshToken };
  }

  /**
   * Attempts a single transactional rotation and always closes its session
   * exactly once before returning or throwing.
   *
   * Outcomes:
   * - `rotated`: this request's rotation is durably committed.
   * - `unclaimed`: the claim did not match; the old token must be evaluated by
   *   the replay policy after the session is closed.
   * - `unsupported`: the cluster cannot run multi-document transactions.
   *
   * Replay evaluation is deliberately NOT performed here. Doing it after the
   * session is closed keeps an expected 401 from being swallowed by the
   * transaction error handling and prevents duplicate cleanup.
   */
  private async runTransactionalRotation(params: {
    tokenId: string;
    userId: string;
    incomingHash: string;
    newRecord: RefreshTokenDocument;
    now: Date;
  }): Promise<'rotated' | 'unclaimed' | 'unsupported'> {
    const { tokenId, userId, incomingHash, newRecord, now } = params;
    let session: mongoose.ClientSession | null = null;
    let outcome: 'rotated' | 'unclaimed' | null = null;
    let operationError: unknown = null;

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
        outcome = 'unclaimed';
      } else {
        await session.commitTransaction();
        outcome = 'rotated';
      }
    } catch (err: unknown) {
      operationError = err;
    }

    // Close the session exactly once. Abort only when the transaction did not
    // reach a committed state, and never re-enter cleanup afterwards.
    const cleanupErrors = await this.closeTransactionSession(session, {
      abort: outcome !== 'rotated',
    });

    if (cleanupErrors.length > 0) {
      if (operationError !== null) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          'Refresh token transaction failed and cleanup could not be completed',
        );
      }
      throw new AggregateError(
        cleanupErrors,
        'Refresh token transaction closed but session cleanup could not be completed',
      );
    }

    if (operationError !== null) {
      if (this.isTransactionCapabilityError(operationError)) {
        newRecord.isNew = true;
        // Transactions are not supported; the caller falls back to Strategy B.
        return 'unsupported';
      }

      if (isTransientTransactionError(operationError)) {
        const currentRecord = await this.readTokenStateForReconciliation(
          tokenId,
          userId,
          operationError,
        );

        // Only this request's own candidate hash proves that this rotation
        // committed before the transient error. A revoked token alone is not
        // proof of replay.
        if (this.isOwnRotationCommitted(currentRecord, newRecord.tokenHash)) {
          return 'rotated';
        }

        // Revoked by another operation: defer to the replay policy instead of
        // guessing, and without touching any replay counter here.
        if (currentRecord?.isRevoked) {
          return 'unclaimed';
        }

        // Unresolved state: fail closed rather than report a false outcome.
        throw operationError;
      }

      throw operationError;
    }

    if (outcome === 'rotated') {
      return 'rotated';
    }

    if (outcome === 'unclaimed') {
      return 'unclaimed';
    }

    // Defensive: the attempt neither completed nor reported an error.
    throw new Error('Refresh token transaction produced no outcome');
  }

  /**
   * Closes a client session exactly once. Aborts the transaction only when
   * requested and still active. Never throws: cleanup failures are returned so
   * the caller can surface them without masking the original error.
   */
  private async closeTransactionSession(
    session: mongoose.ClientSession | null,
    options: { abort: boolean },
  ): Promise<unknown[]> {
    const cleanupErrors: unknown[] = [];

    if (!session) {
      return cleanupErrors;
    }

    if (options.abort) {
      try {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }
      } catch (cleanupError: unknown) {
        cleanupErrors.push(cleanupError);
      }
    }

    try {
      await session.endSession();
    } catch (cleanupError: unknown) {
      cleanupErrors.push(cleanupError);
    }

    return cleanupErrors;
  }

  /**
   * Re-reads the old token's persisted state to resolve a transient
   * transaction error. A read failure is surfaced rather than treated as an
   * unresolved state.
   */
  private async readTokenStateForReconciliation(
    tokenId: string,
    userId: string,
    cause: unknown,
  ): Promise<RefreshTokenDocument | null> {
    try {
      return await RefreshTokenModel.findOne({
        _id: new Types.ObjectId(tokenId),
        userId: new Types.ObjectId(userId),
      }).exec();
    } catch (reconciliationError: unknown) {
      throw new AggregateError(
        [cause, reconciliationError],
        'Refresh transaction conflicted and token state could not be verified',
      );
    }
  }

  /**
   * Proves that the rotation performed by the current request committed, by
   * matching the recorded successor hash against this request's candidate.
   */
  private isOwnRotationCommitted(
    record: RefreshTokenDocument | null,
    candidateTokenHash: string,
  ): boolean {
    return (
      record?.isRevoked === true &&
      record.revocationReason === 'rotation' &&
      record.replacedByTokenHash === candidateTokenHash
    );
  }

  private isTransactionCapabilityError(error: unknown): boolean {
    return (
      error instanceof Error &&
      error.message.includes('Transaction numbers are only allowed')
    );
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
