import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db/prisma.js";
import type { LlmUsage } from "../services/llm/LlmClient.js";
import { llmClient } from "../services/llm/LlmClient.js";
import { buildWebDescriptionMessages, buildWebDescriptionSkMessages, buildWebDescriptionV2Messages } from "../services/llm/prompt.js";
import { gatherProductResearch } from "../services/seo/productResearch.js";

export const webDescriptionRouter = Router();

const GenerateSchema = z.object({
  productId: z.string().min(1),
  variantName: z.string().min(2),
  ean: z.string().optional().default(""),
  productCode: z.string().optional().default(""),
  shortDescription: z.string().min(5),
  longDescription: z.string().min(10),
  manufacturer: z.string().optional().default(""),
  model: z.string().optional()
});

const GenerateV2Schema = GenerateSchema.extend({
  category: z.string().optional(),
  packageContents: z.string().optional(),
  parametersText: z.string().optional()
});

const BulkImportSchema = z.object({
  csvContent: z.string().min(1),
  delimiter: z.string().optional().default(";"),
  batchLabel: z.string().optional().default(""),
  batchDescription: z.string().optional().default("")
});

const BulkGenerateSchema = z.object({
  model: z.string().optional(),
  regenerateGenerated: z.boolean().optional().default(false)
});

const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

webDescriptionRouter.post("/generate", asyncHandler(async (req, res) => {
  const parsed = GenerateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const model = (parsed.data.model ?? "").trim() || process.env.OPENAI_MODEL_WEB_DESCRIPTION || "gpt-4.1";
  const generated = await generateDescriptionBundle({
    productId: parsed.data.productId,
    variantName: parsed.data.variantName,
    ean: parsed.data.ean,
    productCode: parsed.data.productCode,
    shortDescription: parsed.data.shortDescription,
    longDescription: parsed.data.longDescription,
    manufacturer: parsed.data.manufacturer,
    model
  });

  return res.json({
    ...generated.cz,
    modelUsed: generated.modelUsed,
    research: generated.research,
    sqlUpdate: generated.sqlCz,
    sk: generated.sk,
    sqlUpdateSk: generated.sqlSk,
    usage: generated.usage
  });
}));

webDescriptionRouter.post("/generate-v2", asyncHandler(async (req, res) => {
  const parsed = GenerateV2Schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const model = (parsed.data.model ?? "").trim() || process.env.OPENAI_MODEL_WEB_DESCRIPTION_V2 || "gpt-4.1";
  const report = await llmClient.generateText(buildWebDescriptionV2Messages(parsed.data), model);
  return res.json({
    modelUsed: model,
    reportMarkdown: report
  });
}));

webDescriptionRouter.post("/bulk/import", asyncHandler(async (req, res) => {
  const parsed = BulkImportSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const rows = parseDelimited(parsed.data.csvContent, parsed.data.delimiter || ";");
  if (rows.length < 2) return res.status(400).json({ error: "CSV neobsahuje data." });
  const batchLabel = parsed.data.batchLabel.trim();
  const batchDescription = parsed.data.batchDescription.trim();

  const headers = rows[0].map((h) => normalizeHeader(h));
  const batchId = randomUUID();
  const data = rows.slice(1)
    .map((cells) => mapCsvRow(headers, cells))
    .filter((r) => r.sourceProductId || r.name);

  if (data.length === 0) {
    return res.status(400).json({ error: "CSV neobsahuje validní produktové řádky." });
  }

  await prisma.bulkProductDescription.createMany({
    data: data.map((row) => {
      const quality = evaluateInputQuality(row);
      return {
        batchId,
        batchLabel: batchLabel || null,
        batchDescription: batchDescription || null,
        sourceProductId: row.sourceProductId || "missing-id",
        name: row.name || "Bez názvu",
        productCode: row.productCode || null,
        ean: row.ean || null,
        manufacturer: row.manufacturer || null,
        category: row.category || null,
        sourceLongText: row.longText || "",
        sourceShortText: row.shortText || null,
        status: quality.ready ? "input_ready" : "input_incomplete",
        qualityScore: quality.score,
        issuesJson: JSON.stringify(quality.issues)
      };
    })
  });

  const items = await prisma.bulkProductDescription.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" }
  });

  return res.status(201).json({
    batchId,
    batchLabel,
    batchDescription,
    importedCount: items.length,
    summary: buildBatchSummary(items),
    items
  });
}));

