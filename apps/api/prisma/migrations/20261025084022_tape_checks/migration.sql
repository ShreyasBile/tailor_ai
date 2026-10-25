-- CreateTable
CREATE TABLE "TapeCheck" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "bodyCoreId" UUID NOT NULL,
    "values" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TapeCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TapeCheck_userId_createdAt_idx" ON "TapeCheck"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "TapeCheck" ADD CONSTRAINT "TapeCheck_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TapeCheck" ADD CONSTRAINT "TapeCheck_bodyCoreId_fkey" FOREIGN KEY ("bodyCoreId") REFERENCES "BodyCore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
