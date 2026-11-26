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

/** How the user likes clothes to fit. Shifts every size recommendation. */
export const FitPreference = z.enum(['SNUG', 'REGULAR', 'LOOSE']);
export type FitPreference = z.infer<typeof FitPreference>;

/** Which of the four controlled photos an upload is. */
export const ScanView = z.enum(['front', 'back', 'left', 'right']);
export type ScanView = z.infer<typeof ScanView>;

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
  fitPreference: FitPreference,
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
    fitPreference: FitPreference,
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
  /** Four-view scan: which photo this is. Its presence selects the scan path. */
  view: ScanView.optional(),
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
  /** Four-view scan: per-view quality, issues and measurements. */
  scanReport: z.lazy(() => ScanReport).nullable().optional(),
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

// ─────────────────────────── Measurements (derived from BodyCore) ──────────

/** Where a measurement sits on the body, for the app's highlight overlay.
 * Fractions of stature from the ground (0=feet, 1=head). */
export const MeasurementRegion = z.object({
  value: z.number(),
  unit: z.literal('cm'),
  kind: z.enum(['girth', 'width', 'length']),
  y: z.number().nullable().optional(),
  y0: z.number().nullable().optional(),
  y1: z.number().nullable().optional(),
  side: z.enum(['torso', 'arm', 'leg', 'full']),
});
export type MeasurementRegion = z.infer<typeof MeasurementRegion>;

/**
 * The 14 anthropometric measurements for the current BodyCore, with the region
 * map that drives the highlight UI. `estimated` and `confidence` are always
 * present: a measurement is never shown to a user as a bare, authoritative
 * number — its uncertainty travels with it.
 */
export const MeasurementsResponse = z.object({
  bodyCoreId: Uuid,
  estimated: z.boolean(),
  confidence: z.number().min(0).max(1).nullable(),
  scaleSource: ScaleSource,
  heightCm: z.number().nullable(),
  measurements: z.record(z.string(), z.number().nullable()),
  regions: z.record(z.string(), MeasurementRegion),
  /** Four-view scans: the full record per measurement, in display order. */
  details: z.array(z.lazy(() => MeasurementDetail)).optional(),
  engineVersion: z.string().nullable().optional(),
});
export type MeasurementsResponse = z.infer<typeof MeasurementsResponse>;

// ─────────────────────────── Four-view scan ───────────────────────────

export const ScanIssue = z.object({
  view: ScanView,
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
});
export type ScanIssue = z.infer<typeof ScanIssue>;

export const ScanViewQuality = z.object({
  view: ScanView,
  ok: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(ScanIssue.omit({ view: true })),
  metrics: z.record(z.string(), z.unknown()),
});
export type ScanViewQuality = z.infer<typeof ScanViewQuality>;

export const MeasurementDetail = z.object({
  name: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.literal('cm'),
  confidence: z.number().min(0).max(1),
  method: z.string(),
  sources: z.array(z.string()),
  kind: z.enum(['girth', 'width', 'length']),
  region: z.record(z.string(), z.unknown()),
  typicalErrorCm: z.number().nullable(),
});
export type MeasurementDetail = z.infer<typeof MeasurementDetail>;

export const ScanReport = z.object({
  status: z.enum(['accepted', 'rejected']),
  engineVersion: z.string(),
  views: z.array(ScanViewQuality),
  issues: z.array(ScanIssue),
  measurements: z.array(MeasurementDetail),
  confidence: z.object({
    overall: z.number(),
    scanQuality: z.number().optional(),
    label: z.enum(['high', 'medium', 'low']).optional(),
  }),
  body: z
    .object({
      shape: z.array(z.number()),
      metricScale: z.number(),
      // Which body model `shape` parameterises. Absent on reports from before
      // the Anny body (those shapes are the parametric humanoid's).
      bodyModel: z.enum(['MHR', 'ANNY']).optional(),
      bodyModelVersion: z.string().optional(),
      residualCm: z.record(z.string(), z.number()),
      iterations: z.number().int(),
      elapsedMs: z.number().int(),
    })
    .nullable(),
  elapsedMs: z.number().int(),
});
export type ScanReport = z.infer<typeof ScanReport>;

