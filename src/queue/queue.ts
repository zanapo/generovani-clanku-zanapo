import { Queue } from "bullmq";
import type { ManualStage } from "../services/agents/stages.js";

const connection = { url: process.env.REDIS_URL ?? "redis://localhost:6379" };
let queue: Queue | null = null;

function getQueue(): Queue {
  if (!queue) {
    queue = new Queue("article-generation", { connection });
  }
  return queue;
}

export async function enqueueArticleGeneration(articleId: string, jobName = "generate"): Promise<void> {
  await getQueue().add(
    jobName,
    { articleId, stage: "final_packager" },
    { attempts: 2, backoff: { type: "exponential", delay: 2000 } }
  );
}

export async function enqueueManualStage(articleId: string, stage: ManualStage, model?: string): Promise<void> {
  await getQueue().add(
    `stage:${stage}`,
    { articleId, stage, model },
    { attempts: 2, backoff: { type: "exponential", delay: 2000 } }
  );
}
