import { createApp } from './app.js';
import { config } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './database/index.js';
import { logger } from './utils/logger.js';

/**
 * Start the application server.
 *
 * 1. Connect to MongoDB
 * 2. Create Express app
 * 3. Listen on configured port
 * 4. Register graceful shutdown handlers
 */
async function startServer(): Promise<void> {
  try {
    // Connect to database first
    await connectDatabase();

    // Create and start Express app
    const app = createApp();

    const server = app.listen(config.PORT, () => {
      logger.info(`🚀 Server running on port ${config.PORT}`, {
        environment: config.NODE_ENV,
        port: config.PORT,
      });
    });

    // ---------------------------------------------------------------------------
    // Graceful shutdown
    // ---------------------------------------------------------------------------
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received. Starting graceful shutdown...`);

      server.close(async () => {
        logger.info('HTTP server closed');
        await disconnectDatabase();
        logger.info('Graceful shutdown complete');
        process.exit(0);
      });

      // Force shutdown after timeout
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    logger.error('❌ Failed to start server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Handle unhandled rejections and uncaught exceptions
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    name: error.name,
    message: error.message,
  });
  process.exit(1);
});

startServer();
