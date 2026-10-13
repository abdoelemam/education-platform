import mongoose, { Schema, type Document, type Types } from 'mongoose';

export interface IRefreshToken {
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  isRevoked: boolean;
  revokedAt?: Date;
  replacedByTokenHash?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefreshTokenDocument extends IRefreshToken, Document<Types.ObjectId> {
  _id: Types.ObjectId;
}

const refreshTokenSchema = new Schema<RefreshTokenDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 }, // MongoDB automatic TTL cleanup when expiresAt passes
    },
    isRevoked: {
      type: Boolean,
      default: false,
      index: true,
    },
    revokedAt: {
      type: Date,
      default: undefined,
    },
    replacedByTokenHash: {
      type: String,
      default: undefined,
    },
  },
  {
    timestamps: true,
  },
);

export const RefreshTokenModel = mongoose.model<RefreshTokenDocument>(
  'RefreshToken',
  refreshTokenSchema,
);
