type Link = { href: string; anchor: string };
export type BusinessFields = {
  businessGoal?: "traffic" | "conversion" | "authority";
  articleType?: "pillar" | "cluster" | "landing-support";
  targetSegments?: string[];
  priorityCategories?: string[];
  requiredInternalLinks?: Array<{ href: string; anchor?: string }>;
  ctaGoal?: string;
  tonePreset?: string;
};

export type LlmMessage = {
  role: "system" | "user";
  content: string;
};

const SHARED_RULES = `Tvrdé požadavky:
- Výstup ve validním HTML (bez JS), kompatibilní s Nette/Latte.
- Musí obsahovat: H1, TOC (obsah s odkazy na sekce), sekce H2/H3, odrážky, minimálně 1 tabulku <table>, FAQ (min 4 otázky), závěr s CTA + interní odkaz(y).
- Používej krátké odstavce, konkrétní rady, žádná vata a žádné obecné fráze bez užitku.
- Přirozené SEO: klíčová slova použij přiměřeně (ne spam).
- Interní odkazy vkládej jako <a href="...">text</a> pouze z poskytnutého seznamu.
- Nesmíš vymýšlet nepravdivá tvrzení. Pokud si nejsi jistý faktem, formuluj to obecně nebo jako doporučení.
- Tabulka musí být užitečná (srovnání, přehled, checklist).
- CTA musí vést na relevantní kategorii nebo výpis (z interních odkazů).
- Každá H2 sekce musí přinést konkrétní hodnotu (postup, rozhodovací kritéria, praktické tipy).`;

const QUALITY_BAR = `Kvalitativní laťka:
- Vyhýbej se generickým frázím typu "buďte konzistentní", pokud nepřidáš konkrétní postup.
- U strategických témat vysvětluj trade-offy (kdy rada platí a kdy ne).
- V textu používej konkrétní koncepty místo školních pouček.
- Obchodní část musí být užitečná: doporuč konkrétní typy produktů (např. turnajové/dřevěné šachy, šachové hodiny, tréninkové pomůcky), ale jen obecně a bez neověřených detailů.
- Pokud chybí interní odkazy na konkrétní produkty, použij alespoň poskytnuté kategorie a napiš jasně, pro koho jsou.`;

const SYSTEM_PROMPT_TOPICS = `Jsi seniorní content stratég pro e-shop Zanapo.cz.
Navrhni témata článků v češtině pro blog o šachách a deskovkách.
Návrhy musí být praktické, SEO použitelné a vhodné pro e-shopový kontext.
Vrať JSON:
{
  "ideas": [
    {
      "topic": "...",
      "audience": "...",
      "keywords": ["...", "..."],
      "whyNow": "...",
      "difficulty": "low|medium|high"
    }
  ]
}
Počet nápadů: 12. Nesmíš vracet nic mimo JSON.`;

const SYSTEM_PROMPT_RESEARCH = `Jsi rešeršní analytik obsahu pro Zanapo.cz.
Pro dané téma připrav deep research podklady, které použije copywriter.
Používej více typů zdrojů: oficiální pravidla/encyklopedie, odborné články, komunitní obsah, e-shopové kategorie.
Nevymýšlej URL.

Vrať JSON:
{
  "searchIntent": "...",
  "readerProblems": ["..."],
  "decisionCriteria": ["..."],
  "angles": ["..."],
  "advancedConcepts": ["..."],
  "faqCandidates": ["..."],
  "pitfalls": ["..."],
  "recommendedInternalLinks": [{"href":"...","anchor":"..."}],
  "sources": [
    {
      "title": "...",
      "url": "...",
      "sourceType": "official|educational|community|commercial",
      "whyRelevant": "..."
    }
  ]
}
Podmínky:
- "sources" musí mít minimálně 8 položek.
- sourceType musí být různorodé (alespoň 3 různé typy).
- Pro šachová témata přidej do "advancedConcepts" termíny jako prophylaxe, iniciativa, pěšcová struktura, izolovaný pěšec, protihra, převod výhody, dynamická vs poziční hra (pokud jsou relevantní).
Nesmíš vracet nic mimo JSON.`;

