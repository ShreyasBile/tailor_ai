import type { PrismaClient } from '@prisma/client';
import type { CaptureMode, ScaleSource, ScanReport, StageName } from '@tailorai/contracts';
import type { Storage } from '../clients/storage';
import type { GpuClient } from '../clients/gpu';
import type { EventPublisher } from '../events';
import type { Logger } from '../logger';

/**
 * State threaded through the pipeline.
 *
 * Persisted to object storage after every stage, which is what makes
 * retry-resume possible: a job that fails at S10 restarts at S10 with S1–S9's
 * output intact, rather than redoing three minutes of work.
 */
export interface PipelineState {
  mode: CaptureMode;
  userHeightCm: number | null;
  sexAtBirth: 'FEMALE' | 'MALE' | 'UNSPECIFIED' | null;

  /** S1/S2 */
  sourceAssetIds: string[];
  extractedFrames: Array<{ index: number; key: string; width: number; height: number }>;

  /** S3 */
  selectedFrames: Array<{ index: number; key: string; qualityScore: number }>;

  /** S4 */
  maskKeys: Record<number, string>;

  /** S5 */
  perFrame: Array<{
    index: number;
    shape: number[];
    pose: number[];
    camera: {
      focal: number;
      principalPoint: [number, number];
      rotation: [number, number, number, number];
      translation: [number, number, number];
      subjectYawDeg: number | null;
    };
    score: number | null;
  }>;
  bodyModel: string;
  bodyModelVersion: string;
  adapterId: string;

  /** S6/S7 */
  shape: number[];
  shapeConfidence: number[];
  scale: {
    source: ScaleSource;
    heightCm: number | null;
    confidence: number | null;
    metricScale: number;
  } | null;
  coverageDegrees: number;
  overallQuality: number;

  /** S9/S10 */
  textureKey: string | null;
  coverage: {
    front: number;
    back: number;
    left: number;
    right: number;
    inpaintedFraction: number;
  } | null;
  /** True when texturing degraded — the mesh ships untextured rather than not at all. */
  textureDegraded: boolean;

  /** S11/S12 */
  glbKey: string | null;
  objKey: string | null;
  thumbnailKey: string | null;
  vertexCount: number;
  triangleCount: number;

  /** Per-stage timings. Turns the estimates in docs/06 §2 into measurements. */
  timings: Record<string, number>;

  /** Four-view scan: view → source asset id. Null for every other capture. */
  scanViews: Partial<Record<'front' | 'back' | 'left' | 'right', string>> | null;
  /** Four-view scan result (accepted scans only). */
  scan: ScanReport | null;
}

export function initialState(mode: CaptureMode): PipelineState {
  return {
    mode,
    userHeightCm: null,
    sexAtBirth: null,
    sourceAssetIds: [],
    extractedFrames: [],
    selectedFrames: [],
    maskKeys: {},
    perFrame: [],
    bodyModel: 'MHR',
    bodyModelVersion: '1.0',
    adapterId: 'unknown',
    shape: [],
    shapeConfidence: [],
    scale: null,
    coverageDegrees: 0,
    overallQuality: 0,
    textureKey: null,
    coverage: null,
    textureDegraded: false,
    glbKey: null,
    objKey: null,
    thumbnailKey: null,
    vertexCount: 0,
    triangleCount: 0,
    timings: {},
    scanViews: null,
    scan: null,
  };
}

export interface StageContext {
  jobId: string;
  userId: string;
  sessionId: string;
  options: { quality: 'fast' | 'standard' | 'high'; textured: boolean };
  state: PipelineState;
  prisma: PrismaClient;
  storage: Storage;
  gpu: GpuClient;
  events: EventPublisher;
  log: Logger;
  attempt: number;
}

/**
 * Retry policy is per-stage because the failure modes genuinely differ.
 * Retrying a corrupt video identically five times is just five failures.
 */
export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
  /** Codes that make retrying pointless — fail immediately. */
  nonRetryableCodes: string[];
}

export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  backoffMs: () => 0,
  nonRetryableCodes: [],
};

export const TRANSIENT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  backoffMs: (n) => Math.min(30_000, 1000 * 2 ** n),
  nonRetryableCodes: [
    'NO_PERSON_DETECTED',
    'MULTIPLE_PEOPLE',
    'INPUT_TOO_DARK',
    'INPUT_TOO_BLURRY',
    'PARTIAL_BODY',
    'INSUFFICIENT_FRAMES',
    'INSUFFICIENT_COVERAGE',
    'CORRUPT_MEDIA',
    'NUDITY_DETECTED',
    'UNSUPPORTED_FORMAT',
    'SCAN_REJECTED',
    'HEIGHT_REQUIRED',
  ],
};

/** CUDA OOM: one retry (the service reduces batch size), then give up. */
export const OOM_RETRY: RetryPolicy = {
  maxAttempts: 2,
  backoffMs: () => 2000,
  nonRetryableCodes: TRANSIENT_RETRY.nonRetryableCodes,
};

export interface Stage {
  name: StageName;
  run(ctx: StageContext): Promise<void>;
  retry: RetryPolicy;
  /**
   * Optional stages record DEGRADED and continue instead of failing the job.
   * A grey untextured avatar beats no avatar.
   */
  optional?: boolean;
  /** Skip conditions evaluated at runtime (e.g. photo mode skips extraction). */
  skipIf?: (ctx: StageContext) => boolean;
}