webDescriptionRouter.get("/bulk/list", asyncHandler(async (_req, res) => {
  const rows = await prisma.bulkProductDescription.findMany({
    select: {
      batchId: true,
      batchLabel: true,
      batchDescription: true,
      status: true,
      totalCostUsd: true,
      totalTokens: true,
      createdAt: true,
      updatedAt: true
    },
    orderBy: { updatedAt: "desc" }
  });
  if (rows.length === 0) return res.json({ batches: [] });

  const grouped = new Map<string, Array<{
    batchLabel: string | null;
    batchDescription: string | null;
    status: string;
    totalCostUsd: number | null;
    totalTokens: number | null;
    createdAt: Date;
    updatedAt: Date;
  }>>();
  for (const row of rows) {
    const existing = grouped.get(row.batchId) ?? [];
    existing.push({
      status: row.status,
      batchLabel: row.batchLabel,
      batchDescription: row.batchDescription,
      totalCostUsd: row.totalCostUsd,
      totalTokens: row.totalTokens,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    });
    grouped.set(row.batchId, existing);
  }

  const batches = Array.from(grouped.entries())
    .map(([batchId, items]) => {
      const summary = buildBatchSummary(items);
      const latestUpdatedAt = items.reduce((max, i) => i.updatedAt > max ? i.updatedAt : max, items[0].updatedAt);
      const createdAt = items.reduce((min, i) => i.createdAt < min ? i.createdAt : min, items[0].createdAt);
      const batchLabel = items.find((i) => i.batchLabel && i.batchLabel.trim())?.batchLabel ?? null;
      const batchDescription = items.find((i) => i.batchDescription && i.batchDescription.trim())?.batchDescription ?? null;
      return {
        batchId,
        batchLabel,
        batchDescription,
        createdAt,
        updatedAt: latestUpdatedAt,
        summary
      };
    })
    .sort((a, b) => +b.updatedAt - +a.updatedAt);

  return res.json({ batches });
}));

webDescriptionRouter.get("/bulk/:batchId", asyncHandler(async (req, res) => {
  const batchId = String(req.params.batchId);
  const items = await prisma.bulkProductDescription.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" }
  });
  const batchLabel = items.find((i) => i.batchLabel && i.batchLabel.trim())?.batchLabel ?? null;
  const batchDescription = items.find((i) => i.batchDescription && i.batchDescription.trim())?.batchDescription ?? null;
  return res.json({
    batchId,
    batchLabel,
    batchDescription,
    total: items.length,
    summary: buildBatchSummary(items),
    items
  });
}));

webDescriptionRouter.get("/bulk/:batchId/summary", asyncHandler(async (req, res) => {
  const batchId = String(req.params.batchId);
  const items = await prisma.bulkProductDescription.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" }
  });
  if (items.length === 0) return res.status(404).json({ error: "Batch nenalezen nebo je prázdný." });
  return res.json({
    batchId,
    summary: buildBatchSummary(items)
  });
}));

webDescriptionRouter.get("/bulk/item/:itemId", asyncHandler(async (req, res) => {
  const itemId = String(req.params.itemId);
  const item = await prisma.bulkProductDescription.findUnique({
    where: { id: itemId }
  });
  if (!item) return res.status(404).json({ error: "Položka nenalezena." });
  return res.json({ item });
}));

