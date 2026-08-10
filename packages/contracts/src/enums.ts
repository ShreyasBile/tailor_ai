import { z } from 'zod';

/** Capture input mode. Video yields materially better reconstructions. */
export const CaptureMode = z.enum(['VIDEO_360', 'PHOTO_SET']);
export type CaptureMode = z.infer<typeof CaptureMode>;

export const SessionStatus = z.enum([
  'UPLOADING',
  'READY',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'PURGED',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/**
 * Job status doubles as the pipeline state machine. Order matters — progress is
 * derived from position in this list weighted by STAGE_WEIGHTS.
 */
export const JobStatus = z.enum([
  'QUEUED',
  'VALIDATING',
  'EXTRACTING',
  'SELECTING',
  'SEGMENTING',
  'RECONSTRUCTING',
  'FUSING',
  'TEXTURING',
  'OPTIMISING',
  'EXPORTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** Pipeline stages. See docs/01 §3. */
export const StageName = z.enum([
  'S1_VALIDATE',
  'S2_EXTRACT',
  'S3_SELECT',
  'S4_SEGMENT',
  'S5_BODY_INFERENCE',
  'S6_FUSE',
  'S7_SCALE',
  'S8_RETARGET',
  'S9_UNWRAP',
  'S10_TEXTURE_BAKE',
  'S11_OPTIMISE',
  'S12_EXPORT',
]);
export type StageName = z.infer<typeof StageName>;

/**
 * Relative cost of each stage, used to compute honest progress.
 * Sums to 1.0. Derived from the estimates in docs/06 §2 and MUST be
 * re-derived from real telemetry once M3 produces measurements.
 */
export const STAGE_WEIGHTS: Record<StageName, number> = {
  S1_VALIDATE: 0.02,
  S2_EXTRACT: 0.08,
  S3_SELECT: 0.05,
  S4_SEGMENT: 0.08,
  S5_BODY_INFERENCE: 0.25,
  S6_FUSE: 0.02,
  S7_SCALE: 0.01,
  S8_RETARGET: 0.02,
  S9_UNWRAP: 0.02,
  S10_TEXTURE_BAKE: 0.28,
  S11_OPTIMISE: 0.09,
  S12_EXPORT: 0.08,
};

/** Ordered execution sequence. */
export const STAGE_ORDER: readonly StageName[] = [
  'S1_VALIDATE',
  'S2_EXTRACT',
  'S3_SELECT',
  'S4_SEGMENT',
  'S5_BODY_INFERENCE',
  'S6_FUSE',
  'S7_SCALE',
  'S8_RETARGET',
  'S9_UNWRAP',
  'S10_TEXTURE_BAKE',
  'S11_OPTIMISE',
  'S12_EXPORT',
];

/** Which job status a stage reports while running. */
export const STAGE_TO_STATUS: Record<StageName, JobStatus> = {
  S1_VALIDATE: 'VALIDATING',
  S2_EXTRACT: 'EXTRACTING',
  S3_SELECT: 'SELECTING',
  S4_SEGMENT: 'SEGMENTING',
  S5_BODY_INFERENCE: 'RECONSTRUCTING',
  S6_FUSE: 'FUSING',
  S7_SCALE: 'FUSING',
  S8_RETARGET: 'FUSING',
  S9_UNWRAP: 'TEXTURING',
  S10_TEXTURE_BAKE: 'TEXTURING',
  S11_OPTIMISE: 'OPTIMISING',
  S12_EXPORT: 'EXPORTING',
};

export const StageStatus = z.enum([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  /** Completed with reduced output — e.g. texture bake failed, mesh is untextured. */
  'DEGRADED',
]);
export type StageStatus = z.infer<typeof StageStatus>;

export const AssetKind = z.enum([
  'RAW_VIDEO',
  'RAW_PHOTO',
  'EXTRACTED_FRAME',
  'MASK',
  'PREPARED_FRAME',
  'MESH_GLB',
  'MESH_OBJ',
  'TEXTURE_ATLAS',
  'THUMBNAIL',
  'METADATA_SIDECAR',
]);
export type AssetKind = z.infer<typeof AssetKind>;

export const BodyModelKind = z.enum(['MHR', 'ANNY']);
export type BodyModelKind = z.infer<typeof BodyModelKind>;

/**
 * How metric scale was resolved. Monocular reconstruction is scale-ambiguous;
 * this records which rung of the ladder (docs/01 §S7) actually resolved it, so
 * downstream consumers can judge trustworthiness rather than assuming it.
 */
export const ScaleSource = z.enum([
  'USER_HEIGHT',
  'ARKIT_DEPTH',
  'REFERENCE_OBJECT',
  'STATISTICAL_PRIOR',
]);
export type ScaleSource = z.infer<typeof ScaleSource>;

export const ExportFormat = z.enum(['GLB', 'OBJ_ZIP', 'USDZ', 'FBX']);
export type ExportFormat = z.infer<typeof ExportFormat>;

/** Formats actually implemented in v1. USDZ/FBX are reserved. */
export const SUPPORTED_EXPORT_FORMATS: readonly ExportFormat[] = ['GLB', 'OBJ_ZIP'];

export const ConsentKind = z.enum([
  /** Required. Without it, job creation is refused. */
  'BIOMETRIC_PROCESSING',
  /** Optional. Retain raw imagery past the default TTL. */
  'RAW_MEDIA_RETENTION',
  /** Optional. Use my captures to improve models. */
  'MODEL_IMPROVEMENT',
]);
export type ConsentKind = z.infer<typeof ConsentKind>;

export const SexAtBirth = z.enum(['FEMALE', 'MALE', 'UNSPECIFIED']);
export type SexAtBirth = z.infer<typeof SexAtBirth>;
