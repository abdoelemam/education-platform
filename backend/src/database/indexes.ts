import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

/**
 * Minimal shape needed to initialize a Mongoose model's indexes.
 * Injected in tests so startup behavior can be verified without a database.
 */
export interface IndexInitializableModel {
  modelName?: string;
  init(): Promise<unknown>;
}

/**
 * Build every registered model's schema indexes and wait for completion.
 *
 * `Model.init()` only creates the indexes declared on the schema; it does not
 * drop or synchronize anything, so it is safe to run on every startup. Any
 * failure rejects this promise and must abort startup before the HTTP server
 * listens. This guarantees, in particular, that the unique
 * `(studentId, courseId)` enrollment index is in place before enrollment
 * traffic can arrive.
 */
export async function initializeModelIndexes(
  models: IndexInitializableModel[] = Object.values(mongoose.models),
): Promise<void> {
  if (models.length === 0) {
    logger.warn('No Mongoose models registered for index initialization');
    return;
  }

  await Promise.all(models.map((model) => model.init()));

  logger.info('Database indexes initialized', {
    modelCount: models.length,
    models: models.map((model) => model.modelName ?? 'unknown'),
  });
}
