# TailorAI — Data Model

PostgreSQL 16 + Prisma. Shown as Prisma schema because that is the source of truth we'll generate
from; SQL specifics noted where they matter.

---

## 1. Shape of the model

Seven concerns, deliberately separated:

| Entity | Holds | Lifetime |
|---|---|---|
| `User` | Identity, consent state | Until deletion request |
| `CaptureSession` | One capture attempt + its raw media | **TTL — purged** (§4) |
| `Asset` | Any blob in object storage | Follows its owner |
| `ReconstructionJob` | Job state machine | Retained (audit) |
| `JobStage` | Per-stage timings, errors, IO refs | Retained (audit) |
| **`BodyCore`** | **The permanent profile** | **Forever, versioned** |
| `AvatarRender` | A mesh+texture derived from a Core | Disposable, regenerable |
| `Export` | A generated download artifact | Short-lived |

The `BodyCore` / `AvatarRender` split is the schema-level expression of the core insight: one
Core can have many Renders over time as our pipeline improves, and deleting every Render loses
nothing permanent.

---

## 2. Schema

```prisma
// ─────────────────────────── Identity ───────────────────────────

model User {
  id            String   @id @default(uuid()) @db.Uuid
  externalId    String   @unique              // from AuthProvider
  email         String?  @unique
  displayName   String?

  // Self-reported, used for scale resolution (S7) and Anny priors
  heightCm      Float?
  weightKg      Float?
  birthYear     Int?
  sexAtBirth    SexAtBirth?                   // for body-model priors only

  // Consent is explicit, versioned and timestamped — see 06-infra-cost-risk.md
  consents      Consent[]
  dataRegion    String   @default("eu")       // residency pin

  captureSessions CaptureSession[]
  bodyCores       BodyCore[]
  jobs            ReconstructionJob[]

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?                     // soft delete → hard purge job

  @@index([deletedAt])
}

enum SexAtBirth { FEMALE MALE UNSPECIFIED }

model Consent {
  id          String      @id @default(uuid()) @db.Uuid
  userId      String      @db.Uuid
  user        User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  kind        ConsentKind
  version     String                          // e.g. "biometric-v1"
  granted     Boolean
  grantedAt   DateTime    @default(now())
  revokedAt   DateTime?
  ipAddress   String?                         // proof of consent
  userAgent   String?

  @@index([userId, kind])
}

enum ConsentKind {
  BIOMETRIC_PROCESSING     // required to process at all
  RAW_MEDIA_RETENTION      // optional: keep photos past TTL
  MODEL_IMPROVEMENT        // optional: use my data for training
}

// ─────────────────────────── Capture & assets ───────────────────────────

model CaptureSession {
  id          String        @id @default(uuid()) @db.Uuid
  userId      String        @db.Uuid
  user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)

  mode        CaptureMode
  status      SessionStatus @default(UPLOADING)

  // Client-side guided-capture telemetry (D4) — diagnoses bad reconstructions
  deviceModel String?
  osVersion   String?
  qualityHints Json?        // { lighting, distance, poseScores[], rejectedFrames }

  assets      Asset[]
  jobs        ReconstructionJob[]

  createdAt   DateTime      @default(now())
  purgeAfter  DateTime                        // TTL enforced by a sweeper
  purgedAt    DateTime?

  @@index([userId, createdAt])
  @@index([purgeAfter, purgedAt])             // sweeper scan
}

enum CaptureMode   { VIDEO_360 PHOTO_SET }
enum SessionStatus { UPLOADING READY PROCESSING COMPLETED FAILED PURGED }

model Asset {
  id            String     @id @default(uuid()) @db.Uuid
  sessionId     String?    @db.Uuid
  session       CaptureSession? @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  kind          AssetKind
  storageKey    String     @unique            // object-storage path
  bucket        String
  mimeType      String
  sizeBytes     BigInt
  sha256        String                        // content-addressed → dedupe + retry resume

  width         Int?
  height        Int?
  durationMs    Int?

  metadata      Json?
  createdAt     DateTime   @default(now())
  expiresAt     DateTime?

  @@index([sessionId, kind])
  @@index([sha256])
}

enum AssetKind {
  RAW_VIDEO RAW_PHOTO
  EXTRACTED_FRAME MASK PREPARED_FRAME         // intermediates
  MESH_GLB MESH_OBJ TEXTURE_ATLAS THUMBNAIL
  METADATA_SIDECAR
}

// ─────────────────────────── Jobs ───────────────────────────

model ReconstructionJob {
  id             String    @id @default(uuid()) @db.Uuid
  userId         String    @db.Uuid
  user           User      @relation(fields: [userId], references: [id])
  sessionId      String    @db.Uuid
  session        CaptureSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  status         JobStatus @default(QUEUED)
  progress       Float     @default(0)        // 0..1, derived from stage weights
  idempotencyKey String?   @unique            // flaky-network protection

  pipelineVersion String                      // e.g. "v1.2.0" — reproducibility
  modelVersions   Json                        // { sam3dbody: "...", birefnet: "..." }

  stages         JobStage[]
  bodyCore       BodyCore?
  render         AvatarRender?

  errorCode      String?                      // taxonomy, not free text
  errorMessage   String?

  queuedAt       DateTime  @default(now())
  startedAt      DateTime?
  finishedAt     DateTime?
  computeMs      Int?
  estimatedCost  Decimal?  @db.Decimal(10, 6)

  @@index([userId, queuedAt])
  @@index([status])
}

enum JobStatus {
  QUEUED VALIDATING EXTRACTING SELECTING SEGMENTING
  RECONSTRUCTING FUSING TEXTURING OPTIMISING EXPORTING
  COMPLETED FAILED CANCELLED
}

model JobStage {
  id          String    @id @default(uuid()) @db.Uuid
  jobId       String    @db.Uuid
  job         ReconstructionJob @relation(fields: [jobId], references: [id], onDelete: Cascade)

  name        String                          // "S5_BODY_INFERENCE"
  sequence    Int
  status      StageStatus @default(PENDING)
  attempt     Int       @default(0)

  inputRef    String?                         // sha256 → resume-from-here
  outputRef   String?

  startedAt   DateTime?
  finishedAt  DateTime?
  durationMs  Int?
  errorCode   String?
  errorDetail Json?

  @@unique([jobId, name, attempt])
  @@index([jobId, sequence])
}

enum StageStatus { PENDING RUNNING SUCCEEDED FAILED SKIPPED DEGRADED }

// ═══════════════════════ THE PERMANENT PROFILE ═══════════════════════

model BodyCore {
  id              String   @id @default(uuid()) @db.Uuid
  userId          String   @db.Uuid
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobId           String?  @unique @db.Uuid
  job             ReconstructionJob? @relation(fields: [jobId], references: [id])

  version         Int      @default(1)        // monotonic per user
  isCurrent       Boolean  @default(true)     // exactly one true per user

  // ── Parametric body (the actual asset) ──
  bodyModel       BodyModelKind               // MHR today, swappable
  bodyModelVersion String
  shapeParams     Float[]                     // MHR: 45 coefficients
  shapeConfidence Float[]                     // per-coefficient inter-frame variance (S6)

  // ── Interpretable layer (S8, optional) ──
  annyParams      Float[]                     // 11 phenotype params
  annyVersion     String?

  // ── Metric scale, with provenance — never silently baked in ──
  scaleSource     ScaleSource
  heightCm        Float?
  scaleConfidence Float?

  // ── Provenance ──
  frameCount      Int
  captureMode     CaptureMode
  overallQuality  Float?                      // 0..1, drives UI honesty

  renders         AvatarRender[]

  createdAt       DateTime @default(now())
  supersededAt    DateTime?

  @@index([userId, isCurrent])
  @@index([userId, version])
}

enum BodyModelKind { MHR ANNY }
enum ScaleSource   { USER_HEIGHT ARKIT_DEPTH REFERENCE_OBJECT STATISTICAL_PRIOR }

// ─────────────────────────── Derived, disposable ───────────────────────────

model AvatarRender {
  id            String   @id @default(uuid()) @db.Uuid
  bodyCoreId    String   @db.Uuid
  bodyCore      BodyCore @relation(fields: [bodyCoreId], references: [id], onDelete: Cascade)
  jobId         String?  @unique @db.Uuid
  job           ReconstructionJob? @relation(fields: [jobId], references: [id])

  rendererVersion String                      // regenerate when this changes
  vertexCount   Int
  triangleCount Int
  textureRes    Int?
  isTextured    Boolean  @default(true)
  isDegraded    Boolean  @default(false)      // e.g. texture bake failed
  coverageMap   Json?                         // which regions were observed vs inpainted

  exports       Export[]
  createdAt     DateTime @default(now())

  @@index([bodyCoreId])
}

model Export {
  id          String     @id @default(uuid()) @db.Uuid
  renderId    String     @db.Uuid
  render      AvatarRender @relation(fields: [renderId], references: [id], onDelete: Cascade)
  format      ExportFormat
  assetId     String     @db.Uuid
  sizeBytes   BigInt
  downloadCount Int      @default(0)
  createdAt   DateTime   @default(now())
  expiresAt   DateTime?

  @@index([renderId, format])
}

enum ExportFormat { GLB OBJ_ZIP USDZ FBX }    // USDZ/FBX reserved, not v1
```