const SYSTEM_PROMPT_OUTLINE = `Jsi seniorní editor. Vytvoř výbornou osnovu článku.
Vrať JSON:
{
  "outline": [{"id":"...","label":"..."}],
  "sectionGoals": [{"id":"...","goal":"..."}]
}
Osnova musí být logická, praktická a čitelná. Nesmíš vracet nic mimo JSON.`;

const SYSTEM_PROMPT_WRITER = `Jsi seniorní SEO copywriter a editor pro e-shop Zanapo.cz.
Tvůj úkol je napsat kvalitní český blogový článek, který je praktický, čtivý a důvěryhodný.
${SHARED_RULES}
${QUALITY_BAR}

Styl:
- Přátelský, odborný, motivující.
- Přehlednost: seznamy, "tipy", "nejčastější chyby".
- Zaměření: šachy / deskovky / e-shopový kontext (doporučení produktů bez tlačení na cenu).
- Přirozená čeština: aktivní věty, minimum klišé, žádná umělá omáčka.

Doménová hloubka:
- Pokud je téma pokročilé (strategie, repertoár, trénink výkonnosti), přidej sekci "5 konceptů, které oddělují silného hráče od průměrného".
- V takové sekci použij konkrétní koncepty (např. prophylaxe, iniciativa, převod výhody, hra proti slabinám pěšcové struktury, plánování podle struktury).
- Tabulka nesmí být "školní". Musí obsahovat aspoň sloupce "Kdy to funguje", "Typická chyba", "Jak trénovat".

Obchodní užitek pro Zanapo:
- V závěru přidej krátký blok "Co si připravit na trénink" s 2-4 doporučeními typů produktů.
- U každého doporučení uveď komu to pomůže a proč.
- Použij interní odkazy pouze z poskytnutého seznamu.

Vrať JSON se strukturou:
{
  "title": "...",
  "slug": "...",
  "metaTitle": "...",
  "metaDescription": "...",
  "contentHtml": "...",
  "outline": [{"id":"...", "label":"..."}],
  "faq": [{"q":"...", "a":"..."}],
  "internalLinksUsed": [{"href":"...", "anchor":"..."}]
}
Obsah HTML musí obsahovat id atributy pro nadpisy dle outline.
Nesmíš vracet žádný text mimo JSON objekt.`;

const SYSTEM_PROMPT_SEO_EDITOR = `Jsi seniorní editor českého SEO obsahu.
Tvůj úkol: upravit draft článku tak, aby byl výrazně čtivější, přirozenější a praktičtější, ale zachoval stejnou strukturu JSON a všechny tvrdé požadavky.
${QUALITY_BAR}

Editační pravidla:
- Zachovej formát JSON a povinná pole.
- Zachovej validní HTML kompatibilní s Nette/Latte.
- Zachovej H1, TOC, H2/H3, tabulku, FAQ (min 4), závěr s CTA a interními odkazy.
- Zkrať slabá místa, odstraň opakování a klišé.
- Přidej konkrétnější formulace (co vybrat, podle čeho rozhodnout, čemu se vyhnout).
- Nadpisy a odstavce piš přirozenou češtinou pro běžného čtenáře.
- U šachových témat oprav nepřesné zkratky typu "hrajte nepředvídatelně" na přesnější kontextové rady.
- Zlepši tabulku i FAQ tak, aby nesly hodnotu i pro pokročilejší čtenáře.
- Nevymýšlej si neověřitelné fakta.

Nesmíš vracet nic mimo JSON objekt.`;

const SYSTEM_PROMPT_HTML_VALIDATOR = `Jsi HTML/SEO validační editor.
Zkontroluj a oprav JSON článku tak, aby splnil všechny hard requirements.
Nezhorši čtivost textu.
Vrať pouze JSON ve stejné struktuře a oprav jen to, co je nutné.
Nesmíš vracet nic mimo JSON objekt.`;

