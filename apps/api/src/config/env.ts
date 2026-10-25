import { z } from 'zod';

/**
 * Environment is validated once, at boot, and fails loudly.
 *
 * A service that starts with a missing S3 bucket and discovers it on the first
 * upload is a service that fails in front of a user instead of in CI.
 */
const bool = z
  .string()
  .transform((v) => v === 'true' || v === '1')
  .pipe(z.boolean());

const csv = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.string()));

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  API_PORT: z.coerce.number().int().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: csv.default('http://localhost:8081'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  STORAGE_DRIVER: z.enum(['s3']).default('s3'),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default('true'),
  UPLOAD_URL_TTL: z.coerce.number().int().default(3600),
  DOWNLOAD_URL_TTL: z.coerce.number().int().default(300),

  AUTH_PROVIDER: z.enum(['local', 'clerk', 'supabase']).default('local'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.coerce.number().int().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().default(2592000),

  RECONSTRUCTION_URL: z.string().url(),
  RECONSTRUCTION_TIMEOUT_MS: z.coerce.number().int().default(600_000),
  RECONSTRUCTION_API_KEY: z.string().min(1),

  MODEL_TIER: z.enum(['production', 'research']).default('production'),
  RECONSTRUCTION_ADAPTER: z.string().default('mock'),
  SEGMENTATION_ADAPTER: z.string().default('mock'),

  MAX_VIDEO_DURATION_S: z.coerce.number().int().default(60),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(209_715_200),
  TARGET_FRAME_COUNT: z.coerce.number().int().default(16),

  RAW_MEDIA_TTL_DAYS: z.coerce.number().int().default(30),
  INTERMEDIATE_TTL_DAYS: z.coerce.number().int().default(7),

  MAX_CONCURRENT_JOBS_PER_USER: z.coerce.number().int().default(1),
  MAX_JOBS_PER_DAY_PER_USER: z.coerce.number().int().default(10),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().default(120),

  // Catalogue admins (comma-separated emails). Empty in local development
  // means every signed-in user may add outfits; never in production.
  ADMIN_EMAILS: csv.default(''),
  // Only its presence is read here: the reconstruction service makes the calls.
  GEMINI_API_KEY: z.string().optional(),
  // Where the web app serves static files (product photos under /garments),
  // for the reconstruction service to fetch them.
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3001'),

  // Compliance — see docs/06 §6. Defaults are the safe ones.
  BLOCKED_REGIONS: csv.default('US-IL'),
  MIN_AGE_YEARS: z.coerce.number().int().default(18),
  REQUIRE_BIOMETRIC_CONSENT: bool.default('true'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n`);
  }

  // A production build must never run research-tier models — the licence gate
  // covers the build, this covers a mis-set runtime env.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.MODEL_TIER === 'research') {
    throw new Error(
      'MODEL_TIER=research is forbidden when NODE_ENV=production. ' +
        'Research-tier models are not cleared for commercial use (docs/00 ADR-2).',
    );
  }

  if (parsed.data.NODE_ENV === 'production' && parsed.data.JWT_SECRET.includes('change_me')) {
    throw new Error('JWT_SECRET is still the example value. Set a real secret.');
  }

  cached = parsed.data;
  return cached;
}

export const ENV = 'ENV_TOKEN';
