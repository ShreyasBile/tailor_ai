import { z } from 'zod';
import {
  AssetKind,
  BodyModelKind,
  CaptureMode,
  ConsentKind,
  ExportFormat,
  JobStatus,
  ScaleSource,
  SessionStatus,
  SexAtBirth,
  StageName,
  StageStatus,
} from './enums.js';

// ─────────────────────────── Primitives ───────────────────────────

export const Uuid = z.string().uuid();
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase hex sha256');
export const IsoDateTime = z.string().datetime();

export const SignedUrl = z.object({
  url: z.string().url(),
  expiresAt: IsoDateTime,
});
export type SignedUrl = z.infer<typeof SignedUrl>;

export function Paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;

// ─────────────────────────── Users & consent ───────────────────────────

/**
 * Height is the primary anchor for metric scale (docs/01 §S7). Monocular
 * reconstruction cannot recover absolute size from pixels — this one number
 * does more for accuracy than any model upgrade.
 */
export const UserProfile = z.object({
  id: Uuid,
  email: z.string().email().nullable(),
  displayName: z.string().nullable(),
  heightCm: z.number().min(50).max(260).nullable(),
  weightKg: z.number().min(20).max(400).nullable(),
  birthYear: z.number().int().min(1900).max(2100).nullable(),
  sexAtBirth: SexAtBirth.nullable(),
  dataRegion: z.string(),
  createdAt: IsoDateTime,
});
export type UserProfile = z.infer<typeof UserProfile>;

export const UpdateProfileRequest = z
  .object({
    displayName: z.string().min(1).max(80),
    heightCm: z.number().min(50).max(260),
    weightKg: z.number().min(20).max(400),
    birthYear: z.number().int().min(1900).max(new Date().getFullYear()),
    sexAtBirth: SexAtBirth,
  })
  .partial();
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

export const Consent = z.object({
  kind: ConsentKind,
  version: z.string(),
  granted: z.boolean(),
  grantedAt: IsoDateTime,
  revokedAt: IsoDateTime.nullable(),
});
export type Consent = z.infer<typeof Consent>;

export const GrantConsentRequest = z.object({
  kind: ConsentKind,
  version: z.string().min(1),
  granted: z.boolean(),
});
export type GrantConsentRequest = z.infer<typeof GrantConsentRequest>;

// ─────────────────────────── Auth ───────────────────────────

export const SessionRequest = z.object({
  /** Provider token (Clerk/Supabase), or email for the local dev provider. */
  token: z.string().min(1),
});
export type SessionRequest = z.infer<typeof SessionRequest>;