const SYSTEM_PROMPT_FINAL_PACKAGER = `Jsi finální editor výstupu.
Udělej poslední kontrolu konzistence (title/slug/meta/outline/faq/contentHtml/internalLinksUsed).
Vrať pouze finální JSON bez komentářů.
Nesmíš vracet nic mimo JSON objekt.`;

const SYSTEM_PROMPT_SHOP_DISCOVERY = `Jsi content strategist pro e-shop.
Na základě vstupů o webu (llms.txt, sitemap, URL vzorky) navrhni obsahovou strategii.

Vrať JSON:
{
  "shopSummary": "...",
  "topicCategories": [
    {
      "name": "...",
      "whyRelevant": "...",
      "focusKeywords": ["..."]
    }
  ],
  "topicIdeas": [
    {
      "topic": "...",
      "audience": "...",
      "keywords": ["..."],
      "businessIntent": "traffic|conversion|authority"
    }
  ],
  "seasonalTrendIdeas": [
    {
      "season": "...",
      "topic": "...",
      "whyNow": "..."
    }
  ]
}

Podmínky:
- Minimálně 5 topicCategories.
- Minimálně 12 topicIdeas.
- Minimálně 4 seasonalTrendIdeas.
- Přidej alespoň 1 obecné trendové téma mimo produktové kategorie.
Nesmíš vracet nic mimo JSON.`;

const SYSTEM_PROMPT_WEB_DESCRIPTION = `Jsi seniorní e-commerce copywriter pro český web.
Z dodaných produktových dat vytvoř strukturovaný, marketingově silný a zároveň věcný HTML popisek.
Nejdřív vyhodnoť dohledané veřejné informace o produktu, ale používej je jen pokud dávají smysl a jsou konzistentní se vstupem.

Vrať JSON:
{
  "productHeading": "...",
  "shortSummaryHtml": "...",
  "longDescriptionHtml": "...",
  "packageContentsHtml": "...",
  "keyFeaturesHtml": "...",
  "finalHtml": "..."
}

Povinná struktura výsledného HTML:
- Nadpis produktu
- Krátký popisek se stručnými informacemi
- Dlouhý kreativní popisek (marketingově napsaný, ale realistický pro e-shop)
- Hlavní vlastnosti / klíčové benefity

Pravidla:
- Piš česky, přirozeně, bez vaty.
- Nehalucinuj technické parametry, které nejsou ve vstupu.
- Pokud chybí přesné informace, formuluj benefit obecně.
- Nikdy nepřidávej značku/brand, která není ve vstupních datech.
- Nikdy negeneruj obrázky ani <figure>/<img>, pokud není k dispozici reálná URL obrázku ve vstupu.
- Neopakuj stejné vlastnosti vícekrát.
- Vyhýbej se generickým frázím typu "ideální pro každého".
- První odstavec longDescriptionHtml musí obsahovat hlavní benefit produktu.
- Výstup musí být realistický pro e-shop (ne blog, ne článek).
- Nepřidávej technická tvrzení, pokud nejsou výslovně ve vstupu.
- Nepoužívej formulace jako "odolné vůči vysokým teplotám", "bezpečné používání" ani jiné bezpečnostní/odolnostní claimy bez potvrzení výrobcem.
- Nepiš přehnaně reklamní nebo líbivé věty.
- Popis má být věcný, přirozený a vhodný pro e-shop.
- U kreativních sad zdůrazni tvoření, zábavu a obsah balení.
- Nevymýšlej použití produktu, které není ve vstupu.
- Generuj Bootstrap-friendly HTML (Bootstrap 5): používej sémantické tagy a třídy pro čitelnost (např. spacing, seznamy, tabulky, nadpisy).
- Nepoužívej inline styles; styling řeš pouze přes Bootstrap class names.
- productHeading uprav profesionálně pro e-shop (jasný, srozumitelný, bez zbytečných slov).
- shortSummaryHtml musí mít maximálně 300 znaků textu (bez HTML tagů).
- Nepoužívej JavaScript.
- Vrať validní JSON a nic navíc.`;

