-- CreateTable
CREATE TABLE "PhotoTryOn" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "garmentId" UUID NOT NULL,
    "bodyCoreId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhotoTryOn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PhotoTryOn_userId_garmentId_bodyCoreId_key" ON "PhotoTryOn"("userId", "garmentId", "bodyCoreId");

-- AddForeignKey
ALTER TABLE "PhotoTryOn" ADD CONSTRAINT "PhotoTryOn_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoTryOn" ADD CONSTRAINT "PhotoTryOn_garmentId_fkey" FOREIGN KEY ("garmentId") REFERENCES "Garment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhotoTryOn" ADD CONSTRAINT "PhotoTryOn_bodyCoreId_fkey" FOREIGN KEY ("bodyCoreId") REFERENCES "BodyCore"("id") ON DELETE CASCADE ON UPDATE CASCADE;
