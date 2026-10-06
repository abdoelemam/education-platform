import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Connect to MongoDB.
 * Isolated from application startup so the app can handle connection failure gracefully.
 */
export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(config.MONGODB_URI);
    logger.info('✅ MongoDB connected successfully');
  } catch (error) {
    logger.error('❌ MongoDB connection failed', { error });
    throw error;
  }
}

/**
 * Disconnect from MongoDB.
 * Used during graceful shutdown.
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected');
  } catch (error) {
    logger.error('Error disconnecting from MongoDB', { error });
  }
}

/**
 * Get the current MongoDB connection state for health checks.
 */
export function getDatabaseStatus(): {
  connected: boolean;
  readyState: number;
  readyStateText: string;
} {
  const readyState = mongoose.connection.readyState;
  const stateMap: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  return {
    connected: readyState === 1,
    readyState,
    readyStateText: stateMap[readyState] ?? 'unknown',
  };
}
