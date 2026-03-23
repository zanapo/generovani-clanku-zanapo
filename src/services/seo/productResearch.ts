type ProductResearchInput = {
  variantName: string;
  manufacturer: string;
  ean: string;
  productCode: string;
  shortDescription?: string;
  longDescription?: string;
};

export type ProductResearchResult = {
  queriesTried: string[];
  snippets: string[];
  sources: Array<{ title: string; url: string }>;
  note?: string;
};

type DuckDuckGoResponse = {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: Array<{
    FirstURL?: string;
    Text?: string;
    Topics?: Array<{ FirstURL?: string; Text?: string }>;
  }>;
};

type SerpItem = { title: string; url: string; snippet: string };

type RelevanceProfile = {
  strongTokens: string[];
  weakTokens: string[];
};

type IdentityProfile = {
  eanDigits: string;
  productCode: string;
  manufacturer: string;
  strongNameTokens: string[];
  normalizedVariant: string;
};

const GOOGLE_SEARCH_API_KEY = (process.env.GOOGLE_SEARCH_API_KEY ?? "").trim();
const GOOGLE_SEARCH_CX = (process.env.GOOGLE_SEARCH_CX ?? "").trim();
const GOOGLE_SEARCH_ENABLED = Boolean(GOOGLE_SEARCH_API_KEY && GOOGLE_SEARCH_CX);

export async function gatherProductResearch(input: ProductResearchInput): Promise<ProductResearchResult> {
  const queries = buildQueries(input);
  const relevance = createRelevanceProfile(input);
  const identity = createIdentityProfile(input);
  const snippets: string[] = [];
  const sources: Array<{ title: string; url: string }> = [];
  const seenUrls = new Set<string>();

  for (const query of queries) {
    const [googleSerp, instant, serp] = await Promise.all([
      fetchGoogleCustomSearch(query),
      fetchDuckDuckGoInstant(query),
      fetchDuckDuckGoHtml(query)
    ]);

    for (const item of googleSerp.slice(0, 6)) {
      const combined = `${item.title} ${item.snippet}`.trim();
      if (item.snippet && isVerifiedProductEvidence(combined, identity, relevance)) snippets.push(item.snippet);
      if (item.url) {
        sources.push({ title: item.title || query, url: item.url });
        seenUrls.add(item.url);
      }
    }

    if (instant?.AbstractText && isVerifiedProductEvidence(instant.AbstractText, identity, relevance)) {
      snippets.push(instant.AbstractText);
      const url = normalizeDuckDuckGoLink(instant.AbstractURL ?? "");
      if (url) {
        sources.push({ title: instant.Heading || query, url });
        seenUrls.add(url);
      }
    }

    for (const item of flattenRelatedTopics(instant?.RelatedTopics ?? []).slice(0, 3)) {
      if (item.Text && isVerifiedProductEvidence(item.Text, identity, relevance)) snippets.push(item.Text);
      const url = normalizeDuckDuckGoLink(item.FirstURL ?? "");
      if (url) {
        sources.push({ title: item.Text || query, url });
        seenUrls.add(url);
      }
    }

    for (const item of serp.slice(0, 5)) {
      const combined = `${item.title} ${item.snippet}`.trim();
      if (item.snippet && isVerifiedProductEvidence(combined, identity, relevance)) snippets.push(item.snippet);
      if (item.url) {
        sources.push({ title: item.title || query, url: item.url });
        seenUrls.add(item.url);
      }
    }
  }

  if (snippets.length < 2) {
    for (const url of uniqueByUrl(sources).map((s) => s.url).slice(0, 6)) {
      const pageText = await fetchPageText(url);
      if (!pageText) continue;
      if (!isVerifiedProductEvidence(pageText, identity, relevance)) continue;
      snippets.push(buildEvidenceSnippet(pageText, identity));
      if (snippets.length >= 4) break;
    }
  }

  const wiki = await fetchWikipediaResearch(input);
  for (const snippet of wiki.snippets) {
    if (isVerifiedProductEvidence(snippet, identity, relevance)) snippets.push(snippet);
  }
  for (const source of wiki.sources) {
    const normalizedUrl = normalizeDuckDuckGoLink(source.url);
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);
    sources.push({ title: source.title, url: normalizedUrl });
  }

  const uniqueSnippets = unique(snippets).map(cleanText).filter(Boolean).slice(0, 10);
  const uniqueSources = uniqueByUrl(sources).slice(0, 8);

  if (uniqueSnippets.length === 0) {
    return {
      queriesTried: queries,
      snippets: buildInputBasedFallback(input),
      sources: uniqueSources,
      note: GOOGLE_SEARCH_ENABLED
        ? "Externí zdroje neobsahovaly ověřenou shodu přes EAN/název produktu, použity pouze vstupní informace."
        : "Google Search API není nakonfigurované. Externí zdroje neobsahovaly ověřenou shodu přes EAN/název produktu, použity pouze vstupní informace."
    };
  }

  return {
    queriesTried: queries,
    snippets: uniqueSnippets,
    sources: uniqueSources,
    note: "Použity pouze externí poznatky s ověřenou shodou produktu (EAN nebo název)."
  };
}

