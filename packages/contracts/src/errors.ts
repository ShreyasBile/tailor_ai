import { z } from 'zod';

/**
 * Closed error taxonomy.
 *
 * Free-text errors are why users see "something went wrong" and why we can't
 * alert on failure-mode shifts. Every failure maps to exactly one code here,
 * and every code carries a message written for a person holding a phone.
 */
export const ErrorCode = z.enum([
  // ── Input problems: the user can fix these, so say how ──
  'NO_PERSON_DETECTED',
  'MULTIPLE_PEOPLE',
  'INPUT_TOO_DARK',
  'INPUT_TOO_BLURRY',
  'PARTIAL_BODY',
  'INSUFFICIENT_COVERAGE',
  'INSUFFICIENT_FRAMES',
  'UNSUPPORTED_FORMAT',
  'FILE_TOO_LARGE',
  'VIDEO_TOO_LONG',
  'VIDEO_TOO_SHORT',
  'CORRUPT_MEDIA',
  'NUDITY_DETECTED',
  'SCAN_REJECTED',

  // ── Resolution problems ──
  'SCALE_UNRESOLVED',
  'HEIGHT_REQUIRED',

  // ── System problems: the user can only retry ──
  'GPU_OOM',
  'GPU_UNAVAILABLE',
  'INFERENCE_FAILED',
  'TEXTURE_BAKE_FAILED',
  'MESH_INVALID',
  'EXPORT_FAILED',
  'STORAGE_ERROR',
  'TIMEOUT',
  'INTERNAL_ERROR',

  // ── Access / policy ──
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CONSENT_REQUIRED',
  'AGE_RESTRICTED',
  'REGION_BLOCKED',
  'QUOTA_EXCEEDED',
  'RATE_LIMITED',
  'CONCURRENT_JOB_LIMIT',

  // ── Request problems ──
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'UPLOAD_INCOMPLETE',
  'CHECKSUM_MISMATCH',
  'SESSION_NOT_READY',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export interface ErrorSpec {
  status: number;
  /** Shown to the user. Plain language, actionable, no jargon, no model names. */
  message: string;
  /** Whether retrying the same input could plausibly succeed. */
  retryable: boolean;
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorSpec> = {
  NO_PERSON_DETECTED: {
    status: 422,
    message: "We couldn't find a person in your photos. Make sure your full body is visible.",
    retryable: false,
  },
  MULTIPLE_PEOPLE: {
    status: 422,
    message: 'We spotted more than one person. Try again with just you in the frame.',
    retryable: false,
  },
  INPUT_TOO_DARK: {
    status: 422,
    message: 'It was too dark to see clearly. Try again somewhere brighter, like near a window.',
    retryable: false,
  },
  INPUT_TOO_BLURRY: {
    status: 422,
    message: 'The photos came out blurry. Hold the phone steady, or prop it against something.',
    retryable: false,
  },
  PARTIAL_BODY: {
    status: 422,
    message: 'Part of your body was cut off. Step back so your head and feet are both in frame.',
    retryable: false,
  },
  INSUFFICIENT_COVERAGE: {
    status: 422,
    message: "We didn't get all the way around you. Try a slower, full turn.",
    retryable: false,
  },
  INSUFFICIENT_FRAMES: {
    status: 422,
    message: "There weren't enough usable shots. Try recording again with steadier movement.",
    retryable: false,
  },
  UNSUPPORTED_FORMAT: {
    status: 415,
    message: "That file type isn't supported. Please use a photo or video from your camera.",
    retryable: false,
  },
  SCAN_REJECTED: {
    status: 422,
    message: 'Some of your photos need retaking. Check the note on each photo, then scan again.',
    retryable: false,
  },
  FILE_TOO_LARGE: { status: 413, message: 'That file is too large. Try a shorter video.', retryable: false },
  VIDEO_TOO_LONG: {
    status: 422,
    message: 'That video is too long. Around 20 to 30 seconds works best.',
    retryable: false,
  },
  VIDEO_TOO_SHORT: {
    status: 422,
    message: 'That video is too short for a full turn. Aim for about 20 to 30 seconds.',
    retryable: false,
  },
  CORRUPT_MEDIA: { status: 422, message: "We couldn't read that file. Try recording again.", retryable: false },
  NUDITY_DETECTED: {
    status: 422,
    message:
      'Please wear fitted clothing, like leggings and a t-shirt. It works well and keeps things comfortable.',
    retryable: false,
  },

  SCALE_UNRESOLVED: {
    status: 422,
    message: "We couldn't work out your real-world size. Adding your height in settings fixes this.",
    retryable: false,
  },
  HEIGHT_REQUIRED: {
    status: 400,
    message: 'We need your height to size your model accurately. You can add it in settings.',
    retryable: false,
  },

  GPU_OOM: { status: 503, message: 'We ran out of capacity. Please try again in a moment.', retryable: true },
  GPU_UNAVAILABLE: { status: 503, message: 'Our processing service is busy. Please try again shortly.', retryable: true },
  INFERENCE_FAILED: { status: 500, message: "Something went wrong building your model. We're looking into it.", retryable: true },
  TEXTURE_BAKE_FAILED: { status: 500, message: "We built your shape but couldn't finish the colour.", retryable: true },
  MESH_INVALID: { status: 500, message: 'The model came out malformed. Please try another capture.', retryable: true },
  EXPORT_FAILED: { status: 500, message: "We couldn't prepare your download. Please try again.", retryable: true },
  STORAGE_ERROR: { status: 503, message: "We couldn't save your files. Please try again.", retryable: true },
  TIMEOUT: { status: 504, message: 'That took longer than expected. Please try again.', retryable: true },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong on our side.', retryable: true },

  UNAUTHENTICATED: { status: 401, message: 'Please sign in to continue.', retryable: false },
  FORBIDDEN: { status: 403, message: "You don't have access to that.", retryable: false },
  CONSENT_REQUIRED: {
    status: 403,
    message: 'We need your permission to process body scans before we can continue.',
    retryable: false,
  },
  AGE_RESTRICTED: { status: 403, message: 'You must be 18 or over to use TailorAI.', retryable: false },
  REGION_BLOCKED: { status: 403, message: "TailorAI isn't available in your region yet.", retryable: false },
  QUOTA_EXCEEDED: { status: 429, message: "You've reached your scan limit for today.", retryable: false },
  RATE_LIMITED: { status: 429, message: "You're going a bit fast. Please wait a moment.", retryable: true },
  CONCURRENT_JOB_LIMIT: {
    status: 429,
    message: 'You already have a scan in progress. Let that finish first.',
    retryable: true,
  },

  NOT_FOUND: { status: 404, message: "We couldn't find that.", retryable: false },
  VALIDATION_FAILED: { status: 400, message: "That request wasn't valid.", retryable: false },
  CONFLICT: { status: 409, message: 'That conflicts with something that already exists.', retryable: false },
  UPLOAD_INCOMPLETE: { status: 400, message: 'The upload finished incompletely. Please try again.', retryable: true },
  CHECKSUM_MISMATCH: { status: 400, message: 'The upload arrived corrupted. Please try again.', retryable: true },
  SESSION_NOT_READY: { status: 409, message: 'Your upload is still finishing.', retryable: true },
};

/** RFC 9457 Problem Details, plus a machine-branchable `code`. */
export const ProblemDetails = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int(),
  code: ErrorCode,
  detail: z.string(),
  instance: z.string().optional(),
  retryable: z.boolean(),
  /** Field-level issues, populated for VALIDATION_FAILED. */
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

const ERROR_BASE_URL = 'https://api.tailorai.app/errors';

function toKebab(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

export function buildProblem(
  code: ErrorCode,
  opts: { instance?: string; detail?: string; errors?: ProblemDetails['errors'] } = {},
): ProblemDetails {
  const spec = ERROR_CATALOG[code];
  return {
    type: `${ERROR_BASE_URL}/${toKebab(code)}`,
    title: code
      .split('_')
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' '),
    status: spec.status,
    code,
    detail: opts.detail ?? spec.message,
    ...(opts.instance ? { instance: opts.instance } : {}),
    retryable: spec.retryable,
    ...(opts.errors ? { errors: opts.errors } : {}),
  };
}

/** Application error carrying a taxonomy code. Thrown everywhere; mapped to HTTP once. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    /** Internal context for logs. Never sent to the client. */
    readonly context?: Record<string, unknown>,
    detail?: string,
  ) {
    super(detail ?? ERROR_CATALOG[code].message);
    this.name = 'AppError';
  }

  get status(): number {
    return ERROR_CATALOG[this.code].status;
  }

  get retryable(): boolean {
    return ERROR_CATALOG[this.code].retryable;
  }

  toProblem(instance?: string): ProblemDetails {
    return buildProblem(this.code, { instance, detail: this.message });
  }
}
