type RawIdea = {
  topic?: string;
  keywords?: unknown;
  [key: string]: unknown;
};

type KeywordMetric = {
  keyword: string;
  monthlySearchVolume: number | null;
  competition: string | null;
  competitionIndex: number | null;
  cpcUsd: number | null;
};

type EnrichMeta = {
  provider: "google_ads" | "disabled" | "error";
  location: string;
  language: string;
  matchedKeywords: number;
  note?: string;
};

type EnrichResponse = {
  ideas: RawIdea[];
  keywordMetrics: EnrichMeta;
};

const DEFAULT_LOCATION = process.env.KEYWORD_LOCATION_NAME ?? "Czechia (2203)";
const DEFAULT_LANGUAGE = process.env.KEYWORD_LANGUAGE_NAME ?? "Czech (1029)";
const DEFAULT_GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION ?? "v19";

export async function enrichIdeasWithKeywordMetrics(rawIdeas: unknown): Promise<EnrichResponse> {
  const ideas = Array.isArray(rawIdeas) ? rawIdeas.filter((v) => v && typeof v === "object") as RawIdea[] : [];
  if (ideas.length === 0) {
    return {
      ideas: [],
      keywordMetrics: {
        provider: "disabled",
        location: DEFAULT_LOCATION,
        language: DEFAULT_LANGUAGE,
        matchedKeywords: 0,
        note: "No ideas to enrich"
      }
    };
  }

  const config = loadGoogleAdsConfig();
  if (!config) {
    return {
      ideas,
      keywordMetrics: {
        provider: "disabled",
        location: DEFAULT_LOCATION,
        language: DEFAULT_LANGUAGE,
        matchedKeywords: 0,
        note: "Set GOOGLE_ADS credentials in .env to enable search volume"
      }
    };
  }

  const keywordCandidates = ideas
    .map((idea) => normalizeKeywordCandidate(idea))
    .filter(Boolean) as string[];
  const uniqueKeywords = Array.from(new Set(keywordCandidates)).slice(0, 25);

  if (uniqueKeywords.length === 0) {
    return {
      ideas,
      keywordMetrics: {
        provider: "disabled",
        location: DEFAULT_LOCATION,
        language: DEFAULT_LANGUAGE,
        matchedKeywords: 0,
        note: "No keyword candidates found in ideas"
      }
    };
  }

  try {
    const metricMap = await fetchGoogleAdsVolumes(uniqueKeywords, config);
    const enriched = ideas.map((idea) => {
      const key = normalizeKeywordCandidate(idea);
      const metric = key ? metricMap.get(key) ?? null : null;
      return {
        ...idea,
        seoMetrics: metric
      };
    });

    return {
      ideas: enriched,
      keywordMetrics: {
        provider: "google_ads",
        location: `${config.geoTargetConstantId}`,
        language: `${config.languageConstantId}`,
        matchedKeywords: [...metricMap.values()].filter((m) => m.monthlySearchVolume !== null).length
      }
    };
  } catch {
    return {
      ideas,
      keywordMetrics: {
        provider: "error",
        location: DEFAULT_LOCATION,
        language: DEFAULT_LANGUAGE,
        matchedKeywords: 0,
        note: "Google Ads API request failed"
      }
    };
  }
}

function normalizeKeywordCandidate(idea: RawIdea): string {
  const keywords = Array.isArray(idea.keywords)
    ? idea.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];
  const firstKeyword = keywords[0];
  if (firstKeyword) return firstKeyword.toLowerCase();
  const topic = String(idea.topic ?? "").trim().toLowerCase();
  return topic;
}

type GoogleAdsConfig = {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId?: string;
  languageConstantId: string;
  geoTargetConstantId: string;
  apiVersion: string;
};

function loadGoogleAdsConfig(): GoogleAdsConfig | null {
  const developerToken = (process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "").trim();
  const clientId = (process.env.GOOGLE_ADS_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_ADS_CLIENT_SECRET ?? "").trim();
  const refreshToken = (process.env.GOOGLE_ADS_REFRESH_TOKEN ?? "").trim();
  const customerId = normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID ?? "");
  const loginCustomerIdRaw = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "").trim();
  const loginCustomerId = loginCustomerIdRaw ? normalizeCustomerId(loginCustomerIdRaw) : undefined;
  const languageConstantId = (process.env.GOOGLE_ADS_LANGUAGE_CONSTANT_ID ?? "1029").trim();
  const geoTargetConstantId = (process.env.GOOGLE_ADS_GEO_TARGET_CONSTANT_ID ?? "2203").trim();
  const apiVersion = (process.env.GOOGLE_ADS_API_VERSION ?? DEFAULT_GOOGLE_ADS_API_VERSION).trim();

  if (!developerToken || !clientId || !clientSecret || !refreshToken || !customerId) return null;
  return {
    developerToken,
    clientId,
    clientSecret,
    refreshToken,
    customerId,
    loginCustomerId,
    languageConstantId,
    geoTargetConstantId,
    apiVersion
  };
}

function normalizeCustomerId(value: string): string {
  return value.replaceAll("-", "").trim();
}

async function fetchGoogleAdsVolumes(keywords: string[], config: GoogleAdsConfig): Promise<Map<string, KeywordMetric>> {
  const token = await fetchGoogleAccessToken(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`https://googleads.googleapis.com/${config.apiVersion}/customers/${config.customerId}:generateKeywordHistoricalMetrics`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "developer-token": config.developerToken,
        ...(config.loginCustomerId ? { "login-customer-id": config.loginCustomerId } : {})
      },
      body: JSON.stringify({
        keywords,
        language: `languageConstants/${config.languageConstantId}`,
        geoTargetConstants: [`geoTargetConstants/${config.geoTargetConstantId}`],
        keywordPlanNetwork: "GOOGLE_SEARCH_AND_PARTNERS"
      }),
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`Google Ads HTTP ${response.status}`);
    const data = await response.json() as {
      results?: Array<{
        text?: string;
        keywordMetrics?: {
          avgMonthlySearches?: number;
          competition?: string;
          competitionIndex?: number;
          lowTopOfPageBidMicros?: string | number;
          highTopOfPageBidMicros?: string | number;
        };
      }>;
    };

    const map = new Map<string, KeywordMetric>();
    const items = data.results ?? [];
    for (const item of items) {
      const keyword = String(item.text ?? "").trim().toLowerCase();
      if (!keyword) continue;
      const metrics = item.keywordMetrics ?? {};
      const lowBidMicros = parseMicros(metrics.lowTopOfPageBidMicros);
      const highBidMicros = parseMicros(metrics.highTopOfPageBidMicros);
      const avgBidMicros = lowBidMicros !== null && highBidMicros !== null
        ? (lowBidMicros + highBidMicros) / 2
        : (lowBidMicros ?? highBidMicros);
      const avgBidCurrency = avgBidMicros !== null ? avgBidMicros / 1_000_000 : null;

      map.set(keyword, {
        keyword,
        monthlySearchVolume: typeof metrics.avgMonthlySearches === "number" ? metrics.avgMonthlySearches : null,
        competition: typeof metrics.competition === "string" ? metrics.competition : null,
        competitionIndex: typeof metrics.competitionIndex === "number" ? metrics.competitionIndex : null,
        cpcUsd: avgBidCurrency
      });
    }
    return map;
  } finally {
    clearTimeout(timeout);
  }
}

function parseMicros(value: string | number | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchGoogleAccessToken(config: GoogleAdsConfig): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`OAuth HTTP ${response.status}`);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("OAuth access token missing");
  return payload.access_token;
}