async function fetchGoogleCustomSearch(query: string): Promise<SerpItem[]> {
  if (!GOOGLE_SEARCH_ENABLED) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", GOOGLE_SEARCH_API_KEY);
    url.searchParams.set("cx", GOOGLE_SEARCH_CX);
    url.searchParams.set("q", query);
    url.searchParams.set("num", "5");
    url.searchParams.set("hl", "cs");
    url.searchParams.set("gl", "cz");

    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json() as {
      items?: Array<{ title?: string; link?: string; snippet?: string }>;
    };
    return (data.items ?? [])
      .map((item) => ({
        title: cleanText(item.title ?? ""),
        url: normalizeDuckDuckGoLink(item.link ?? ""),
        snippet: cleanText(item.snippet ?? "")
      }))
      .filter((item) => item.url);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function createIdentityProfile(input: ProductResearchInput): IdentityProfile {
  return {
    eanDigits: (input.ean ?? "").replace(/\D/g, ""),
    productCode: normalizeToken(input.productCode || ""),
    manufacturer: normalizeToken(input.manufacturer || ""),
    strongNameTokens: tokenize(input.variantName).filter((t) => t.length >= 4),
    normalizedVariant: normalizeToken(input.variantName || "")
  };
}

function isVerifiedProductEvidence(text: string, identity: IdentityProfile, relevance: RelevanceProfile): boolean {
  const normalized = normalizeToken(text);
  if (!normalized) return false;

  if (identity.eanDigits && normalized.replace(/\D/g, "").includes(identity.eanDigits)) return true;
  if (identity.productCode && normalized.includes(identity.productCode)) return true;

  const strongHits = identity.strongNameTokens.filter((t) => normalized.includes(t)).length;
  const hasManufacturer = identity.manufacturer ? normalized.includes(identity.manufacturer) : false;
  if (strongHits >= 2 && hasManufacturer) return true;
  if (identity.normalizedVariant && normalized.includes(identity.normalizedVariant)) return true;

  const relevanceHits = relevance.strongTokens.filter((token) => normalized.includes(token)).length;
  return relevanceHits >= 3 && hasManufacturer;
}

function buildQueries(input: ProductResearchInput): string[] {
  const context = extractContextHint(input);
  const byName = `${input.variantName} ${input.manufacturer}`.trim();
  const byNameWithContext = `${input.variantName} ${input.manufacturer} ${context}`.trim();
  const byEan = `${input.variantName} EAN ${input.ean} ${context}`.trim();
  const byCode = `${input.productCode} ${input.manufacturer}`.trim();
  const exactEan = input.ean.trim() ? `"${input.ean.trim()}"` : "";
  const exactCode = input.productCode.trim() ? `"${input.productCode.trim()}" ${input.manufacturer}`.trim() : "";
  const exactVariant = input.variantName.trim() ? `"${input.variantName.trim()}" ${input.manufacturer}`.trim() : "";
  return unique([byNameWithContext, byName, byEan, byCode, exactEan, exactCode, exactVariant]).filter(Boolean);
}

async function fetchDuckDuckGoInstant(query: string): Promise<DuckDuckGoResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json() as DuckDuckGoResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDuckDuckGoHtml(query: string): Promise<SerpItem[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ZanapoBot/1.0)" }
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseDuckDuckGoHtmlResults(html);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function parseDuckDuckGoHtmlResults(html: string): SerpItem[] {
  const results: SerpItem[] = [];
  const blocks = html.split('class="result"');
  for (const block of blocks) {
    if (results.length >= 8) break;
    const rawUrl = extractFirst(block, /class="result__a"[^>]*href="([^"]+)"/i);
    const url = normalizeDuckDuckGoLink(rawUrl);
    const title = decodeHtml(extractFirst(block, /class="result__a"[^>]*>([\s\S]*?)<\/a>/i));
    const snippet = decodeHtml(
      extractFirst(block, /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) ||
      extractFirst(block, /class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)
    );
    if (!url) continue;
    results.push({
      title: cleanText(stripTags(title)),
      url,
      snippet: cleanText(stripTags(snippet))
    });
  }
  return results;
}

