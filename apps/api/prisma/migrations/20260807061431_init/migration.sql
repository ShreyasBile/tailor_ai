-- CreateEnum
CREATE TYPE "SexAtBirth" AS ENUM ('FEMALE', 'MALE', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "ConsentKind" AS ENUM ('BIOMETRIC_PROCESSING', 'RAW_MEDIA_RETENTION', 'MODEL_IMPROVEMENT');

-- CreateEnum
CREATE TYPE "CaptureMode" AS ENUM ('VIDEO_360', 'PHOTO_SET');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('UPLOADING', 'READY', 'PROCESSING', 'COMPLETED', 'FAILED', 'PURGED');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('RAW_VIDEO', 'RAW_PHOTO', 'EXTRACTED_FRAME', 'MASK', 'PREPARED_FRAME', 'MESH_GLB', 'MESH_OBJ', 'TEXTURE_ATLAS', 'THUMBNAIL', 'METADATA_SIDECAR');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'VALIDATING', 'EXTRACTING', 'SELECTING', 'SEGMENTING', 'RECONSTRUCTING', 'FUSING', 'TEXTURING', 'OPTIMISING', 'EXPORTING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'DEGRADED');

-- CreateEnum
CREATE TYPE "BodyModelKind" AS ENUM ('MHR', 'ANNY');

-- CreateEnum
CREATE TYPE "ScaleSource" AS ENUM ('USER_HEIGHT', 'ARKIT_DEPTH', 'REFERENCE_OBJECT', 'STATISTICAL_PRIOR');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('GLB', 'OBJ_ZIP', 'USDZ', 'FBX');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "heightCm" DOUBLE PRECISION,
    "weightKg" DOUBLE PRECISION,
    "birthYear" INTEGER,
    "sexAtBirth" "SexAtBirth",
    "dataRegion" TEXT NOT NULL DEFAULT 'eu',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "ConsentKind" NOT NULL,
    "version" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaptureSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "mode" "CaptureMode" NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'UPLOADING',
    "deviceModel" TEXT,
    "osVersion" TEXT,
    "qualityHints" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAfter" TIMESTAMP(3) NOT NULL,
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "CaptureSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "sessionId" UUID,
    "kind" "AssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Upload" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "s3UploadId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "partSizeBytes" INTEGER NOT NULL,
    "totalParts" INTEGER NOT NULL,
    "completedParts" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconstructionJob" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "options" JSONB,
    "idempotencyKey" TEXT,
    "pipelineVersion" TEXT NOT NULL,
    "modelVersions" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "computeMs" INTEGER,
    "estimatedCost" DECIMAL(10,6),

    CONSTRAINT "ReconstructionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStage" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" "StageStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "inputRef" TEXT,
    "outputRef" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorDetail" JSONB,

    CONSTRAINT "JobStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BodyCore" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "jobId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "bodyModel" "BodyModelKind" NOT NULL,
    "bodyModelVersion" TEXT NOT NULL,
    "shapeParams" DOUBLE PRECISION[],
    "shapeConfidence" DOUBLE PRECISION[],
    "annyParams" DOUBLE PRECISION[],
    "annyVersion" TEXT,
    "scaleSource" "ScaleSource" NOT NULL,
    "heightCm" DOUBLE PRECISION,
    "scaleConfidence" DOUBLE PRECISION,
    "metricScale" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "frameCount" INTEGER NOT NULL,
    "captureMode" "CaptureMode" NOT NULL,
    "overallQuality" DOUBLE PRECISION,
    "coverageDegrees" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "BodyCore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvatarRender" (
    "id" UUID NOT NULL,
    "bodyCoreId" UUID NOT NULL,
    "jobId" UUID,
    "rendererVersion" TEXT NOT NULL,
    "vertexCount" INTEGER NOT NULL,
    "triangleCount" INTEGER NOT NULL,
    "textureRes" INTEGER,
    "isTextured" BOOLEAN NOT NULL DEFAULT true,
    "isDegraded" BOOLEAN NOT NULL DEFAULT false,
    "coverage" JSONB,
    "glbAssetId" UUID,
    "thumbnailAssetId" UUID,
    "textureAssetId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvatarRender_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Export" (
    "id" UUID NOT NULL,
    "renderId" UUID NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "assetId" UUID NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Export_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_externalId_key" ON "User"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "Consent_userId_kind_idx" ON "Consent"("userId", "kind");

-- CreateIndex
CREATE INDEX "CaptureSession_userId_createdAt_idx" ON "CaptureSession"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CaptureSession_purgeAfter_purgedAt_idx" ON "CaptureSession"("purgeAfter", "purgedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_storageKey_key" ON "Asset"("storageKey");

-- CreateIndex
CREATE INDEX "Asset_sessionId_kind_idx" ON "Asset"("sessionId", "kind");

-- CreateIndex
CREATE INDEX "Asset_sha256_idx" ON "Asset"("sha256");

-- CreateIndex
CREATE INDEX "Asset_expiresAt_idx" ON "Asset"("expiresAt");

-- CreateIndex
CREATE INDEX "Upload_sessionId_idx" ON "Upload"("sessionId");

-- CreateIndex
CREATE INDEX "Upload_expiresAt_idx" ON "Upload"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReconstructionJob_idempotencyKey_key" ON "ReconstructionJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReconstructionJob_userId_queuedAt_idx" ON "ReconstructionJob"("userId", "queuedAt");

-- CreateIndex
CREATE INDEX "ReconstructionJob_status_idx" ON "ReconstructionJob"("status");

-- CreateIndex
CREATE INDEX "ReconstructionJob_sessionId_idx" ON "ReconstructionJob"("sessionId");

-- CreateIndex
CREATE INDEX "JobStage_jobId_sequence_idx" ON "JobStage"("jobId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "JobStage_jobId_name_attempt_key" ON "JobStage"("jobId", "name", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "BodyCore_jobId_key" ON "BodyCore"("jobId");

-- CreateIndex
CREATE INDEX "BodyCore_userId_isCurrent_idx" ON "BodyCore"("userId", "isCurrent");

-- CreateIndex
CREATE INDEX "BodyCore_userId_version_idx" ON "BodyCore"("userId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AvatarRender_jobId_key" ON "AvatarRender"("jobId");

-- CreateIndex
CREATE INDEX "AvatarRender_bodyCoreId_idx" ON "AvatarRender"("bodyCoreId");

-- CreateIndex
CREATE INDEX "Export_renderId_format_idx" ON "Export"("renderId", "format");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaptureSession" ADD CONSTRAINT "CaptureSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Upload" ADD CONSTRAINT "Upload_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconstructionJob" ADD CONSTRAINT "ReconstructionJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconstructionJob" ADD CONSTRAINT "ReconstructionJob_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStage" ADD CONSTRAINT "JobStage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ReconstructionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BodyCore" ADD CONSTRAINT "BodyCore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BodyCore" ADD CONSTRAINT "BodyCore_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ReconstructionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvatarRender" ADD CONSTRAINT "AvatarRender_bodyCoreId_fkey" FOREIGN KEY ("bodyCoreId") REFERENCES "BodyCore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvatarRender" ADD CONSTRAINT "AvatarRender_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ReconstructionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_renderId_fkey" FOREIGN KEY ("renderId") REFERENCES "AvatarRender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