// ─────────────────────────── Catalogue & fit ───────────────────────────

export const GarmentCategory = z.enum(['TOPS', 'OUTERWEAR', 'BOTTOMS', 'DRESSES']);
export type GarmentCategory = z.infer<typeof GarmentCategory>;

export const Brand = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  accentHex: z.string(),
});
export type Brand = z.infer<typeof Brand>;

export const GarmentSummary = z.object({
  id: Uuid,
  slug: z.string(),
  name: z.string(),
  brand: Brand,
  category: GarmentCategory,
  subcategory: z.string(),
  gender: z.string(),
  fitIntent: z.enum(['SLIM', 'REGULAR', 'RELAXED', 'OVERSIZED']),
  stretch: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']),
  material: z.string(),
  priceCents: z.number().int(),
  currency: z.string(),
  colorName: z.string(),
  colorHex: z.string(),
  /** Product photo URL (web path or absolute), or null for the drawn illustration. */
  imageUrl: z.string().nullable(),
});
export type GarmentSummary = z.infer<typeof GarmentSummary>;

export const SizeChartView = z.object({
  name: z.string(),
  dimensions: z.array(z.string()),
  sizes: z.array(
    z.object({
      label: z.string(),
      measurements: z.record(z.string(), z.tuple([z.number(), z.number()])),
    }),
  ),
});
export type SizeChartView = z.infer<typeof SizeChartView>;

export const GarmentDetail = GarmentSummary.extend({
  description: z.string(),
  sizeChart: SizeChartView,
});
export type GarmentDetail = z.infer<typeof GarmentDetail>;

export const RecommendRequest = z.object({
  /** Overrides the profile's fit preference for this one recommendation. */
  preference: FitPreference.optional(),
});
export type RecommendRequest = z.infer<typeof RecommendRequest>;

export const FitDimension = z.object({
  name: z.string(),
  label: z.string(),
  body: z.number(),
  range: z.tuple([z.number(), z.number()]),
  weight: z.number(),
  score: z.number(),
  verdict: z.string(),
  roomCm: z.number(),
  /** Distance from this size's range: + garment too small/short, − too big/long, 0 inside. */
  outsideCm: z.number().optional(),
  /** Confidence of the body measurement behind this verdict. */
  confidence: z.number().optional(),
});
export type FitDimension = z.infer<typeof FitDimension>;

export const RecommendationView = z.object({
  id: Uuid,
  garment: GarmentSummary,
  bodyCoreId: Uuid,
  recommendedSize: z.string(),
  alternativeSize: z.string().nullable(),
  fitScore: z.number().int(),
  fitLabel: z.string(),
  betweenSizes: z.boolean(),
  confidence: z.object({ value: z.number(), label: z.string() }),
  preference: FitPreference,
  dimensions: z.array(FitDimension),
  sizes: z.array(
    z.object({
      label: z.string(),
      score: z.number(),
      /** The size can't close around a girth (too small to wear). */
      blocked: z.boolean().optional(),
      // Absent on recommendations stored before the try-on view.
      dimensions: z.array(FitDimension).optional(),
    }),
  ),
  /** Even the largest size can't close. */
  noSizeFits: z.boolean(),
  explanation: z.string(),
  /** "rules", or "gemini:<model>" when Gemini rewrote the explanation. */
  explanationSource: z.string(),
  engineVersion: z.string(),
  createdAt: IsoDateTime,
  feedback: z
    .object({ outcome: z.string(), sizeChosen: z.string(), createdAt: IsoDateTime })
    .nullable(),
});
export type RecommendationView = z.infer<typeof RecommendationView>;

