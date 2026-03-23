-- AlterTable
ALTER TABLE "BulkProductDescription"
ADD COLUMN "czPromptTokens" INTEGER,
ADD COLUMN "czCompletionTokens" INTEGER,
ADD COLUMN "czTotalTokens" INTEGER,
ADD COLUMN "czCostUsd" DOUBLE PRECISION,
ADD COLUMN "skPromptTokens" INTEGER,
ADD COLUMN "skCompletionTokens" INTEGER,
ADD COLUMN "skTotalTokens" INTEGER,
ADD COLUMN "skCostUsd" DOUBLE PRECISION,
ADD COLUMN "totalTokens" INTEGER,
ADD COLUMN "totalCostUsd" DOUBLE PRECISION;