const WEB_DESCRIPTION_TRANSFORM_GUARD = `TRANSFORMACE TEXTU:
- Přepisuj informace přesně, neměň jejich význam.
- Nezjednodušuj technické nebo funkční popisy tak, aby změnily význam.
- Nepřidávej interpretace jako "bezpečné", "praktické", "pro každodenní použití", pokud to není explicitně uvedeno.
- Pokud něco popisuje funkci (např. páska zajišťuje vzdálenost), zachovej tuto logiku i ve výstupu.

ZAKÁZANÉ ÚPRAVY:
- Nepřidávej nové use-cases (oslavy, každodenní použití apod.).
- Nepřepisuj technické vlastnosti do marketingových tvrzení.
- Nepřidávej benefity, které nejsou ve vstupu.

POVOLENÉ:
- Zjednodušit jazyk.
- Zlepšit čitelnost.
- Strukturovat text.
- Zvýraznit existující benefity.`;

const WEB_DESCRIPTION_MARKETING_STYLE = `MARKETING STYLE:
- Text má být mírně prodejní, ale stále věcný.
- Používej marketing pouze na základě skutečných vlastností produktu.
- Zvýrazni přínos pro zákazníka (co z toho má).
- Vyhýbej se přehnaným nebo neověřeným tvrzením.
- Nepoužívej obecné fráze typu "ideální pro každého".
- Piš konkrétně a přirozeně.

INTENZITA:
- 70 % fakta
- 30 % marketing`;

const WEB_DESCRIPTION_STRUCTURE_RULES = `STRUKTURA POPISU:
1) První odstavec:
- krátký, silný, situační
- kde a kdy se produkt používá
- proč je produkt v dané situaci užitečný

2) Druhý odstavec:
- co si zákazník vytvoří / získá

3) Třetí odstavec:
- popis produktu a obsahu

4) Čtvrtý odstavec:
- doplňující vlastnosti a použití

5) Samostatná sekce:
- obsah balení (ul seznam)

PRAVIDLA:
- úvod musí být přirozený, ne přehnaně reklamní
- popis musí být delší, ale bez zbytečné omáčky
- každý odstavec má mít jasný a odlišný účel (úvod / přínos / obsah / detaily)
- vyhýbej se opakování stejných slov za sebou (např. "sada sada")
- text musí působit přirozeně, ne genericky
- nezjednodušuj technické vlastnosti tak, aby změnily význam`;

const WEB_DESCRIPTION_V2_MASTER_PROMPT = `Jsi senior full-stack developer a produktový architekt pro e-commerce systém.

Potřebuji navrhnout a naprogramovat modul pro správu produktových vstupů a automatické generování jednotných výstupů pro e-shop.

Cíl:
Chci produkty vkládat ručně přes administraci, ale nechci ručně psát všechny texty a struktury kolem nich. Potřebuji, aby systém po vložení základních vstupních dat:
1) ověřil kvalitu vstupních dat,
2) upozornil na chybějící nebo slabé informace,
3) sjednotil data do jednoho interního formátu,
4) následně z těchto dat automaticky generoval všechny potřebné výstupy pro e-shop.

Požadované části:
A) Ruční vstup produktu
B) Validace kvality vstupních dat (quality score 0-100, issues, doporučení)
C) Normalizace dat do jednotného modelu
D) Generování jednotných výstupů (short/long, benefity, SEO meta, listing summary, tagy, export)
E) Hromadné zpracování více produktů
F) Admin přehled (tabulka + detail + historie)

Důležitá pravidla:
- Nikdy nevymýšlej fakta, která nejsou ve vstupních datech.
- Pokud něco chybí, označ to jako chybějící.
- Pokud je něco nejasné, vrať warning.
- Validace musí být oddělená od normalizace i od generování.
- Normalizace musí být oddělená od generování.
- Návrh musí být škálovatelný a rozšiřitelný pro nové typy produktů.

Vygeneruj návrh přesně v tomto pořadí:
1. Architektura modulu
2. Datový model / TypeScript interfaces
3. Návrh DB schématu
4. Validační pravidla
5. Normalizační pipeline
6. Generovací pipeline
7. Návrh admin UI
8. Návrh API endpointů
9. Ukázkový průchod na jednom konkrétním produktu
10. Návrh implementace v Next.js / TypeScript / Prisma / PostgreSQL

U každé části napiš:
- účel
- strukturu
- doporučenou implementaci
- rizika

Nakonec přidej:
- MVP verzi
- verzi pro další rozvoj
- doporučené pořadí implementace krok za krokem

Odpověď vrať jako profesionální, strukturovaný Markdown.
Použij produkčně použitelný TypeScript u ukázek a realistické názvy DB tabulek/sloupců.`;