async function fetchPageText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ZanapoBot/1.0)" }
    });
    if (!res.ok) return "";
    const html = await res.text();
    const withoutScripts = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ");
    return cleanText(stripTags(withoutScripts)).slice(0, 8000);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function buildEvidenceSnippet(pageText: string, identity: IdentityProfile): string {
  if (identity.eanDigits && pageText.includes(identity.eanDigits)) {
    return `Ověřená shoda produktu dle EAN ${identity.eanDigits} v externím zdroji.`;
  }
  if (identity.productCode && pageText.toLowerCase().includes(identity.productCode)) {
    return `Ověřená shoda produktu dle kódu ${identity.productCode}.`;
  }
  return "Externí zdroj obsahuje silnou shodu názvu varianty a výrobce produktu.";
}

async function fetchWikipediaResearch(input: ProductResearchInput): Promise<{ snippets: string[]; sources: Array<{ title: string; url: string }> }> {
  const terms = unique([input.variantName, `${input.manufacturer} ${input.variantName}`.trim()]).slice(0, 3);
  const snippets: string[] = [];
  const sources: Array<{ title: string; url: string }> = [];
  for (const term of terms) {
    const title = await searchWikipediaTitle(term);
    if (!title) continue;
    const summary = await fetchWikipediaSummary(title);
    if (!summary) continue;
    if (summary.extract) snippets.push(summary.extract);
    if (summary.url) sources.push({ title: summary.title || title, url: summary.url });
  }
  return { snippets, sources };
}

async function searchWikipediaTitle(term: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const url = `https://cs.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(term)}&limit=1&namespace=0&format=json`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return "";
    const data = await res.json() as [string, string[]];
    return data?.[1]?.[0] ?? "";
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWikipediaSummary(title: string): Promise<{ title: string; extract: string; url: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const url = `https://cs.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json() as {
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    return {
      title: data.title ?? title,
      extract: data.extract ?? "",
      url: data.content_urls?.desktop?.page ?? ""
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildInputBasedFallback(input: ProductResearchInput): string[] {
  const out: string[] = [];
  if (input.variantName.trim()) out.push(`Název varianty: ${input.variantName.trim()}.`);
  if (input.manufacturer.trim()) out.push(`Výrobce: ${input.manufacturer.trim()}.`);
  if (input.ean.trim()) out.push(`EAN: ${input.ean.trim()}.`);
  if (input.productCode.trim()) out.push(`Kód produktu: ${input.productCode.trim()}.`);
  out.push("Použij pouze ověřitelné informace ze vstupu produktu, bez cizích domněnek.");
  return out.slice(0, 6);
}

function createRelevanceProfile(input: ProductResearchInput): RelevanceProfile {
  const manufacturer = normalizeToken(input.manufacturer);
  const variantTokens = tokenize(input.variantName).filter((t) => t.length >= 4 && t !== manufacturer);
  const descTokens = tokenize(`${input.shortDescription ?? ""} ${input.longDescription ?? ""}`)
    .filter((t) => t.length >= 5)
    .slice(0, 20);
  const weakTokens = unique([manufacturer, ...descTokens.filter((t) => !variantTokens.includes(t))]).filter(Boolean);
  return { strongTokens: unique(variantTokens), weakTokens };
}

function extractContextHint(input: ProductResearchInput): string {
  const ctx = `${input.shortDescription ?? ""} ${input.longDescription ?? ""}`.toLowerCase();
  if (ctx.includes("deskov")) return "desková hra";
  if (ctx.includes("hrač")) return "hračka";
  if (ctx.includes("puzzle")) return "puzzle";
  if (ctx.includes("staveb")) return "stavebnice";
  return "produkt";
}

function flattenRelatedTopics(items: DuckDuckGoResponse["RelatedTopics"]): Array<{ FirstURL?: string; Text?: string }> {
  const out: Array<{ FirstURL?: string; Text?: string }> = [];
  for (const item of items ?? []) {
    if (item.FirstURL || item.Text) out.push({ FirstURL: item.FirstURL, Text: item.Text });
    if (Array.isArray(item.Topics)) {
      for (const nested of item.Topics) {
        if (nested.FirstURL || nested.Text) out.push({ FirstURL: nested.FirstURL, Text: nested.Text });
      }
    }
  }
  return out;
}

function extractFirst(text: string, re: RegExp): string {
  const m = re.exec(text);
  return m?.[1] ?? "";
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function normalizeDuckDuckGoLink(url: string): string {
  const clean = decodeHtml((url || "").trim());
  if (!clean) return "";
  if (clean.startsWith("//duckduckgo.com/l/?")) {
    try {
      const u = new URL(`https:${clean}`);
      const target = u.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    } catch {
      return `https:${clean}`;
    }
  }
  if (clean.startsWith("//")) return `https:${clean}`;
  return clean;
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return unique(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function uniqueByUrl(values: Array<{ title: string; url: string }>): Array<{ title: string; url: string }> {
  const map = new Map<string, { title: string; url: string }>();
  for (const item of values) {
    const url = item.url.trim();
    if (!url) continue;
    if (!map.has(url)) map.set(url, item);
  }
  return [...map.values()];
}