webDescriptionRouter.post("/bulk/:batchId/generate", asyncHandler(async (req, res) => {
  const batchId = String(req.params.batchId);
  const parsed = BulkGenerateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const model = (parsed.data.model ?? "").trim() || process.env.OPENAI_MODEL_WEB_DESCRIPTION || "gpt-4.1";
  const regenerateGenerated = parsed.data.regenerateGenerated === true;

  const items = await prisma.bulkProductDescription.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" }
  });
  if (items.length === 0) return res.status(404).json({ error: "Batch nenalezen nebo je prázdný." });

  const results: Array<{ id: string; status: string; error?: string }> = [];
  for (const item of items) {
    const qualityIssues = safeJsonArray(item.issuesJson);
    if (item.status === "generating") {
      results.push({ id: item.id, status: "skipped", error: "already generating" });
      continue;
    }
    if (item.status === "generated" && !regenerateGenerated) {
      results.push({ id: item.id, status: "skipped", error: "already generated" });
      continue;
    }
    if (item.status === "input_incomplete") {
      results.push({ id: item.id, status: "skipped", error: `input_incomplete: ${qualityIssues.join(", ")}` });
      continue;
    }
    const allowedStatus = item.status === "input_ready" || item.status === "failed" || (item.status === "generated" && regenerateGenerated);
    if (!allowedStatus) {
      results.push({ id: item.id, status: "skipped", error: `status_not_allowed: ${item.status}` });
      continue;
    }

    try {
      await prisma.bulkProductDescription.update({
        where: { id: item.id },
        data: { status: "generating", error: null }
      });

      const generated = await generateDescriptionBundle({
        productId: item.sourceProductId,
        variantName: item.name,
        ean: item.ean ?? "",
        productCode: item.productCode ?? "",
        shortDescription: item.sourceShortText ?? item.sourceLongText.slice(0, 280),
        longDescription: item.sourceLongText,
        manufacturer: item.manufacturer ?? "",
        model
      });

      await prisma.bulkProductDescription.update({
        where: { id: item.id },
        data: {
          status: "generated",
          czShortHtml: generated.cz.shortSummaryHtml,
          czLongHtml: generated.cz.longDescriptionHtml,
          czFinalHtml: generated.cz.finalHtml,
          skShortHtml: generated.sk.shortSummaryHtml,
          skLongHtml: generated.sk.longDescriptionHtml,
          skFinalHtml: generated.sk.finalHtml,
          sqlCz: generated.sqlCz,
          sqlSk: generated.sqlSk,
          czPromptTokens: generated.usage.cz.promptTokens,
          czCompletionTokens: generated.usage.cz.completionTokens,
          czTotalTokens: generated.usage.cz.totalTokens,
          czCostUsd: generated.usage.cz.costUsd,
          skPromptTokens: generated.usage.sk.promptTokens,
          skCompletionTokens: generated.usage.sk.completionTokens,
          skTotalTokens: generated.usage.sk.totalTokens,
          skCostUsd: generated.usage.sk.costUsd,
          totalTokens: generated.usage.totalTokens,
          totalCostUsd: generated.usage.totalCostUsd,
          error: null
        }
      });
      results.push({ id: item.id, status: "generated" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown generation error";
      await prisma.bulkProductDescription.update({
        where: { id: item.id },
        data: { status: "failed", error: message }
      });
      results.push({ id: item.id, status: "failed", error: message });
    }
  }

  const refreshed = await prisma.bulkProductDescription.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" }
  });
  return res.json({
    batchId,
    modelUsed: model,
    regenerateGenerated,
    results,
    total: refreshed.length,
    generated: refreshed.filter((r) => r.status === "generated").length,
    failed: refreshed.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    summary: buildBatchSummary(refreshed),
    items: refreshed
  });
}));

webDescriptionRouter.get("/bulk/:batchId/sql", asyncHandler(async (req, res) => {
  const batchId = String(req.params.batchId);
  const items = await prisma.bulkProductDescription.findMany({
    where: { batchId },
    orderBy: { createdAt: "asc" },
    select: {
      sourceProductId: true,
      name: true,
      sqlCz: true,
      sqlSk: true
    }
  });
  if (items.length === 0) return res.status(404).json({ error: "Batch nenalezen nebo je prázdný." });

  const sqlCz = items
    .filter((i) => i.sqlCz)
    .map((i) => `-- product_id=${i.sourceProductId} | ${i.name}\n${i.sqlCz}`)
    .join("\n\n");
  const sqlSk = items
    .filter((i) => i.sqlSk)
    .map((i) => `-- product_id=${i.sourceProductId} | ${i.name}\n${i.sqlSk}`)
    .join("\n\n");
  const sqlCombined = [sqlCz, sqlSk].filter(Boolean).join("\n\n");

  return res.json({
    batchId,
    total: items.length,
    countCz: items.filter((i) => !!i.sqlCz).length,
    countSk: items.filter((i) => !!i.sqlSk).length,
    sqlCz,
    sqlSk,
    sqlCombined
  });
}));

type BundleInput = {
  productId: string;
  variantName: string;
  ean: string;
  productCode: string;
  shortDescription: string;
  longDescription: string;
  manufacturer: string;
  model: string;
};

type UsageWithCost = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
};

