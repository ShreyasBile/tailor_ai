import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  RECONSTRUCTION_URL: z.string().url(),
  RECONSTRUCTION_TIMEOUT_MS: z.coerce.number().int().default(600_000),
  RECONSTRUCTION_API_KEY: z.string().min(1),

  MODEL_TIER: z.enum(['production', 'research']).default('production'),
  TARGET_FRAME_COUNT: z.coerce.number().int().default(16),
  FRAME_SAMPLE_FPS: z.coerce.number().default(4),
  TEXTURE_RESOLUTION: z.coerce.number().int().default(2048),
  MAX_VIDEO_DURATION_S: z.coerce.number().int().default(60),
  INTERMEDIATE_TTL_DAYS: z.coerce.number().int().default(7),

  /** How many reconstructions this worker runs at once. */
  WORKER_CONCURRENCY: z.coerce.number().int().default(1),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid orchestrator environment:\n` +
        parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
  }
  cached = parsed.data;
  return cached;
}
