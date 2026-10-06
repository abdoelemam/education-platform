import { config } from '../config/index.js';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Simple structured logger.
 *
 * Outputs JSON in production for log aggregation tooling.
 * Outputs human-readable text in development.
 *
 * Can be replaced with a full logging library (pino, winston) later
 * without changing the call-site API.
 */
class Logger {
  private level: number;
  private isProduction: boolean;

  constructor() {
    this.level = LOG_LEVELS[config.LOG_LEVEL];
    this.isProduction = config.NODE_ENV === 'production';
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (this.level >= LOG_LEVELS.error) {
      this.log('error', message, meta);
    }
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (this.level >= LOG_LEVELS.warn) {
      this.log('warn', message, meta);
    }
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.level >= LOG_LEVELS.info) {
      this.log('info', message, meta);
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.level >= LOG_LEVELS.debug) {
      this.log('debug', message, meta);
    }
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();

    if (this.isProduction) {
      // Structured JSON for production log aggregation
      const entry = {
        timestamp,
        level,
        message,
        ...(meta ? { meta } : {}),
      };
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      console[method](JSON.stringify(entry));
    } else {
      // Human-readable for development
      const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
      const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
      if (meta) {
        console[method](prefix, message, meta);
      } else {
        console[method](prefix, message);
      }
    }
  }
}

export const logger = new Logger();
