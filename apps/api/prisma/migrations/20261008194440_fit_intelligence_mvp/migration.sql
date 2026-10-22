-- CreateEnum
CREATE TYPE "FitPreference" AS ENUM ('SNUG', 'REGULAR', 'LOOSE');

-- CreateEnum
CREATE TYPE "GarmentCategory" AS ENUM ('TOPS', 'OUTERWEAR', 'BOTTOMS', 'DRESSES');

-- CreateEnum
CREATE TYPE "FitIntent" AS ENUM ('SLIM', 'REGULAR', 'RELAXED', 'OVERSIZED');

-- CreateEnum
CREATE TYPE "StretchLevel" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "FitOutcome" AS ENUM ('PERFECT', 'TOO_SMALL', 'TOO_LARGE', 'KEPT', 'RETURNED');

-- AlterTable
ALTER TABLE "ReconstructionJob" ADD COLUMN     "scanReport" JSONB;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "fitPreference" "FitPreference" NOT NULL DEFAULT 'REGULAR';

-- CreateTable
CREATE TABLE "BodyMeasurement" (
    "id" UUID NOT NULL,
    "bodyCoreId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "valueCm" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "typicalErrorCm" DOUBLE PRECISION,
    "method" TEXT NOT NULL,
    "sources" TEXT[],
    "region" JSONB,
    "engineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BodyMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "accentHex" TEXT NOT NULL DEFAULT '#111111',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeChart" (
    "id" UUID NOT NULL,
    "brandId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "GarmentCategory" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SizeChart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SizeChartEntry" (
    "id" UUID NOT NULL,
    "sizeChartId" UUID NOT NULL,
    "sizeLabel" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "dimension" TEXT NOT NULL,
    "minCm" DOUBLE PRECISION NOT NULL,
    "maxCm" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SizeChartEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Garment" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "brandId" UUID NOT NULL,
    "sizeChartId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" "GarmentCategory" NOT NULL,
    "subcategory" TEXT NOT NULL,
    "gender" TEXT NOT NULL,
    "fitIntent" "FitIntent" NOT NULL,
    "stretch" "StretchLevel" NOT NULL,
    "material" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "colorName" TEXT NOT NULL,
    "colorHex" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Garment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "garmentId" UUID NOT NULL,
    "bodyCoreId" UUID NOT NULL,
    "recommendedSize" TEXT NOT NULL,
    "alternativeSize" TEXT,
    "fitScore" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "betweenSizes" BOOLEAN NOT NULL,
    "preference" "FitPreference" NOT NULL,
    "result" JSONB NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FitFeedback" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "recommendationId" UUID,
    "garmentId" UUID NOT NULL,
    "sizeChosen" TEXT NOT NULL,
    "outcome" "FitOutcome" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FitFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BodyMeasurement_bodyCoreId_name_key" ON "BodyMeasurement"("bodyCoreId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_slug_key" ON "Brand"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "SizeChart_brandId_name_key" ON "SizeChart"("brandId", "name");

-- CreateIndex
CREATE INDEX "SizeChartEntry_sizeChartId_sortOrder_idx" ON "SizeChartEntry"("sizeChartId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "SizeChartEntry_sizeChartId_sizeLabel_dimension_key" ON "SizeChartEntry"("sizeChartId", "sizeLabel", "dimension");

-- CreateIndex
CREATE UNIQUE INDEX "Garment_slug_key" ON "Garment"("slug");

-- CreateIndex
CREATE INDEX "Garment_category_isActive_idx" ON "Garment"("category", "isActive");

-- CreateIndex
CREATE INDEX "Recommendation_userId_createdAt_idx" ON "Recommendation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Recommendation_garmentId_idx" ON "Recommendation"("garmentId");

-- CreateIndex
CREATE INDEX "FitFeedback_garmentId_outcome_idx" ON "FitFeedback"("garmentId", "outcome");

-- AddForeignKey
ALTER TABLE "BodyMeasurement" ADD CONSTRAINT "BodyMeasurement_bodyCoreId_fkey" FOREIGN KEY ("bodyCoreId") REFERENCES "BodyCore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SizeChart" ADD CONSTRAINT "SizeChart_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SizeChartEntry" ADD CONSTRAINT "SizeChartEntry_sizeChartId_fkey" FOREIGN KEY ("sizeChartId") REFERENCES "SizeChart"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Garment" ADD CONSTRAINT "Garment_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Garment" ADD CONSTRAINT "Garment_sizeChartId_fkey" FOREIGN KEY ("sizeChartId") REFERENCES "SizeChart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_garmentId_fkey" FOREIGN KEY ("garmentId") REFERENCES "Garment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_bodyCoreId_fkey" FOREIGN KEY ("bodyCoreId") REFERENCES "BodyCore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitFeedback" ADD CONSTRAINT "FitFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitFeedback" ADD CONSTRAINT "FitFeedback_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitFeedback" ADD CONSTRAINT "FitFeedback_garmentId_fkey" FOREIGN KEY ("garmentId") REFERENCES "Garment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
