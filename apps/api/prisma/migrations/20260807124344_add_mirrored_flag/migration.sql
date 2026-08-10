-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "mirrored" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN     "mirrored" BOOLEAN NOT NULL DEFAULT false;
