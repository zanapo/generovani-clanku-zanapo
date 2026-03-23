import "dotenv/config";
import { Worker } from "bullmq";
import { prisma } from "../db/prisma.js";
import { llmClient } from "../services/llm/LlmClient.js";
import {
  buildAgentMessages,
  buildDeepResearchMessages,
  buildEditorMessages,
  buildFinalPackagerMessages,
  buildHtmlValidatorMessages,
  buildOutlineMessages
} from "../services/llm/prompt.js";
import type { BusinessFields } from "../services/llm/prompt.js";
import { slugify } from "../services/slugify.js";
import { validateArticleOutput, validateArticleOutputRules } from "../services/validateArticle.js";
import { MANUAL_STAGES } from "../services/agents/stages.js";
import { resolveModelForStage } from "../services/llm/modelPlan.js";
import type { ArticleOutput } from "../services/validateArticle.js";
import type { ManualStage } from "../services/agents/stages.js";

const connection = {
  url: process.env.REDIS_URL ?? "redis://localhost:6379"
};

new Worker(
  "article-generation",
  async (job) => {
    const { articleId, stage, model } = job.data as { articleId: string; stage?: ManualStage; model?: string };
    const targetStage = stage ?? "final_packager";
    const isFullPipelineJob = job.name === "generate" || job.name === "regenerate";

    try {
      await prisma.article.update({
        where: { id: articleId },
        data: { status: "generating", error: null }
      });

      const article = await prisma.article.findUnique({ where: { id: articleId } });
      if (!article) throw new Error("Article not found");

      const links = article.linksJson ? (JSON.parse(article.linksJson) as Array<{ href: string; anchor: string }>) : [];
      const businessFields = article.briefJson ? (JSON.parse(article.briefJson) as BusinessFields) : {};
      let versionId: string | undefined;
      let finalStatus = "created";

      if (targetStage === "final_packager" && isFullPipelineJob) {
        const baseRun = await createRun(articleId, targetStage);
        await markRun(baseRun.id, "generating");

        const deep = await runStage(articleId, "deep_research", article, links, businessFields, undefined, model);
        const outline = await runStage(articleId, "outline_planner", article, links, businessFields, deep.outputJson, model);
        const draft = await runStage(articleId, "content_writer", article, links, businessFields, outline.outputJson, model);
        const seo = await runStage(articleId, "seo_editor", article, links, businessFields, draft.outputJson, model);
        const htmlChecked = await runStage(articleId, "html_validator", article, links, businessFields, seo.outputJson, model);
        const packed = await runStage(articleId, "final_packager", article, links, businessFields, htmlChecked.outputJson, model);
        const parsed = validateArticleOutput(packed.outputJson);
        const normalized = normalizeFinalArticle(parsed, article.topic);

        const version = await saveArticleVersion(articleId, resolveModelForStage("final_packager"), normalized);
        versionId = version.id;
        finalStatus = "done";
        await markRun(baseRun.id, "done", { versionId });
      } else if (targetStage === "final_packager") {
        const packed = await runStage(articleId, "final_packager", article, links, businessFields, undefined, model);
        const parsed = validateArticleOutput(packed.outputJson);
        const normalized = normalizeFinalArticle(parsed, article.topic);
        const version = await saveArticleVersion(articleId, resolveModelForStage("final_packager"), normalized);
        versionId = version.id;
        finalStatus = "done";
      } else if (MANUAL_STAGES.includes(targetStage)) {
        await runStage(articleId, targetStage, article, links, businessFields, undefined, model);
      } else {
        throw new Error(`Unsupported stage: ${String(targetStage)}`);
      }

      await prisma.article.update({
        where: { id: articleId },
        data: { status: finalStatus, error: null }
      });

      return { ok: true, stage: targetStage, versionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown worker error";
      await prisma.article.update({
        where: { id: articleId },
        data: { status: "failed", error: message }
      });
      throw error;
    }
  },
  { connection }
);

async function createRun(articleId: string, stage: ManualStage) {
  return prisma.articleAgentRun.create({
    data: { articleId, stage, status: "queued" }
  });
}

async function markRun(id: string, status: string, output?: unknown, error?: string, input?: unknown) {
  await prisma.articleAgentRun.update({
    where: { id },
    data: {
      status,
      inputJson: input ? JSON.stringify(input) : undefined,
      outputJson: output ? JSON.stringify(output) : undefined,
      error: error ?? null
    }
  });
}

async function getLatestRunOutput(articleId: string, stage: ManualStage): Promise<unknown | null> {
  const run = await prisma.articleAgentRun.findFirst({
    where: { articleId, stage, status: "done", outputJson: { not: null } },
    orderBy: { createdAt: "desc" }
  });
  return run?.outputJson ? JSON.parse(run.outputJson) : null;
}

async function runStage(
  articleId: string,
  stage: ManualStage,
  article: { topic: string; audience: string | null; keywords: string | null; style: string | null },
  links: Array<{ href: string; anchor: string }>,
  businessFields: BusinessFields,
  overrideInput?: unknown,
  modelOverride?: string
) {
  const run = await createRun(articleId, stage);
  await markRun(run.id, "generating");
  try {
    const inputFromPrev = overrideInput ?? (await resolveStageInput(articleId, stage));
    await markRun(run.id, "generating", undefined, undefined, inputFromPrev);
    const output = await callStageModel(stage, article, links, businessFields, inputFromPrev, modelOverride);
    await markRun(run.id, "done", output, undefined, inputFromPrev);
    return { ...run, outputJson: output };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown stage error";
    await markRun(run.id, "failed", undefined, message);
    throw error;
  }
}

async function resolveStageInput(articleId: string, stage: ManualStage): Promise<unknown> {
  if (stage === "deep_research") return {};
  if (stage === "outline_planner") return (await getLatestRunOutput(articleId, "deep_research")) ?? {};
  if (stage === "content_writer") {
    return {
      research: (await getLatestRunOutput(articleId, "deep_research")) ?? {},
      outline: (await getLatestRunOutput(articleId, "outline_planner")) ?? {}
    };
  }
  if (stage === "seo_editor") return (await getLatestRunOutput(articleId, "content_writer")) ?? {};
  if (stage === "html_validator") return (await getLatestRunOutput(articleId, "seo_editor")) ?? {};
  return (await getLatestRunOutput(articleId, "html_validator")) ?? {};
}

async function callStageModel(
  stage: ManualStage,
  article: { topic: string; audience: string | null; keywords: string | null; style: string | null },
  links: Array<{ href: string; anchor: string }>,
  businessFields: BusinessFields,
  stageInput: unknown,
  modelOverride?: string
): Promise<unknown> {
  const model = modelOverride || resolveModelForStage(stage);
  if (stage === "deep_research") {
    const messages = buildDeepResearchMessages({
      topic: article.topic,
      audience: article.audience ?? "",
      keywords: article.keywords ?? "",
      internalLinks: links,
      businessFields
    });
    return llmClient.generateJson(messages, model);
  }

  if (stage === "outline_planner") {
    const messages = buildOutlineMessages({
      topic: article.topic,
      audience: article.audience ?? "",
      keywords: article.keywords ?? "",
      style: article.style ?? "",
      research: stageInput,
      businessFields
    });
    return llmClient.generateJson(messages, model);
  }

  if (stage === "content_writer") {
    const messages = buildAgentMessages({
      topic: article.topic,
      audience: article.audience ?? "",
      keywords: article.keywords ?? "",
      style: article.style ?? "",
      internalLinks: links,
      businessFields
    });
    return llmClient.generateJson(messages, model);
  }

  if (stage === "seo_editor") {
    const messages = buildEditorMessages({
      topic: article.topic,
      audience: article.audience ?? "",
      keywords: article.keywords ?? "",
      style: article.style ?? "",
      internalLinks: links,
      businessFields,
      draft: stageInput
    });
    return llmClient.generateJson(messages, model);
  }

  if (stage === "html_validator") {
    const messages = buildHtmlValidatorMessages({ articleJson: stageInput });
    return llmClient.generateJson(messages, model);
  }

  const messages = buildFinalPackagerMessages({ articleJson: stageInput });
  return llmClient.generateJson(messages, model);
}

function normalizeFinalArticle(parsed: ArticleOutput, topic: string): ArticleOutput {
  const withMinimumFaq = ensureMinimumFaq(parsed, topic);
  const withToc = ensureTocSectionInHtml(withMinimumFaq);
  const normalized = ensureFaqSectionInHtml(withToc);
  validateArticleOutputRules(normalized);
  return normalized;
}

async function saveArticleVersion(articleId: string, model: string, article: ArticleOutput) {
  const wordCount = article.wordCount ?? countWords(stripHtml(article.contentHtml));
  const readingTime = article.readingTime ?? Math.max(1, Math.ceil(wordCount / 200));
  const normalizedSlug = slugify(article.slug || article.title);

  return prisma.articleVersion.create({
    data: {
      articleId,
      model,
      promptVersion: "v3-manual-7-agent",
      resultJson: JSON.stringify({ ...article, slug: normalizedSlug, wordCount, readingTime }),
      contentHtml: article.contentHtml,
      contentMarkdown: article.contentMarkdown ?? null,
      metaTitle: article.metaTitle,
      metaDescription: article.metaDescription,
      slug: normalizedSlug,
      readingTime,
      wordCount
    }
  });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

function countWords(value: string): number {
  return value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean).length;
}

function ensureMinimumFaq(parsed: ArticleOutput, topic: string): ArticleOutput {
  if (parsed.faq.length >= 4) return parsed;

  const fallback = [
    {
      q: `Jak vybrat vhodnou variantu pro téma "${topic}"?`,
      a: "Začněte cílem a zkušeností uživatele. Porovnejte 2-3 možnosti a vyberte variantu, která se nejlépe hodí pro běžné použití."
    },
    {
      q: "Jaké chyby jsou při výběru nejčastější?",
      a: "Nejčastější je nákup podle vzhledu bez kontroly parametrů, materiálu a praktického použití. Vyplatí se porovnat vlastnosti předem."
    },
    {
      q: "Je lepší začít jednodušší variantou?",
      a: "Ano, pro začátek je praktičtější zvolit základní, ale kvalitní variantu a až podle zkušeností případně přejít na pokročilejší."
    },
    {
      q: "Jak poznám, že je výběr správný?",
      a: "Správná volba odpovídá dovednostem uživatele, je pohodlná při používání a podporuje pravidelné hraní nebo trénink."
    }
  ];

  const mergedFaq = [...parsed.faq];
  for (const item of fallback) {
    if (mergedFaq.length >= 4) break;
    const exists = mergedFaq.some((faq) => faq.q.trim().toLowerCase() === item.q.trim().toLowerCase());
    if (!exists) mergedFaq.push(item);
  }

  return { ...parsed, faq: mergedFaq.slice(0, 8) };
}

function ensureFaqSectionInHtml(parsed: ArticleOutput): ArticleOutput {
  const hasFaqHeading =
    />\s*FAQ\s*</i.test(parsed.contentHtml) ||
    />\s*Časté otázky\s*</i.test(parsed.contentHtml) ||
    />\s*Často kladené otázky\s*</i.test(parsed.contentHtml);
  if (hasFaqHeading || parsed.faq.length === 0) return parsed;

  const faqHtml = [
    '<h2 id="faq">FAQ</h2>',
    "<dl>",
    ...parsed.faq.slice(0, 8).flatMap((item) => [`<dt>${escapeHtml(item.q)}</dt>`, `<dd>${escapeHtml(item.a)}</dd>`]),
    "</dl>"
  ].join("");

  return { ...parsed, contentHtml: `${parsed.contentHtml}${faqHtml}` };
}

function ensureTocSectionInHtml(parsed: ArticleOutput): ArticleOutput {
  const hasToc =
    />\s*Obsah\s*</i.test(parsed.contentHtml) ||
    /id=["']toc["']/i.test(parsed.contentHtml) ||
    /aria-label=["']obsah["']/i.test(parsed.contentHtml);
  if (hasToc || parsed.outline.length === 0) return parsed;

  const tocItems = parsed.outline
    .map((item) => `<li><a href="#${escapeHtml(item.id)}">${escapeHtml(item.label)}</a></li>`)
    .join("");

  const tocHtml = `<nav id="toc" aria-label="Obsah"><h2>Obsah</h2><ul>${tocItems}</ul></nav>`;

  const h1CloseIndex = parsed.contentHtml.search(/<\/h1>/i);
  if (h1CloseIndex === -1) {
    return { ...parsed, contentHtml: `${tocHtml}${parsed.contentHtml}` };
  }

  const insertPos = h1CloseIndex + 5;
  const contentHtml = `${parsed.contentHtml.slice(0, insertPos)}${tocHtml}${parsed.contentHtml.slice(insertPos)}`;
  return { ...parsed, contentHtml };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
