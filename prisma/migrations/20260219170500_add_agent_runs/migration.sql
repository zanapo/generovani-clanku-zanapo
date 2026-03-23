-- CreateTable
CREATE TABLE "ArticleAgentRun" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "inputJson" TEXT,
    "outputJson" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleAgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ArticleAgentRun_articleId_stage_createdAt_idx" ON "ArticleAgentRun"("articleId", "stage", "createdAt");

-- AddForeignKey
ALTER TABLE "ArticleAgentRun" ADD CONSTRAINT "ArticleAgentRun_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
