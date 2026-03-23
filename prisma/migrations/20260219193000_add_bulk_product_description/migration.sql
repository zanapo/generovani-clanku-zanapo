-- CreateTable
CREATE TABLE "BulkProductDescription" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "sourceProductId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "productCode" TEXT,
  "ean" TEXT,
  "manufacturer" TEXT,
  "category" TEXT,
  "sourceLongText" TEXT NOT NULL,
  "sourceShortText" TEXT,
  "status" TEXT NOT NULL DEFAULT 'imported',
  "qualityScore" INTEGER,
  "issuesJson" TEXT,
  "czShortHtml" TEXT,
  "czLongHtml" TEXT,
  "czFinalHtml" TEXT,
  "skShortHtml" TEXT,
  "skLongHtml" TEXT,
  "skFinalHtml" TEXT,
  "sqlCz" TEXT,
  "sqlSk" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BulkProductDescription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkProductDescription_batchId_createdAt_idx"
ON "BulkProductDescription"("batchId", "createdAt");

-- CreateIndex
CREATE INDEX "BulkProductDescription_batchId_status_idx"
ON "BulkProductDescription"("batchId", "status");