async function generateDescriptionBundle(input: BundleInput): Promise<{
  modelUsed: string;
  research: unknown;
  cz: ReturnType<typeof normalizeWebDescriptionOutput>;
  sk: ReturnType<typeof normalizeWebDescriptionOutput>;
  sqlCz: string;
  sqlSk: string;
  usage: {
    cz: UsageWithCost;
    sk: UsageWithCost;
    totalTokens: number;
    totalCostUsd: number;
  };
}> {
  const research = await gatherProductResearch(input);
  const outputResult = await llmClient.generateJsonWithUsage(buildWebDescriptionMessages({
    variantName: input.variantName,
    ean: input.ean,
    productCode: input.productCode,
    shortDescription: input.shortDescription,
    longDescription: input.longDescription,
    manufacturer: input.manufacturer,
    research
  }), input.model);
  const normalized = normalizeWebDescriptionOutput(outputResult.data);

  const skModel = process.env.OPENAI_MODEL_WEB_DESCRIPTION_SK || input.model;
  const skOutputResult = await llmClient.generateJsonWithUsage(buildWebDescriptionSkMessages({
    variantName: input.variantName,
    ean: input.ean,
    productCode: input.productCode,
    manufacturer: input.manufacturer,
    cz: {
      productHeading: normalized.productHeading,
      shortSummaryHtml: normalized.shortSummaryHtml,
      longDescriptionHtml: normalized.longDescriptionHtml,
      packageContentsHtml: normalized.packageContentsHtml,
      keyFeaturesHtml: normalized.keyFeaturesHtml
    }
  }), skModel);
  const skNormalized = normalizeWebDescriptionOutput(skOutputResult.data);

  const sqlCz = buildSqlUpsertStatement({
    productId: input.productId,
    languageId: 1,
    name: input.variantName,
    description: normalized.finalHtml,
    descriptionShort: normalized.shortSummaryHtml
  });
  const sqlSk = buildSqlUpsertStatement({
    productId: input.productId,
    languageId: 2,
    name: skNormalized.productHeading || input.variantName,
    description: skNormalized.finalHtml,
    descriptionShort: skNormalized.shortSummaryHtml
  });

  const czUsage = usageWithCost(outputResult.usage, input.model);
  const skUsage = usageWithCost(skOutputResult.usage, skModel);

  return {
    modelUsed: input.model,
    research,
    cz: normalized,
    sk: skNormalized,
    sqlCz,
    sqlSk,
    usage: {
      cz: czUsage,
      sk: skUsage,
      totalTokens: czUsage.totalTokens + skUsage.totalTokens,
      totalCostUsd: roundUsd(czUsage.costUsd + skUsage.costUsd)
    }
  };
}

function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim().length > 0)) rows.push(row);
      row = [];
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((c) => c.trim().length > 0)) rows.push(row);
  return rows.map((r) => r.map((c) => c.replace(/\u00A0/g, " ").trim()));
}

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function mapCsvRow(headers: string[], cells: string[]): {
  sourceProductId: string;
  name: string;
  productCode: string;
  ean: string;
  manufacturer: string;
  category: string;
  longText: string;
  shortText: string;
} {
  const byKey = (nameVariants: string[]): string => {
    for (const variant of nameVariants) {
      const index = headers.findIndex((h) => h === normalizeHeader(variant));
      if (index >= 0) return cells[index] ?? "";
    }
    return "";
  };

  return {
    sourceProductId: byKey(["ID", "id"]),
    name: byKey(["Název", "Nazev", "name"]),
    productCode: byKey(["Kód produktu", "Kod produktu", "product code"]),
    ean: byKey(["EAN", "ean"]),
    manufacturer: byKey(["Výrobce", "Vyrobce", "Značka", "Znacka", "brand"]),
    category: byKey(["Defaultní kategorie", "Defaultni kategorie", "Kategorie", "category"]),
    longText: byKey(["Dlouhý popis", "Dlouhy popis", "description"]),
    shortText: byKey(["Krátky popis", "Krátký popis", "Kratky popis", "short description"])
  };
}

function evaluateInputQuality(row: {
  sourceProductId: string;
  name: string;
  productCode: string;
  ean: string;
  manufacturer: string;
  longText: string;
  shortText: string;
}): { score: number; issues: string[]; ready: boolean } {
  let score = 100;
  const issues: string[] = [];
  const requiredMissing: string[] = [];
  if (!row.sourceProductId) requiredMissing.push("chybí ID produktu");
  if (!row.name) requiredMissing.push("chybí název");
  if (!row.longText || row.longText.length < 30) requiredMissing.push("chybí nebo je příliš krátký dlouhý popis");
  if (!row.shortText) {
    score -= 12;
    issues.push("chybí krátký popis (vygeneruje se z dlouhého)");
  }
  if (!row.ean) issues.push("EAN není vyplněn (volitelné)");
  if (!row.manufacturer) issues.push("výrobce/brand není vyplněn (volitelné)");
  if (!row.productCode) issues.push("kód produktu není vyplněn (volitelné)");
  score -= requiredMissing.length * 25;
  issues.push(...requiredMissing);
  score = Math.max(0, Math.min(100, score));
  const ready = requiredMissing.length === 0;
  return { score, issues, ready };
}

function safeJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function buildBatchSummary(items: Array<{
  status: string;
  totalCostUsd: number | null;
  totalTokens: number | null;
}>): {
  total: number;
  waiting: number;
  generating: number;
  generated: number;
  failed: number;
  incomplete: number;
  totalCostUsd: number;
  totalTokens: number;
  avgCostPerGeneratedUsd: number;
} {
  const summary = {
    total: items.length,
    waiting: 0,
    generating: 0,
    generated: 0,
    failed: 0,
    incomplete: 0,
    totalCostUsd: 0,
    totalTokens: 0
  };
  for (const item of items) {
    if (item.status === "input_ready") summary.waiting += 1;
    if (item.status === "generating") summary.generating += 1;
    if (item.status === "generated") summary.generated += 1;
    if (item.status === "failed") summary.failed += 1;
    if (item.status === "input_incomplete") summary.incomplete += 1;
    summary.totalCostUsd += Number(item.totalCostUsd ?? 0);
    summary.totalTokens += Number(item.totalTokens ?? 0);
  }
  return {
    ...summary,
    totalCostUsd: roundUsd(summary.totalCostUsd),
    avgCostPerGeneratedUsd: summary.generated > 0
      ? roundUsd(summary.totalCostUsd / summary.generated)
      : 0
  };
}

function usageWithCost(usage: LlmUsage | null, model: string): UsageWithCost {
  const promptTokens = Number(usage?.promptTokens ?? 0);
  const completionTokens = Number(usage?.completionTokens ?? 0);
  const totalTokens = Number(usage?.totalTokens ?? promptTokens + completionTokens);
  const rates = getModelRatesUsdPer1M(model);
  const costUsd = ((promptTokens / 1_000_000) * rates.inputUsdPer1M) + ((completionTokens / 1_000_000) * rates.outputUsdPer1M);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd: roundUsd(costUsd)
  };
}

