import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Schema for validating and typing all environment configuration.
 * Validates required variables at startup to fail fast on misconfiguration.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'debug'])
    .default('info'),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    console.error('❌ Invalid environment configuration:\n' + formatted);
    process.exit(1);
  }

  return parsed.data;
}

export const config = loadConfig();

export type Config = z.infer<typeof envSchema>;
