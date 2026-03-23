import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import { enqueueArticleGeneration, enqueueManualStage } from "../queue/queue.js";
import { llmClient } from "../services/llm/LlmClient.js";
import { buildShopDiscoveryMessages, buildTopicIdeasMessages } from "../services/llm/prompt.js";
import { MANUAL_STAGES, isManualStage } from "../services/agents/stages.js";
import { AVAILABLE_MODELS, MODEL_PLAN, resolveModelForStage } from "../services/llm/modelPlan.js";
import { enrichIdeasWithKeywordMetrics } from "../services/seo/keywordMetrics.js";

export const articlesRouter = Router();

const LinkSchema = z.object({
  href: z.string().url(),
  anchor: z.string().min(1)
});

const BusinessFieldsSchema = z.object({
  businessGoal: z.enum(["traffic", "conversion", "authority"]).optional(),
  articleType: z.enum(["pillar", "cluster", "landing-support"]).optional(),
  targetSegments: z.array(z.string().min(1)).optional(),
  priorityCategories: z.array(z.string().min(1)).optional(),
  requiredInternalLinks: z.array(z.object({ href: z.string().url(), anchor: z.string().optional() })).optional(),
  ctaGoal: z.string().optional(),
  tonePreset: z.string().optional()
});

const CreateSchema = z.object({
  topic: z.string().min(5),
  audience: z.string().optional(),
  keywords: z.string().optional(),
  style: z.string().optional(),
  internalLinks: z.array(LinkSchema).optional(),
  businessFields: BusinessFieldsSchema.optional()
});

const TopicIdeasSchema = z.object({
  focus: z.string().min(2).default("šachy a deskové hry"),
  audience: z.string().default("zákazníci e-shopu Zanapo"),
  model: z.string().optional()
});

const ShopDiscoverySchema = z.object({
  shopUrl: z.string().url(),
  model: z.string().optional()
});

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

articlesRouter.post("/topic-ideas", asyncHandler(async (req, res) => {
  const parsed = TopicIdeasSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const model = pickRequestedModel(parsed.data.model, resolveModelForStage("topic_ideas"));
  const messages = buildTopicIdeasMessages(parsed.data);
  const result = await llmClient.generateJson(messages, model);
  const enrichment = await enrichIdeasWithKeywordMetrics((result as { ideas?: unknown }).ideas);
  const resultObject = (result && typeof result === "object") ? result as Record<string, unknown> : {};
  return res.json({
    ...resultObject,
    ideas: enrichment.ideas,
    keywordMetrics: enrichment.keywordMetrics
  });
}));

articlesRouter.post("/shop-discovery", asyncHandler(async (req, res) => {
  const parsed = ShopDiscoverySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const model = pickRequestedModel(parsed.data.model, resolveModelForStage("topic_ideas"));
  const signals = await gatherShopSignals(parsed.data.shopUrl);
  const messages = buildShopDiscoveryMessages({
    shopUrl: parsed.data.shopUrl,
    llmsTxt: signals.llmsTxt,
    sitemapUrls: signals.sitemapUrls,
    discoveredCategories: signals.discoveredCategories,
    sampleUrls: signals.sampleUrls
  });
  const strategy = await llmClient.generateJson(messages, model);

  return res.json({
    shopUrl: parsed.data.shopUrl,
    signals: {
      llmsTxtFound: signals.llmsTxt.length > 0,
      sitemapUrlsCount: signals.sitemapUrls.length,
      discoveredCategories: signals.discoveredCategories
    },
    strategy
  });
}));

articlesRouter.get("/model-plan", asyncHandler(async (_req, res) => {
  return res.json({ plan: MODEL_PLAN, availableModels: AVAILABLE_MODELS });
}));

articlesRouter.post("/", asyncHandler(async (req, res) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const body = parsed.data;
  const article = await prisma.article.create({
    data: {
      topic: body.topic,
      audience: body.audience ?? null,
      keywords: body.keywords ?? null,
      style: body.style ?? null,
      briefJson: JSON.stringify(body.businessFields ?? {}),
      linksJson: JSON.stringify(body.internalLinks ?? []),
      status: "created"
    }
  });

  return res.status(201).json({ id: article.id, status: article.status });
}));

articlesRouter.get("/:id", asyncHandler(async (req, res) => {
  const id = String(req.params.id);

  const article = await prisma.article.findUnique({
    where: { id },
    include: { versions: { orderBy: { createdAt: "desc" }, take: 3 } }
  });

  if (!article) return res.status(404).json({ error: "Not found" });
  return res.json(article);
}));

articlesRouter.post("/:id/regenerate", asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const article = await prisma.article.findUnique({ where: { id } });

  if (!article) return res.status(404).json({ error: "Not found" });

  await prisma.article.update({
    where: { id },
    data: { status: "queued", error: null }
  });

  await enqueueArticleGeneration(id, "generate");

  return res.status(202).json({ id, status: "queued" });
}));

articlesRouter.get("/:id/stages", asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const runs = await prisma.articleAgentRun.findMany({
    where: { articleId: id },
    orderBy: { createdAt: "desc" },
    take: 50
  });

  const latestByStage = MANUAL_STAGES.map((stage) => {
    const latest = runs.find((r) => r.stage === stage);
    return {
      stage,
      status: latest?.status ?? "not_run",
      error: latest?.error ?? null,
      createdAt: latest?.createdAt ?? null,
      updatedAt: latest?.updatedAt ?? null,
      input: latest?.inputJson ? JSON.parse(latest.inputJson) : null,
      output: latest?.outputJson ? JSON.parse(latest.outputJson) : null
    };
  });

  return res.json({ articleId: id, stages: latestByStage });
}));

