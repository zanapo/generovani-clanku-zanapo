import { z } from "zod";

const linkSchema = z.object({
  href: z.string().min(1),
  anchor: z.string().min(1)
});

const outlineSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1)
});

const faqSchema = z.object({
  q: z.string().min(1),
  a: z.string().min(1)
});

export const articleOutputSchema = z.object({
  title: z.string().min(5),
  slug: z.string().min(3),
  metaTitle: z.string().min(10),
  metaDescription: z.string().min(20),
  contentHtml: z.string().min(200),
  contentMarkdown: z.string().optional(),
  outline: z.array(outlineSchema).min(3),
  faq: z.array(faqSchema),
  internalLinksUsed: z.array(linkSchema).default([]),
  readingTime: z.number().int().positive().optional(),
  wordCount: z.number().int().positive().optional()
});

export type ArticleOutput = z.infer<typeof articleOutputSchema>;

export function validateArticleOutput(raw: unknown): ArticleOutput {
  return articleOutputSchema.parse(raw);
}

export function validateArticleOutputRules(parsed: ArticleOutput): void {
  const html = parsed.contentHtml;
  const hasH1 = /<h1[\s>]/i.test(html);
  const hasH2 = /<h2[\s>]/i.test(html);
  const hasH3 = /<h3[\s>]/i.test(html);
  const hasTable = /<table[\s>]/i.test(html);
  const hasTocHeading =
    />\s*Obsah\s*</i.test(html) ||
    /id=["']toc["']/i.test(html) ||
    /aria-label=["']obsah["']/i.test(html);
  const hasFaqHeading =
    />\s*FAQ\s*</i.test(html) ||
    />\s*Časté otázky\s*</i.test(html) ||
    />\s*Často kladené otázky\s*</i.test(html) ||
    />\s*Často kladené dotazy\s*</i.test(html);
  const hasFaqBlock = /id=["']faq["']/i.test(html) || /<dl[\s>]/i.test(html);
  const ctaSectionMatch = html.match(/<h2[^>]*>[^<]*(závěr|co dál|cta)[^<]*<\/h2>([\s\S]*?)(<h2[\s>]|$)/i);
  const hasCtaHeading = Boolean(ctaSectionMatch);

  if (!hasH1) throw new Error("Missing H1 in contentHtml");
  if (!hasH2) throw new Error("Missing H2 in contentHtml");
  if (!hasH3) throw new Error("Missing H3 in contentHtml");
  if (!hasTable) throw new Error("Missing <table> in contentHtml");
  if (!hasTocHeading) throw new Error("Missing TOC (Obsah) section in contentHtml");
  if (parsed.faq.length < 4) throw new Error("FAQ must have at least 4 items");
  if (!hasFaqHeading && !hasFaqBlock) throw new Error("Missing FAQ section in contentHtml");
  if (!hasCtaHeading) throw new Error("Missing conclusion/CTA section in contentHtml");

  const htmlLinkHrefs = Array.from(html.matchAll(/<a\s+[^>]*href=["']([^"']+)["']/gi)).map((m) => m[1]);
  const usedLinkHrefs = parsed.internalLinksUsed.map((l) => l.href);

  if (usedLinkHrefs.length === 0) {
    throw new Error("internalLinksUsed must include at least one link");
  }

  const ctaSectionHtml = ctaSectionMatch?.[0] ?? "";
  const hasInternalLinkInHtml = usedLinkHrefs.some((href) => htmlLinkHrefs.includes(href));
  const hasInternalLinkInCta = usedLinkHrefs.some((href) => ctaSectionHtml.includes(`href="${href}"`) || ctaSectionHtml.includes(`href='${href}'`));

  if (!hasInternalLinkInHtml || !hasInternalLinkInCta) {
    throw new Error("CTA must include at least one provided internal link in CTA section");
  }
}
