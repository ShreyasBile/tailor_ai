import { z } from 'zod';
import { ScaleSource } from './enums.js';

/**
 * Internal contract: orchestrator → reconstruction (GPU) service.
 *
 * Deliberately narrow. The GPU service receives signed URLs and returns refs —
 * never blobs, never DB access, never auth context. That is what lets it move
 * from this laptop to a rented RunPod GPU by changing one URL (docs/02 §1).
 *
 * Not exposed publicly. Versioned separately from the public API.
 */

export const PreparedFrame = z.object({
  index: z.number().int().min(0),
  /** Presigned GET for the RGB frame. */
  imageUrl: z.string().url(),
  /** Presigned GET for the alpha matte, if segmentation has run. */
  maskUrl: z.string().url().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** 0..1 from S3 frame selection; used to weight texture contributions. */
  qualityScore: z.number().min(0).max(1).optional(),
});
export type PreparedFrame = z.infer<typeof PreparedFrame>;

// ── POST /infer/segment ──

export const SegmentRequest = z.object({
  jobId: z.string(),
  frames: z.array(PreparedFrame).min(1),
  /** Presigned PUT targets, one per frame, in order. */
  outputUrls: z.array(z.string().url()).min(1),
});
export type SegmentRequest = z.infer<typeof SegmentRequest>;

export const SegmentResponse = z.object({
  masks: z.array(
    z.object({
      index: z.number().int(),
      /** Fraction of pixels classified as person. Near-zero ⇒ NO_PERSON_DETECTED. */
      foregroundRatio: z.number().min(0).max(1),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
    }),
  ),
  personCount: z.number().int().min(0),
  elapsedMs: z.number().int(),
});
export type SegmentResponse = z.infer<typeof SegmentResponse>;

// ── POST /infer/body ──

export const CameraParams = z.object({
  /** Focal length in pixels. */
  focal: z.number(),
  principalPoint: z.tuple([z.number(), z.number()]),
  /** Camera→world rotation as a quaternion (x, y, z, w). */
  rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  translation: z.tuple([z.number(), z.number(), z.number()]),
  /** Estimated yaw of the subject relative to camera, degrees. Drives coverage. */
  subjectYawDeg: z.number().nullable(),
});
export type CameraParams = z.infer<typeof CameraParams>;

export const PerFrameEstimate = z.object({
  index: z.number().int(),
  /** MHR shape coefficients (45). */
  shape: z.array(z.number()),
  /** Axis-angle pose, 3 per joint. Nuisance parameter for us — never fused. */
  pose: z.array(z.number()),
  camera: CameraParams,
  /** Model's own confidence, if it reports one. */
  score: z.number().min(0).max(1).nullable(),
});
export type PerFrameEstimate = z.infer<typeof PerFrameEstimate>;

export const BodyInferRequest = z.object({
  jobId: z.string(),
  frames: z.array(PreparedFrame).min(1),
});
export type BodyInferRequest = z.infer<typeof BodyInferRequest>;

export const BodyInferResponse = z.object({
  adapterId: z.string(),
  bodyModel: z.string(),
  bodyModelVersion: z.string(),
  perFrame: z.array(PerFrameEstimate),
  elapsedMs: z.number().int(),
});
export type BodyInferResponse = z.infer<typeof BodyInferResponse>;

// ── POST /infer/fuse ──

export const FuseRequest = z.object({
  jobId: z.string(),
  perFrame: z.array(PerFrameEstimate).min(1),
  /** Anchors metric scale. Absent ⇒ falls back down the ladder (docs/01 §S7). */
  userHeightCm: z.number().nullable(),
  sexAtBirth: z.enum(['FEMALE', 'MALE', 'UNSPECIFIED']).nullable(),
});
export type FuseRequest = z.infer<typeof FuseRequest>;

export const FuseResponse = z.object({
  /** Robust-averaged shape coefficients. */
  shape: z.array(z.number()),
  /** Per-coefficient inter-frame variance, normalised to 0..1 confidence. */
  shapeConfidence: z.array(z.number()),
  /** Frames the Huber refit down-weighted as outliers. */
  outlierFrames: z.array(z.number().int()),
  scale: z.object({
    source: ScaleSource,
    heightCm: z.number().nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    /** Multiplier applied to the canonical mesh to reach metric size. */
    metricScale: z.number().positive(),
  }),
  /** Total yaw span observed across frames. Low ⇒ INSUFFICIENT_COVERAGE. */
  coverageDegrees: z.number().min(0).max(360),
  overallQuality: z.number().min(0).max(1),
  elapsedMs: z.number().int(),
});
export type FuseResponse = z.infer<typeof FuseResponse>;

// ── POST /infer/texture ──

export const TextureRequest = z.object({
  jobId: z.string(),
  /** Presigned GET for the posed, metric-scaled mesh (GLB). */
  meshUrl: z.string().url(),
  frames: z.array(PreparedFrame).min(1),
  cameras: z.array(CameraParams).min(1),
  resolution: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).default(2048),
  /** Presigned PUT for the resulting atlas (PNG/KTX2). */
  outputUrl: z.string().url(),
});
export type TextureRequest = z.infer<typeof TextureRequest>;

export const TextureResponse = z.object({
  resolution: z.number().int(),
  coverage: z.object({
    front: z.number(),
    back: z.number(),
    left: z.number(),
    right: z.number(),
    inpaintedFraction: z.number(),
  }),
  elapsedMs: z.number().int(),
});
export type TextureResponse = z.infer<typeof TextureResponse>;

// ── GET /health ──

export const ReconHealth = z.object({
  ready: z.boolean(),
  device: z.string(),
  gpuName: z.string().nullable(),
  vramTotalMb: z.number().int().nullable(),
  vramFreeMb: z.number().int().nullable(),
  loadedModels: z.array(z.string()),
  adapters: z.object({ body: z.string(), segmentation: z.string() }),
  modelTier: z.string(),
});
export type ReconHealth = z.infer<typeof ReconHealth>;