articlesRouter.post("/:id/stages/:stage/run", asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const stage = String(req.params.stage);
  if (!isManualStage(stage)) {
    return res.status(400).json({ error: `Unsupported stage. Use one of: ${MANUAL_STAGES.join(", ")}` });
  }
  const requestedModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  const model = requestedModel.length > 0 ? pickRequestedModel(requestedModel, resolveModelForStage(stage)) : undefined;

  const article = await prisma.article.findUnique({ where: { id } });
  if (!article) return res.status(404).json({ error: "Not found" });

  const requiredByStage: Record<string, string[]> = {
    outline_planner: ["deep_research"],
    content_writer: ["deep_research", "outline_planner"],
    seo_editor: ["content_writer"],
    html_validator: ["seo_editor"],
    final_packager: ["html_validator"]
  };

  const dependencies = requiredByStage[stage] ?? [];
  if (dependencies.length > 0) {
    const depRuns = await prisma.articleAgentRun.findMany({
      where: {
        articleId: id,
        stage: { in: dependencies },
        status: "done",
        outputJson: { not: null }
      },
      orderBy: { createdAt: "desc" }
    });

    const completed = new Set(depRuns.map((r) => r.stage));
    const missing = dependencies.filter((dep) => !completed.has(dep));
    if (missing.length > 0) {
      return res.status(400).json({
        error: `Nejdřív spusť předchozí kroky: ${missing.join(", ")}`
      });
    }
  }

  await prisma.article.update({
    where: { id },
    data: { status: "queued", error: null }
  });

  await enqueueManualStage(id, stage, model);
  return res.status(202).json({ id, stage, status: "queued", model: model ?? MODEL_PLAN[stage].model });
}));

articlesRouter.get("/:id/export", asyncHandler(async (req, res) => {
  const id = String(req.params.id);
  const article = await prisma.article.findUnique({
    where: { id },
    include: { versions: { orderBy: { createdAt: "desc" }, take: 1 } }
  });

  if (!article || article.versions.length === 0) {
    return res.status(404).json({ error: "No version yet" });
  }

  const latest = article.versions[0];

  return res.json({
    articleId: article.id,
    topic: article.topic,
    style: article.style,
    businessFields: article.briefJson ? JSON.parse(article.briefJson) : {},
    slug: latest.slug,
    metaTitle: latest.metaTitle,
    metaDescription: latest.metaDescription,
    contentHtml: latest.contentHtml,
    contentMarkdown: latest.contentMarkdown,
    readingTime: latest.readingTime,
    wordCount: latest.wordCount,
    result: JSON.parse(latest.resultJson)
  });
}));

function pickRequestedModel(requestedModel: string | undefined, fallbackModel: string): string {
  const model = (requestedModel ?? "").trim();
  if (!model) return fallbackModel;
  if (!AVAILABLE_MODELS.some((m) => m.id === model)) return fallbackModel;
  return model;
}

async function gatherShopSignals(shopUrl: string): Promise<{
  llmsTxt: string;
  sitemapUrls: string[];
  discoveredCategories: string[];
  sampleUrls: string[];
}> {
  const url = new URL(shopUrl);
  const origin = `${url.protocol}//${url.host}`;
  const llmsTxt = await fetchTextSafe(`${origin}/llms.txt`);
  const sitemapRoot = await fetchTextSafe(`${origin}/sitemap.xml`);

  let sitemapUrls: string[] = [];
  if (sitemapRoot) {
    const locs = extractLocsFromXml(sitemapRoot);
    if (sitemapRoot.toLowerCase().includes("<sitemapindex")) {
      const sitemapFiles = locs.slice(0, 6);
      for (const sitemapFile of sitemapFiles) {
        const xml = await fetchTextSafe(sitemapFile);
        if (!xml) continue;
        sitemapUrls = sitemapUrls.concat(extractLocsFromXml(xml).slice(0, 300));
      }
    } else {
      sitemapUrls = locs.slice(0, 500);
    }
  }

  const normalizedUrls = Array.from(new Set(sitemapUrls.map((u) => u.trim()).filter(Boolean)));
  const sampleUrls = normalizedUrls.slice(0, 80);
  const discoveredCategories = discoverCategoriesFromUrls(normalizedUrls);

  return {
    llmsTxt,
    sitemapUrls: normalizedUrls,
    discoveredCategories,
    sampleUrls
  };
}

async function fetchTextSafe(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function extractLocsFromXml(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(xml)) !== null) {
    const value = m[1]
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .trim();
    if (value) out.push(value);
  }
  return out;
}

function discoverCategoriesFromUrls(urls: string[]): string[] {
  const ignored = new Set(["", "product", "products", "blog", "article", "articles", "wp-content", "wp-json"]);
  const counts = new Map<string, number>();

  for (const raw of urls) {
    try {
      const u = new URL(raw);
      const first = u.pathname.split("/").filter(Boolean)[0] ?? "";
      if (ignored.has(first)) continue;
      counts.set(first, (counts.get(first) ?? 0) + 1);
    } catch {
      // ignore malformed urls
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name]) => name.replaceAll("-", " "));
}
