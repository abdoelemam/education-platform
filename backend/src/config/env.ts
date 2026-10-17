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
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters long'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters long'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().optional(),

  // ---------------------------------------------------------------------------
  // Video storage provider
  //
  // Video bytes are uploaded directly from the browser to the provider; the
  // API only issues short-lived signed upload instructions. Credentials are
  // optional at startup and the provider fails closed (HTTP 503) when missing.
  // ---------------------------------------------------------------------------
  VIDEO_PROVIDER: z.enum(['cloudinary', 'unconfigured']).default('unconfigured'),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  VIDEO_UPLOAD_FOLDER: z.string().default('education-platform/videos'),
  VIDEO_UPLOAD_AUTHORIZATION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
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