export const SessionResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
  user: UserProfile,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const RefreshRequest = z.object({ refreshToken: z.string().min(1) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

// ─────────────────────────── Capture sessions ───────────────────────────

/**
 * Client-side capture telemetry. Not used for reconstruction — used to explain
 * a bad reconstruction after the fact, which is otherwise nearly impossible.
 */
export const QualityHints = z
  .object({
    lighting: z.number().min(0).max(1).optional(),
    meanSharpness: z.number().min(0).optional(),
    coverageDegrees: z.number().min(0).max(360).optional(),
    rejectedFrames: z.number().int().min(0).optional(),
    poseScores: z.array(z.number().min(0).max(1)).optional(),
  })
  .partial();
export type QualityHints = z.infer<typeof QualityHints>;

export const CreateSessionRequest = z.object({
  mode: CaptureMode,
  deviceModel: z.string().max(120).optional(),
  osVersion: z.string().max(60).optional(),
  qualityHints: QualityHints.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const CaptureSession = z.object({
  id: Uuid,
  mode: CaptureMode,
  status: SessionStatus,
  assetCount: z.number().int(),
  createdAt: IsoDateTime,
  /** Returned at creation so the client can state the retention promise plainly. */
  purgeAfter: IsoDateTime,
});
export type CaptureSession = z.infer<typeof CaptureSession>;

// ─────────────────────────── Uploads ───────────────────────────

export const CreateUploadRequest = z.object({
  kind: AssetKind,
  fileName: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  mimeType: z.string().min(1).max(120),
  /**
   * Client-supplied content fingerprint, used for deduplication and to key an
   * interrupted upload for resume.
   *
   * NOT an integrity control and deliberately not named `sha256`: hashing a
   * 60 MB file on the device's JS thread would block the UI for seconds.
   * Real integrity is enforced server-side on completion — byte-length check
   * plus magic-byte sniffing of the assembled object — and by S3's own
   * per-part checksums during transfer.
   */
  clientFingerprint: z.string().min(16).max(128),
  /**
   * True when the media is horizontally mirrored, as front-camera capture is.
   *
   * The pipeline flips it back before inference. Left uncorrected, a mirrored
   * body reconstructs laterally inverted — left-shoulder measurements land on
   * the right side — and it looks entirely plausible, so nothing downstream
   * would catch it.
   *
   * Stills are un-mirrored on-device at capture; this flag exists mainly for
   * video, which cannot be flipped there without re-encoding.
   */
  mirrored: z.boolean().default(false),
  partSizeBytes: z
    .number()
    .int()
    .min(5 * 1024 * 1024, 'S3 requires parts of at least 5 MiB')
    .default(8 * 1024 * 1024),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export const UploadPart = z.object({
  partNumber: z.number().int().min(1).max(10000),
  url: z.string().url(),
  expiresAt: IsoDateTime,
});
export type UploadPart = z.infer<typeof UploadPart>;

export const CreateUploadResponse = z.object({
  uploadId: Uuid,
  storageKey: z.string(),
  parts: z.array(UploadPart),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponse>;

/** Drives resume: the client asks what landed and re-sends only the gaps. */
export const UploadStatus = z.object({
  uploadId: Uuid,
  kind: AssetKind,
  sizeBytes: z.number().int(),
  totalParts: z.number().int(),
  completedParts: z.array(z.number().int()),
  isComplete: z.boolean(),
  expiresAt: IsoDateTime,
});
export type UploadStatus = z.infer<typeof UploadStatus>;

export const CompleteUploadRequest = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) }))
    .min(1),
});
export type CompleteUploadRequest = z.infer<typeof CompleteUploadRequest>;

// ─────────────────────────── Jobs ───────────────────────────

export const JobOptions = z
  .object({
    quality: z.enum(['fast', 'standard', 'high']).default('standard'),
    textured: z.boolean().default(true),
  })
  .default({ quality: 'standard', textured: true });
export type JobOptions = z.infer<typeof JobOptions>;

export const CreateJobRequest = z.object({
  sessionId: Uuid,
  options: JobOptions.optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequest>;

export const JobStageView = z.object({
  name: StageName,
  sequence: z.number().int(),
  status: StageStatus,
  attempt: z.number().int(),
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  durationMs: z.number().int().nullable(),
  errorCode: z.string().nullable(),
});
export type JobStageView = z.infer<typeof JobStageView>;

export const Job = z.object({
  id: Uuid,
  sessionId: Uuid,
  status: JobStatus,
  progress: z.number().min(0).max(1),
  stages: z.array(JobStageView),
  pipelineVersion: z.string(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  queuedAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  estimatedSecondsRemaining: z.number().int().nullable(),
  result: z
    .object({ bodyCoreId: Uuid, renderId: Uuid })
    .nullable(),
});
export type Job = z.infer<typeof Job>;

export const CreateJobResponse = z.object({
  id: Uuid,
  status: JobStatus,
  estimatedSeconds: z.number().int(),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponse>;

// ─────────────────────────── Body Core (the permanent profile) ─────────────

export const ScaleInfo = z.object({
  source: ScaleSource,
  heightCm: z.number().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});
export type ScaleInfo = z.infer<typeof ScaleInfo>;

export const BodyQuality = z.object({
  overall: z.number().min(0).max(1).nullable(),
  frameCount: z.number().int(),
  captureMode: CaptureMode,
});
export type BodyQuality = z.infer<typeof BodyQuality>;

/**
 * The permanent Digital Body Profile. ~2 KB. Survives every renderer upgrade.
 *
 * `shapeParams` is omitted by default — the app doesn't need it to render, and
 * it is the most sensitive field we hold. Request `?include=params` for
 * export/portability flows only.
 */
export const BodyCore = z.object({
  id: Uuid,
  version: z.number().int(),
  isCurrent: z.boolean(),
  bodyModel: BodyModelKind,
  bodyModelVersion: z.string(),
  scale: ScaleInfo,
  quality: BodyQuality,
  createdAt: IsoDateTime,
  shapeParams: z.array(z.number()).optional(),
  /** Per-coefficient inter-frame variance. Uncertainty is part of the measurement. */
  shapeConfidence: z.array(z.number()).optional(),
});
export type BodyCore = z.infer<typeof BodyCore>;

// ─────────────────────────── Avatars & exports ───────────────────────────

export const MeshStats = z.object({
  vertexCount: z.number().int(),
  triangleCount: z.number().int(),
  textureRes: z.number().int().nullable(),
  fileSizeBytes: z.number().int(),
});
export type MeshStats = z.infer<typeof MeshStats>;

/**
 * Which surface regions were actually observed versus inpainted.
 * Surfaced in the viewer so invented geometry is never presented as fact.
 */
export const Coverage = z.object({
  front: z.number().min(0).max(1),
  back: z.number().min(0).max(1),
  left: z.number().min(0).max(1),
  right: z.number().min(0).max(1),
  inpaintedFraction: z.number().min(0).max(1),
});
export type Coverage = z.infer<typeof Coverage>;

export const AvatarRender = z.object({
  id: Uuid,
  bodyCoreId: Uuid,
  rendererVersion: z.string(),
  stats: MeshStats,
  isTextured: z.boolean(),
  isDegraded: z.boolean(),
  coverage: Coverage.nullable(),
  createdAt: IsoDateTime,
  assets: z.object({
    glb: SignedUrl.nullable(),
    thumbnail: SignedUrl.nullable(),
  }),
});
export type AvatarRender = z.infer<typeof AvatarRender>;

export const CreateExportRequest = z.object({ format: ExportFormat });
export type CreateExportRequest = z.infer<typeof CreateExportRequest>;

export const ExportRecord = z.object({
  id: Uuid,
  renderId: Uuid,
  format: ExportFormat,
  sizeBytes: z.number().int(),
  download: SignedUrl.nullable(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
});
export type ExportRecord = z.infer<typeof ExportRecord>;

// ─────────────────────────── SSE events ───────────────────────────

export const JobEvent = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('stage'),
    jobId: Uuid,
    stage: StageName,
    status: StageStatus,
    jobStatus: JobStatus,
    progress: z.number().min(0).max(1),
    at: IsoDateTime,
  }),
  z.object({
    event: z.literal('completed'),
    jobId: Uuid,
    bodyCoreId: Uuid,
    renderId: Uuid,
    at: IsoDateTime,
  }),
  z.object({
    event: z.literal('failed'),
    jobId: Uuid,
    errorCode: z.string(),
    errorMessage: z.string(),
    retryable: z.boolean(),
    at: IsoDateTime,
  }),
  z.object({ event: z.literal('cancelled'), jobId: Uuid, at: IsoDateTime }),
  /** Keeps intermediaries from closing an idle stream. */
  z.object({ event: z.literal('heartbeat'), at: IsoDateTime }),
]);
export type JobEvent = z.infer<typeof JobEvent>;