// ─────────────────────────── Admin: add outfits ───────────────────────────

export const SizeChartDimension = z.enum([
  'chest', 'waist', 'hip', 'shoulder_width', 'neck', 'arm_length', 'inseam', 'thigh',
]);
export type SizeChartDimension = z.infer<typeof SizeChartDimension>;

const CmRange = z
  .tuple([z.number().positive().max(250), z.number().positive().max(250)])
  .refine(([lo, hi]) => lo < hi, 'min must be below max');

export const ReadSizeChartRequest = z.object({
  imageBase64: z.string().min(100).max(3_000_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});
export type ReadSizeChartRequest = z.infer<typeof ReadSizeChartRequest>;

export const ReadSizeChartResponse = z.object({
  chartKind: z.enum(['body', 'garment', 'unknown']),
  categoryGuess: GarmentCategory.nullable(),
  dimensions: z.array(z.string()),
  sizes: z.array(z.object({ label: z.string(), measurements: z.record(z.string(), z.tuple([z.number(), z.number()])) })),
  warnings: z.array(z.string()),
  notes: z.string(),
  model: z.string(),
});
export type ReadSizeChartResponse = z.infer<typeof ReadSizeChartResponse>;

export const CreateGarmentRequest = z.object({
  /** An existing brand by slug, or a new one by name. */
  brand: z.union([
    z.object({ slug: z.string().min(1) }),
    z.object({
      name: z.string().min(2).max(60),
      description: z.string().max(200).optional(),
      accentHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2f3a4a'),
    }),
  ]),
  name: z.string().min(2).max(80),
  category: GarmentCategory,
  subcategory: z.string().min(2).max(40),
  gender: z.enum(['men', 'women', 'unisex']),
  fitIntent: z.enum(['SLIM', 'REGULAR', 'RELAXED', 'OVERSIZED']),
  stretch: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH']),
  material: z.string().min(2).max(120),
  description: z.string().min(10).max(600),
  priceCents: z.number().int().positive().max(10_000_000),
  currency: z.string().length(3).default('USD'),
  colorName: z.string().min(2).max(40),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Optional product photo: an https URL you may use, or a generated image (base64 JPEG). */
  imageUrl: z.string().url().startsWith('https://').optional(),
  imageBase64: z.string().max(3_000_000).optional(),
  sizeChart: z.object({
    sizes: z
      .array(
        z.object({
          label: z.string().min(1).max(12),
          measurements: z.record(SizeChartDimension, CmRange),
        }),
      )
      .min(1)
      .max(15),
  }),
});
export type CreateGarmentRequest = z.infer<typeof CreateGarmentRequest>;

export const AdminStatus = z.object({ isAdmin: z.boolean(), geminiEnabled: z.boolean() });
export type AdminStatus = z.infer<typeof AdminStatus>;

export const ProductPhotoRequest = z.object({
  name: z.string().min(2).max(80),
  subcategory: z.string().min(2).max(40),
  gender: z.enum(['men', 'women', 'unisex']),
  fitIntent: z.enum(['SLIM', 'REGULAR', 'RELAXED', 'OVERSIZED']),
  material: z.string().max(120).default(''),
  description: z.string().max(600).default(''),
  colorName: z.string().max(40).default(''),
  colorHex: z.string().max(7).default(''),
});
export type ProductPhotoRequest = z.infer<typeof ProductPhotoRequest>;

/** An AI-generated image, returned inline and not stored. */
export const GeneratedImage = z.object({ imageBase64: z.string(), mimeType: z.string(), model: z.string() });
export type GeneratedImage = z.infer<typeof GeneratedImage>;

/** A saved photo try-on (made once, then reused). */
export const PhotoTryOnView = z.object({
  /** Short-lived signed URL to the saved image. */
  url: z.string(),
  model: z.string(),
  createdAt: IsoDateTime,
});
export type PhotoTryOnView = z.infer<typeof PhotoTryOnView>;

export const PhotoTryOnRequest = z.object({
  /** The shopper's explicit OK to send their front scan photo to Google Gemini. */
  consent: z.literal(true),
});
export type PhotoTryOnRequest = z.infer<typeof PhotoTryOnRequest>;

// ─────────────────────────── Fitting room (local photo try-on) ───────────────

export const FitPreviewRequest = z.object({
  /** Size to show; the recommended one when left out. */
  size: z.string().min(1).max(12).optional(),
  /** "product": this item on your photo. "own": the top you're wearing in
   * your scan photo, at this item's size — how a size up or down would sit. */
  mode: z.enum(['product', 'own']).default('product'),
  view: z.enum(['front', 'back']).default('front'),
  preference: FitPreference.optional(),
});
export type FitPreviewRequest = z.infer<typeof FitPreviewRequest>;

export const FitZone = z.object({
  name: z.string(),
  label: z.string(),
  /** bad = too small, warn = snug, good, loose, bad-loose = far too big */
  tone: z.string(),
  text: z.string(),
  /** anchor, as fractions of the image */
  x: z.number(),
  y: z.number(),
});
export type FitZone = z.infer<typeof FitZone>;

export const FitPreviewView = z.object({
  imageBase64: z.string(),
  mimeType: z.string(),
  width: z.number(),
  height: z.number(),
  zones: z.array(FitZone),
  summary: z.string(),
  size: z.string(),
  recommendedSize: z.string(),
  sizes: z.array(z.object({ label: z.string(), score: z.number(), blocked: z.boolean().optional() })),
  mode: z.enum(['product', 'own']),
  view: z.enum(['front', 'back']),
  backAvailable: z.boolean(),
  elapsedMs: z.number(),
});
export type FitPreviewView = z.infer<typeof FitPreviewView>;

// ─────────────────────────── Accuracy check (tape vs scan) ───────────────────

export const TapeCheckRequest = z.object({
  /** measurement name → tape-measured value, cm */
  values: z.record(z.string(), z.number().positive().max(300)),
  note: z.string().max(500).optional(),
});
export type TapeCheckRequest = z.infer<typeof TapeCheckRequest>;

export const TapeComparison = z.object({
  name: z.string(),
  label: z.string(),
  scanCm: z.number(),
  tapeCm: z.number(),
  /** scan − tape: positive means the scan reads larger */
  errorCm: z.number(),
  targetCm: z.number(),
  withinTarget: z.boolean(),
  typicalErrorCm: z.number().nullable(),
});
export type TapeComparison = z.infer<typeof TapeComparison>;

export const TapeCheckView = z.object({
  id: Uuid,
  bodyCoreId: Uuid,
  bodyVersion: z.number().int(),
  note: z.string().nullable(),
  rows: z.array(TapeComparison),
  meanAbsErrorCm: z.number().nullable(),
  withinTargetPct: z.number().nullable(),
  createdAt: IsoDateTime,
});
export type TapeCheckView = z.infer<typeof TapeCheckView>;

export const AccuracyReport = z.object({
  people: z.number().int(),
  checks: z.number().int(),
  rows: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      n: z.number().int(),
      maeCm: z.number(),
      biasCm: z.number(),
      within2Pct: z.number(),
      within4Pct: z.number(),
      targetCm: z.number(),
    }),
  ),
  sizeFeedback: z.object({
    total: z.number().int(),
    perfectPct: z.number().nullable(),
  }),
});
export type AccuracyReport = z.infer<typeof AccuracyReport>;

export const FitFeedbackRequest = z.object({
  sizeChosen: z.string().min(1).max(20),
  outcome: z.enum(['PERFECT', 'TOO_SMALL', 'TOO_LARGE', 'KEPT', 'RETURNED']),
  comment: z.string().max(500).optional(),
});
export type FitFeedbackRequest = z.infer<typeof FitFeedbackRequest>;

