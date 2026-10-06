import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/api-response.js';
import { getDatabaseStatus } from '../../database/index.js';

/**
 * Health check controller.
 *
 * Returns application and database health status.
 * Designed so additional health checks (Redis, external services) can be added later.
 */
class HealthController {
  check(_req: Request, res: Response): void {
    const dbStatus = getDatabaseStatus();

    const healthData = {
      status: dbStatus.connected ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        status: dbStatus.readyStateText,
        connected: dbStatus.connected,
      },
    };

    const statusCode = dbStatus.connected ? 200 : 503;

    sendSuccess(res, healthData, statusCode);
  }
}

export const healthController = new HealthController();