const SYSTEM_PROMPT_WEB_DESCRIPTION_SK = `Jsi senior e-commerce copywriter pro slovenský web.
Preveď vstupný český produktový popis do prirodzenej slovenčiny.

Vráť JSON:
{
  "productHeading": "...",
  "shortSummaryHtml": "...",
  "longDescriptionHtml": "...",
  "packageContentsHtml": "...",
  "keyFeaturesHtml": "...",
  "finalHtml": "..."
}

Pravidlá:
- Zachovaj význam pôvodných informácií, nič nepridávaj.
- Nehalucinuj technické vlastnosti.
- Krátky popis max 300 znakov (bez HTML tagov).
- Výstup má byť vhodný pre e-shop, vecný a prirodzený.
- Nepridávaj obrázky ani <figure>/<img>.
- Použi validný JSON a nič navyše.`;

export function buildAgentMessages(input: {
  topic: string;
  audience: string;
  keywords: string;
  style: string;
  internalLinks: Link[];
  businessFields?: BusinessFields;
}): LlmMessage[] {
  const userPayload = {
    topic: input.topic,
    audience: input.audience,
    keywords: input.keywords,
    style: input.style,
    internalLinks: input.internalLinks,
    businessFields: input.businessFields ?? {},
    rules: {
      language: "cs",
      mustInclude: ["TOC", "table", "FAQ>=4", "CTA with internal link", "H1/H2/H3", "lists"],
      output: "JSON with contentHtml and metadata"
    }
  };

  return [
    { role: "system", content: SYSTEM_PROMPT_WRITER },
    { role: "user", content: JSON.stringify(userPayload) }
  ];
}

export function buildEditorMessages(input: {
  topic: string;
  audience: string;
  keywords: string;
  style: string;
  internalLinks: Link[];
  draft: unknown;
  businessFields?: BusinessFields;
}): LlmMessage[] {
  const payload = {
    task: "Revise draft for better readability and practical value while preserving required structure.",
    topic: input.topic,
    audience: input.audience,
    keywords: input.keywords,
    style: input.style,
    internalLinks: input.internalLinks,
    businessFields: input.businessFields ?? {},
    draft: input.draft
  };

  return [
    { role: "system", content: SYSTEM_PROMPT_SEO_EDITOR },
    { role: "user", content: JSON.stringify(payload) }
  ];
}

export function buildTopicIdeasMessages(input: { focus: string; audience: string }): LlmMessage[] {
  const payload = {
    focus: input.focus,
    audience: input.audience,
    constraints: { 
      language: "cs",
      ecommerceContext: "zanapo.cz",
      domain: ["sachy", "deskove hry"]
    }
  }; 
  return [
    { role: "system", content: SYSTEM_PROMPT_TOPICS },
    { role: "user", content: JSON.stringify(payload) }
  ];
}

export function buildDeepResearchMessages(input: {
  topic: string;
  audience: string;
  keywords: string;
  internalLinks: Link[];
  businessFields?: BusinessFields;
}): LlmMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT_RESEARCH },
    { role: "user", content: JSON.stringify(input) }
  ];
}

export function buildOutlineMessages(input: {
  topic: string;
  audience: string;
  keywords: string;
  style: string;
  research: unknown;
  businessFields?: BusinessFields;
}): LlmMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT_OUTLINE },
    { role: "user", content: JSON.stringify(input) }
  ];
}