---

## 3. Notes on specific choices

**`shapeParams Float[]` rather than a JSON blob.** Postgres native arrays are typed, indexable,
and — importantly — usable in similarity queries later (`cube`/`pgvector` for "find users with
similar bodies", which is exactly how sizing recommendations get built). JSON would make that a
migration.

**`shapeConfidence` parallel to `shapeParams`.** Storing uncertainty alongside the estimate is
what separates a measurement from a guess. Every future feature that consumes the Core can then
decide for itself what confidence it needs.

**`isCurrent` + `version` rather than overwriting.** Bodies change. A user re-scanning in six
months should produce version 2 while version 1 remains queryable — that longitudinal history is
a genuine long-term asset and it costs ~2 KB per version to keep. Enforce with a partial unique
index, which Prisma can't express natively:

```sql
CREATE UNIQUE INDEX one_current_core_per_user
  ON "BodyCore" ("userId") WHERE "isCurrent" = true;
```

**`errorCode` not free-text.** A closed taxonomy (`INPUT_TOO_DARK`, `NO_PERSON_DETECTED`,
`MULTIPLE_PEOPLE`, `GPU_OOM`, `SCALE_UNRESOLVED`) is what lets the app show an actionable
message and lets us alert on failure-mode shifts.

**`sha256` on every asset.** Enables retry-resume (§02 job state machine), deduplication, and
integrity verification on download.

**`Decimal` for cost, never `Float`.** Money is never a float.

---

## 4. Retention & deletion

This is a legal requirement, not a nicety — see
[06-infra-cost-risk.md](06-infra-cost-risk.md#privacy--legal).

| Data | Default retention | Notes |
|---|---|---|
| Raw video / photos | **30 days**, then purged | Extended only with explicit `RAW_MEDIA_RETENTION` consent |
| Intermediate frames, masks | **7 days** | Only needed for retry-resume |
| Meshes, textures | Until user deletes | The visible product |
| `BodyCore` | Until user deletes | The profile |
| Job/stage records | 12 months | Audit; scrub identifiers after |

A `purgeAfter` sweeper runs on `CaptureSession`. **Deletion must reach object storage, not just
Postgres** — a `deletedAt` on a row while the blob lives on is not deletion, and regulators
treat it accordingly. The hard-purge job deletes blobs first, then rows, and records completion.

---

**Next:** [04-api-spec.md](04-api-spec.md)