function modelEnvKey(model: string): string {
  return model.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function getModelRatesUsdPer1M(model: string): { inputUsdPer1M: number; outputUsdPer1M: number } {
  const key = modelEnvKey(model);
  const envInput = Number(process.env[`OPENAI_PRICE_${key}_INPUT_PER_1M`] ?? "");
  const envOutput = Number(process.env[`OPENAI_PRICE_${key}_OUTPUT_PER_1M`] ?? "");
  if (Number.isFinite(envInput) && envInput > 0 && Number.isFinite(envOutput) && envOutput > 0) {
    return { inputUsdPer1M: envInput, outputUsdPer1M: envOutput };
  }
  if (model === "gpt-4.1") return { inputUsdPer1M: 2.0, outputUsdPer1M: 8.0 };
  if (model === "gpt-4.1-mini") return { inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 };
  if (model === "gpt-4.1-nano") return { inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 };
  return { inputUsdPer1M: 1.0, outputUsdPer1M: 4.0 };
}

function roundUsd(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}

function normalizeWebDescriptionOutput(raw: unknown): {
  productHeading: string;
  shortSummaryHtml: string;
  longDescriptionHtml: string;
  packageContentsHtml: string;
  keyFeaturesHtml: string;
  finalHtml: string;
} {
  const o = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const productHeading = normalizeHeading(getString(o.productHeading));
  let shortSummaryHtml = clampShortSummaryHtml(stripUnverifiedClaims(ensureHtmlParagraph(getString(o.shortSummaryHtml))));
  let longDescriptionHtml = enforceLongDescriptionStructure(
    stripUnverifiedClaims(sanitizeLongDescription(ensureHtmlParagraph(getString(o.longDescriptionHtml))))
  );
  const separated = separateShortAndLong(shortSummaryHtml, longDescriptionHtml);
  shortSummaryHtml = separated.shortSummaryHtml;
  longDescriptionHtml = separated.longDescriptionHtml;
  const packageContentsHtml = ensurePackageContentsHtml(getString(o.packageContentsHtml), getString(o.longDescriptionHtml));
  const keyFeaturesHtml = stripUnverifiedClaims(ensureFeaturesHtml(getString(o.keyFeaturesHtml)));
  const finalHtmlRaw = getString(o.finalHtml);

  const finalHtml = applyBootstrapReadabilityClasses(finalHtmlRaw || buildFinalHtml({
    productHeading,
    shortSummaryHtml,
    longDescriptionHtml,
    packageContentsHtml,
    keyFeaturesHtml
  }));

  return {
    productHeading,
    shortSummaryHtml,
    longDescriptionHtml,
    packageContentsHtml,
    keyFeaturesHtml,
    finalHtml
  };
}

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ensureHtmlParagraph(value: string): string {
  if (!value) return "<p>Popis nebyl vygenerován.</p>";
  if (value.includes("<")) return value;
  return `<p>${escapeHtml(value)}</p>`;
}

function ensureFeaturesHtml(value: string): string {
  if (!value) return "<ul><li>Klíčové vlastnosti nebyly vygenerovány.</li></ul>";
  if (value.includes("<ul") || value.includes("<ol")) return dedupeListItems(value);
  if (value.includes("<")) return value;
  const items = value
    .split(/\n|,/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (items.length === 0) return "<ul><li>Klíčové vlastnosti nebyly vygenerovány.</li></ul>";
  const deduped = dedupePlainItems(items);
  return `<ul>${deduped.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function clampShortSummaryHtml(value: string): string {
  const textOnly = stripHtml(value).trim();
  if (textOnly.length <= 300) return value;
  const trimmed = textOnly.slice(0, 300);
  const safeCut = trimmed.lastIndexOf(" ") > 220 ? trimmed.slice(0, trimmed.lastIndexOf(" ")) : trimmed;
  return `<p>${escapeHtml(`${safeCut.trim()}...`)}</p>`;
}

function normalizeHeading(value: string): string {
  if (!value) return "Produktový popis";
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

function sanitizeLongDescription(value: string): string {
  if (!value) return "<p>Dlouhý popis nebyl vygenerován.</p>";
  // Enforce rule: no generated images/figures without real URLs.
  let out = value
    .replace(/<figure[\s\S]*?<\/figure>/gi, "")
    .replace(/<img[\s\S]*?>/gi, "");
  // Light cleanup for repeated spaces/newlines after tag removals.
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  if (!out) return "<p>Dlouhý popis nebyl vygenerován.</p>";
  return out;
}

function stripUnverifiedClaims(value: string): string {
  if (!value) return value;
  const bannedPatterns: RegExp[] = [
    /\bodoln[ýaéíý\s]+v[uů]?[čc]i\s+vysok[ýé]\s+teplot[áa]m?\b/giu,
    /\bbezpe[čc]n[ée]\s+pou[žz][íi]v[áa]n[íi]\b/giu,
    /\bnaprosto\s+bezpe[čc]n[ée]\b/giu,
    /\bnejlep[šs][íi]\s+volba\b/giu,
    /\bide[áa]ln[íi]\s+pro\s+ka[žz]d[ée]ho\b/giu,
    /\brevolu[čc]n[íi]\s+(produkt|řešení)\b/giu,
    /\bpro\s+ka[žz]dodenn[íi]\s+pou[žz]it[íi]\b/giu,
    /\bka[žz]dodenn[íi]\s+pou[žz]it[íi]\b/giu,
    /\boslav(y|u|ách|ami)\b/giu,
    /\bvhodn[éeý]\s+na\s+oslavy\b/giu,
    /\bpraktick[éeý]\s+(pomocn[íi]k|řešení)\b/giu
  ];

  let out = value;
  for (const pattern of bannedPatterns) {
    out = out.replace(pattern, "");
  }
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1");
  out = out.replace(/<p>\s*<\/p>/g, "").trim();
  return out || "<p>Popis nebyl vygenerován.</p>";
}

function buildFinalHtml(input: {
  productHeading: string;
  shortSummaryHtml: string;
  longDescriptionHtml: string;
  packageContentsHtml: string;
  keyFeaturesHtml: string;
}): string {
  return `
<section class="product-description container-fluid px-0">
  <h2 class="h3 fw-semibold mb-3">${escapeHtml(input.productHeading || "Nadpis produktu")}</h2>
  <div class="product-short-description text-body-secondary mb-3">
    ${input.shortSummaryHtml}
  </div>
  <div class="product-long-description mb-4">
    ${input.longDescriptionHtml}
  </div>
  <div class="product-package-contents mt-4">
    <h3 class="h5 fw-semibold mb-2">Obsah balení</h3>
    ${input.packageContentsHtml}
  </div>
  <div class="product-key-features mt-4">
    <h3 class="h5 fw-semibold mb-2">Hlavní vlastnosti</h3>
    ${input.keyFeaturesHtml}
  </div>
</section>`.trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function separateShortAndLong(shortHtml: string, longHtml: string): {
  shortSummaryHtml: string;
  longDescriptionHtml: string;
} {
  const shortText = stripHtml(shortHtml).trim();
  const longText = stripHtml(longHtml).trim();

  if (!shortText) {
    const firstParagraph = extractParagraphText(longHtml)[0] ?? "";
    const generatedShort = clampShortSummaryHtml(`<p>${escapeHtml(firstParagraph || longText.slice(0, 300))}</p>`);
    const withoutFirst = removeFirstParagraph(longHtml);
    return {
      shortSummaryHtml: generatedShort,
      longDescriptionHtml: withoutFirst || longHtml
    };
  }

  // If short is effectively same as long, force strict split.
  const similarity = textSimilarity(shortText, longText);
  if (similarity > 0.75 || longText.startsWith(shortText)) {
    const firstParagraph = extractParagraphText(longHtml)[0] ?? shortText;
    const generatedShort = clampShortSummaryHtml(`<p>${escapeHtml(firstParagraph)}</p>`);
    const withoutFirst = removeFirstParagraph(longHtml);
    return {
      shortSummaryHtml: generatedShort,
      longDescriptionHtml: withoutFirst || `<p>${escapeHtml(longText)}</p>`
    };
  }

  return { shortSummaryHtml: shortHtml, longDescriptionHtml: longHtml };
}

function removeFirstParagraph(html: string): string {
  return html.replace(/<p[^>]*>[\s\S]*?<\/p>/i, "").trim();
}

function textSimilarity(a: string, b: string): number {
  const aa = new Set(
    a.toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
  const bb = new Set(
    b.toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
  if (aa.size === 0 || bb.size === 0) return 0;
  let inter = 0;
  for (const token of aa) if (bb.has(token)) inter += 1;
  return inter / Math.max(aa.size, bb.size);
}

function buildSqlUpsertStatement(input: {
  productId: string;
  languageId: number;
  name: string;
  description: string;
  descriptionShort: string;
}): string {
  const table = process.env.WEB_DESCRIPTION_SQL_TABLE ?? "product_translation";
  const productIdColumn = process.env.WEB_DESCRIPTION_SQL_PRODUCT_ID_COLUMN ?? "product_id";
  const languageIdColumn = process.env.WEB_DESCRIPTION_SQL_LANGUAGE_ID_COLUMN ?? "language_id";
  const nameColumn = process.env.WEB_DESCRIPTION_SQL_NAME_COLUMN ?? "name";
  const descriptionColumn = process.env.WEB_DESCRIPTION_SQL_LONG_COLUMN ?? "description";
  const shortColumn = process.env.WEB_DESCRIPTION_SQL_SHORT_COLUMN ?? "description_short";

  return `INSERT INTO ${table} (
  ${productIdColumn},
  ${languageIdColumn},
  ${nameColumn},
  ${descriptionColumn},
  ${shortColumn}
) VALUES (
  ${toSqlString(input.productId)},
  ${input.languageId},
  ${toSqlString(input.name)},
  ${toSqlString(input.description)},
  ${toSqlString(input.descriptionShort)}
)
ON DUPLICATE KEY UPDATE
  ${nameColumn} = VALUES(${nameColumn}),
  ${descriptionColumn} = VALUES(${descriptionColumn}),
  ${shortColumn} = VALUES(${shortColumn});`;
}

function toSqlString(value: string): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function enforceLongDescriptionStructure(value: string): string {
  const paragraphs = dedupeParagraphsByPurpose(extractParagraphText(value).map(polishParagraphText));
  if (paragraphs.length >= 4) {
    return paragraphs
      .slice(0, 4)
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join("\n");
  }

  const plain = stripHtml(value).trim();
  if (!plain) return "<p>Podrobný popis nebyl vygenerován.</p>";
  const sentences = plain.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = chunkIntoParagraphs(sentences.length > 0 ? sentences : [plain], 4).map(polishParagraphText);
  return chunks
    .map((chunk) => `<p>${escapeHtml(chunk)}</p>`)
    .join("\n");
}

function ensurePackageContentsHtml(value: string, longDescriptionSource: string): string {
  const fromValue = value.trim();
  if (fromValue) {
    if (fromValue.includes("<ul") || fromValue.includes("<ol")) return fromValue;
    const items = fromValue.split(/\n|,/).map((v) => v.trim()).filter(Boolean);
    return items.length ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : "<ul><li>Obsah balení není uveden.</li></ul>";
  }

  const plain = stripHtml(longDescriptionSource);
  const match = plain.match(/obsah\s*balen[ií]\s*[:\-]\s*(.+)$/i);
  if (match && match[1]) {
    const items = match[1].split(/,|;/).map((v) => v.trim()).filter(Boolean).slice(0, 12);
    if (items.length) return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
  }
  return "<ul><li>Obsah balení není uveden.</li></ul>";
}

function extractParagraphText(html: string): string[] {
  const out: string[] = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(html)) !== null) {
    const text = stripHtml(m[1]).trim();
    if (text) out.push(text);
  }
  return out;
}

function chunkIntoParagraphs(sentences: string[], target: number): string[] {
  const chunks: string[] = [];
  const base = Math.max(1, Math.ceil(sentences.length / target));
  for (let i = 0; i < sentences.length; i += base) {
    chunks.push(sentences.slice(i, i + base).join(" ").trim());
  }
  while (chunks.length < target) {
    chunks.push(chunks[chunks.length - 1] || sentences.join(" "));
  }
  return chunks.slice(0, target);
}

function polishParagraphText(text: string): string {
  let out = text.trim();
  out = removeConsecutiveRepeatedWords(out);
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

function removeConsecutiveRepeatedWords(text: string): string {
  // Remove immediate duplicates like "sada sada", "produkt produkt"
  return text.replace(/\b([\p{L}\p{N}-]{2,})\s+\1\b/giu, "$1");
}

function dedupeParagraphsByPurpose(paragraphs: string[]): string[] {
  const out: string[] = [];
  const signatures: string[] = [];
  for (const paragraph of paragraphs) {
    const sig = paragraphSignature(paragraph);
    if (!sig) continue;
    if (signatures.some((s) => s === sig || similarityScore(s, sig) > 0.75)) continue;
    signatures.push(sig);
    out.push(paragraph);
  }
  return out;
}

function paragraphSignature(text: string): string {
  return stripHtml(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 18)
    .join(" ");
}

function similarityScore(a: string, b: string): number {
  const aa = new Set(a.split(" ").filter(Boolean));
  const bb = new Set(b.split(" ").filter(Boolean));
  if (aa.size === 0 || bb.size === 0) return 0;
  let intersection = 0;
  for (const token of aa) {
    if (bb.has(token)) intersection += 1;
  }
  return intersection / Math.max(aa.size, bb.size);
}

function applyBootstrapReadabilityClasses(html: string): string {
  let out = html;
  out = addClassWhenMissing(out, "p", "mb-3");
  out = addClassWhenMissing(out, "ul", "mb-3 ps-3");
  out = addClassWhenMissing(out, "ol", "mb-3 ps-3");
  out = addClassWhenMissing(out, "li", "mb-1");
  out = addClassWhenMissing(out, "h2", "h4 fw-semibold mt-4 mb-2");
  out = addClassWhenMissing(out, "h3", "h5 fw-semibold mt-3 mb-2");
  out = addClassWhenMissing(out, "table", "table table-sm table-striped align-middle my-3");
  out = addClassWhenMissing(out, "blockquote", "blockquote border-start ps-3 my-3");
  return out;
}

function addClassWhenMissing(html: string, tag: string, className: string): string {
  const re = new RegExp(`<${tag}([^>]*)>`, "gi");
  return html.replace(re, (full, attrsRaw: string) => {
    const attrs = attrsRaw || "";
    if (/class\s*=/.test(attrs)) return full;
    return `<${tag}${attrs} class="${className}">`;
  });
}

function dedupePlainItems(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

function dedupeListItems(html: string): string {
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  const extracted: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = liRegex.exec(html)) !== null) {
    const text = stripHtml(match[1]).trim();
    if (text) extracted.push(text);
  }
  const deduped = dedupePlainItems(extracted).slice(0, 12);
  if (deduped.length === 0) return "<ul><li>Klíčové vlastnosti nebyly vygenerovány.</li></ul>";
  return `<ul>${deduped.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}