export function buildHtmlValidatorMessages(input: { articleJson: unknown }): LlmMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT_HTML_VALIDATOR },
    { role: "user", content: JSON.stringify(input) }
  ];
}

export function buildFinalPackagerMessages(input: { articleJson: unknown }): LlmMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT_FINAL_PACKAGER },
    { role: "user", content: JSON.stringify(input) }
  ];
}

export function buildShopDiscoveryMessages(input: {
  shopUrl: string;
  llmsTxt: string;
  sitemapUrls: string[];
  discoveredCategories: string[];
  sampleUrls: string[];
}): LlmMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT_SHOP_DISCOVERY },
    {
      role: "user",
      content: JSON.stringify({
        shopUrl: input.shopUrl,
        llmsTxt: input.llmsTxt,
        sitemapUrls: input.sitemapUrls,
        discoveredCategories: input.discoveredCategories,
        sampleUrls: input.sampleUrls
      })
    }
  ];
}

export function buildWebDescriptionMessages(input: {
  variantName: string;
  ean: string;
  productCode: string;
  shortDescription: string;
  longDescription: string;
  manufacturer: string;
  research?: {
    queriesTried: string[];
    snippets: string[];
    sources: Array<{ title: string; url: string }>;
    note?: string;
  };
}): LlmMessage[] {
  return [
    {
      role: "system",
      content: `${SYSTEM_PROMPT_WEB_DESCRIPTION}\n\n${WEB_DESCRIPTION_TRANSFORM_GUARD}\n\n${WEB_DESCRIPTION_MARKETING_STYLE}\n\n${WEB_DESCRIPTION_STRUCTURE_RULES}`
    },
    {
      role: "user",
      content: JSON.stringify({
        language: "cs",
        outputFormat: "structured-product-html",
        product: {
          variantName: input.variantName,
          ean: input.ean,
          productCode: input.productCode,
          shortDescription: input.shortDescription,
          longDescription: input.longDescription,
          manufacturer: input.manufacturer
        },
        research: input.research ?? {
          queriesTried: [],
          snippets: [],
          sources: [],
          note: "No external research data"
        }
      })
    }
  ];
}

export function buildWebDescriptionV2Messages(input: {
  variantName: string;
  ean: string;
  productCode: string;
  shortDescription: string;
  longDescription: string;
  manufacturer: string;
  category?: string;
  packageContents?: string;
  parametersText?: string;
}): LlmMessage[] {
  const sampleProduct = {
    name: input.variantName,
    ean: input.ean,
    manufacturer: input.manufacturer,
    category: input.category ?? "",
    productCode: input.productCode,
    shortManufacturerText: input.shortDescription,
    longManufacturerText: input.longDescription,
    packageContents: input.packageContents ?? "",
    parametersText: input.parametersText ?? ""
  };
  return [
    { role: "system", content: WEB_DESCRIPTION_V2_MASTER_PROMPT },
    {
      role: "user",
      content: `Použij následující konkrétní vstupní produkt a ukaž na něm validaci, normalizaci, quality score, chybějící data, readiness a ukázkové výstupy.\n\n${JSON.stringify(sampleProduct, null, 2)}`
    }
  ];
}

export function buildWebDescriptionSkMessages(input: {
  variantName: string;
  ean: string;
  productCode: string;
  manufacturer: string;
  cz: {
    productHeading: string;
    shortSummaryHtml: string;
    longDescriptionHtml: string;
    packageContentsHtml: string;
    keyFeaturesHtml: string;
  };
}): LlmMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT_WEB_DESCRIPTION_SK },
    {
      role: "user",
      content: JSON.stringify({
        language: "sk",
        sourceLanguage: "cs",
        product: {
          variantName: input.variantName,
          ean: input.ean,
          productCode: input.productCode,
          manufacturer: input.manufacturer
        },
        sourceDescription: input.cz
      })
    }
  ];
}
