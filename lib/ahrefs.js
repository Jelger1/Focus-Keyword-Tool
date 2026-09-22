/**
 * Alle Ahrefs-calls op één plek.
 *
 * Ahrefs levert vier dingen die de analyse nodig heeft: het SERP-overzicht met
 * per resultaat een paginatype en het topzoekwoord, de cijfers van een
 * zoekwoord (volume, moeilijkheid, parent topic, intenties), zoekwoordideeën
 * voor de keyword mapping, en de zoekwoorden waarop een URL nu rankt. De data
 * komt uit de index van Ahrefs en is dus een paar dagen oud; de updatedatum
 * gaat mee naar de UI.
 *
 * Elke functie krijgt de API-sleutel van het endpoint mee; deze module leest
 * zelf geen omgevingsvariabelen.
 */

import { fail, domainOf, canonicalUrl } from './page.js';
import { normalize } from './text.js';

const BASE_URL = 'https://api.ahrefs.com/v3';

/**
 * Ahrefs antwoordt meestal binnen een seconde, maar de keyword-endpoints
 * hadden in een test af en toe meer dan vijftien seconden nodig. Liever even
 * wachten dan cijfers missen; de calls lopen toch naast ander werk.
 */
const TIMEOUT_MS = 25_000;

/** Meer dan dit aantal zoekwoorden per aanvraag splitsen we op. */
const KEYWORDS_PER_REQUEST = 50;

/** Onder dit maandvolume is een zoekwoordidee ruis. */
const MIN_IDEA_VOLUME = 10;

export const DEFAULT_COUNTRY = 'nl';

// --- Transport ----------------------------------------------------------------

async function ahrefsGet(path, params, { apiKey, timeoutMs = TIMEOUT_MS }) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let data;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    if (error.name === 'AbortError') {
      throw fail(504, 'ahrefs_timeout', 'Ahrefs reageerde niet op tijd. Probeer het zo opnieuw.');
    }
    throw fail(502, 'ahrefs_failed', `Ahrefs kon niet bereikt worden (${error.message}).`);
  } finally {
    clearTimeout(timer);
  }

  const detail = data?.error ? `: ${data.error}` : '';
  if (response.status === 401 || response.status === 403) {
    // Een 403 betekent ook "geen units meer"; de melding van Ahrefs zegt wat het is.
    throw fail(502, 'ahrefs_auth', `Ahrefs weigert de aanvraag${detail}. Controleer AHREFS_API_KEY en het tegoed.`);
  }
  if (response.status === 429) {
    throw fail(429, 'ahrefs_quota', `Ahrefs geeft een limiet aan${detail}. Wacht even en probeer het opnieuw.`);
  }
  if (!response.ok) {
    throw fail(502, 'ahrefs_failed', `Ahrefs gaf status ${response.status}${detail}.`);
  }
  return data;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Ahrefs filtert met een JSON-expressie in de querystring. */
function minVolumeFilter(minimum) {
  return JSON.stringify({ field: 'volume', is: ['gte', minimum] });
}

function intentsOf(row) {
  const intents = row?.intents;
  if (!intents || typeof intents !== 'object') return null;
  return {
    informatief: Boolean(intents.informational),
    commercieel: Boolean(intents.commercial),
    transactioneel: Boolean(intents.transactional),
    navigatie: Boolean(intents.navigational),
    merk: Boolean(intents.branded),
    lokaal: Boolean(intents.local),
  };
}

// --- SERP-overzicht -------------------------------------------------------------

const SERP_FIELDS = [
  'position', 'type', 'page_type', 'url', 'title', 'traffic', 'keywords',
  'top_keyword', 'top_keyword_volume', 'domain_rating', 'update_date',
].join(',');

/** Rijen met een URL en één van deze typen zijn gewone organische pagina's. */
const ORGANIC_TYPES = new Set(['organic', 'snippet', 'sitelinks']);

/**
 * De top van Google volgens Ahrefs. SERP-features (vragen, local pack,
 * shopping) staan in dezelfde lijst als de organische resultaten en delen een
 * positienummer; we halen ze uit elkaar. Vraag meer posities op dan we nodig
 * hebben, want de features tellen mee in het aantal.
 *
 * @returns {Promise<{
 *   organic: Array<{position: number, title: string, url: string, domain: string, snippet: string,
 *                   pageType: string|null, topKeyword: string|null, topKeywordVolume: number|null,
 *                   traffic: number|null, keywords: number|null, domainRating: number|null}>,
 *   peopleAlsoAsk: Array<{question: string, snippet: string, url: string}>,
 *   relatedSearches: string[],
 *   features: Array<{type: string, count: number}>,
 *   updatedAt: string|null,
 * }>}
 */
export async function fetchSerpOverview(keyword, { apiKey, country = DEFAULT_COUNTRY, topPositions = 15, maxOrganic = 10 }) {
  const data = await ahrefsGet(
    '/serp-overview/serp-overview',
    { keyword, country, top_positions: topPositions, select: SERP_FIELDS },
    { apiKey }
  );

  const rows = Array.isArray(data?.positions) ? data.positions : [];
  const organic = [];
  const questions = [];
  const featureCounts = new Map();
  const seenUrls = new Set();
  const seenQuestions = new Set();
  let updatedAt = null;

  for (const row of rows) {
    const types = Array.isArray(row.type) ? row.type.map(String) : [];
    if (row.update_date && !updatedAt) updatedAt = String(row.update_date);
    if (types.some((type) => type.startsWith('paid'))) continue;

    if (types.includes('question')) {
      const question = String(row.title || '').trim();
      const key = normalize(question);
      if (question && !seenQuestions.has(key)) {
        seenQuestions.add(key);
        questions.push({ question, snippet: '', url: String(row.url || '') });
      }
      featureCounts.set('question', (featureCounts.get('question') || 0) + 1);
      continue;
    }

    const isPage = typeof row.url === 'string' && row.url && types.some((type) => ORGANIC_TYPES.has(type));
    if (isPage) {
      const key = canonicalUrl(row.url);
      if (seenUrls.has(key) || organic.length >= maxOrganic) continue;
      seenUrls.add(key);
      organic.push({
        position: Number(row.position) || organic.length + 1,
        title: String(row.title || ''),
        url: String(row.url),
        domain: domainOf(row.url),
        snippet: '',
        pageType: row.page_type ? String(row.page_type) : null,
        topKeyword: row.top_keyword ? String(row.top_keyword) : null,
        topKeywordVolume: numberOrNull(row.top_keyword_volume),
        traffic: numberOrNull(row.traffic),
        keywords: numberOrNull(row.keywords),
        domainRating: numberOrNull(row.domain_rating),
      });
      for (const type of types) {
        if (type !== 'organic') featureCounts.set(type, (featureCounts.get(type) || 0) + 1);
      }
      continue;
    }

    for (const type of types) featureCounts.set(type, (featureCounts.get(type) || 0) + 1);
  }

  if (organic.length === 0) {
    throw fail(404, 'serp_empty', 'Ahrefs heeft geen organische resultaten voor dit zoekwoord. Controleer de spelling of kies een zoekwoord met zoekvolume.');
  }

  return {
    organic,
    peopleAlsoAsk: questions,
    relatedSearches: [],
    features: [...featureCounts.entries()].map(([type, count]) => ({ type, count })),
    updatedAt,
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// --- Zoekwoordcijfers -----------------------------------------------------------

const OVERVIEW_FIELDS_FULL = [
  'keyword', 'volume', 'difficulty', 'cpc', 'parent_topic', 'parent_volume', 'intents',
  'serp_features', 'traffic_potential', 'serp_last_update',
].join(',');
const OVERVIEW_FIELDS_BASIC = ['keyword', 'volume', 'difficulty', 'parent_topic', 'intents'].join(',');

function cleanKeyword(keyword) {
  return String(keyword || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Volume, moeilijkheid, parent topic en intenties per zoekwoord. Zoekwoorden
 * die Ahrefs niet kent, ontbreken in het resultaat: dan is er geen cijfer, en
 * dat verzinnen we niet.
 *
 * @param {'basic'|'full'} detail  'basic' is genoeg om een lijst te verrijken en kost minder units
 * @returns {Promise<Map<string, object>>}  sleutel: genormaliseerd zoekwoord
 */
export async function fetchKeywordOverview(keywords, { apiKey, country = DEFAULT_COUNTRY, detail = 'full' }) {
  const unique = [...new Set(keywords.map(cleanKeyword).filter(Boolean))];
  const result = new Map();

  for (let start = 0; start < unique.length; start += KEYWORDS_PER_REQUEST) {
    const chunk = unique.slice(start, start + KEYWORDS_PER_REQUEST);
    const data = await ahrefsGet(
      '/keywords-explorer/overview',
      {
        keywords: chunk.join(','),
        country,
        select: detail === 'basic' ? OVERVIEW_FIELDS_BASIC : OVERVIEW_FIELDS_FULL,
        limit: chunk.length,
      },
      { apiKey }
    );
    for (const row of Array.isArray(data?.keywords) ? data.keywords : []) {
      if (!row?.keyword) continue;
      result.set(normalize(row.keyword), keywordMetrics(row));
    }
  }
  return result;
}

function keywordMetrics(row) {
  return {
    keyword: String(row.keyword),
    volume: numberOrNull(row.volume),
    difficulty: numberOrNull(row.difficulty),
    cpc: numberOrNull(row.cpc),
    parentTopic: row.parent_topic ? String(row.parent_topic) : null,
    parentVolume: numberOrNull(row.parent_volume),
    intents: intentsOf(row),
    serpFeatures: Array.isArray(row.serp_features) ? row.serp_features.map(String) : [],
    trafficPotential: numberOrNull(row.traffic_potential),
    updatedAt: row.serp_last_update ? String(row.serp_last_update) : null,
  };
}

// --- Zoekwoordideeën voor de keyword mapping -------------------------------------

const IDEA_FIELDS = ['keyword', 'volume', 'difficulty', 'parent_topic', 'intents'].join(',');

/**
 * Kandidaten voor secondary, supporting en varianten: zoekwoorden die de
 * termen van het focus zoekwoord bevatten, en zoekwoorden waar de top 10 óók
 * op rankt (synoniemen en nauw verwante termen). Claude kiest hier straks uit,
 * maar kan er niets aan toevoegen.
 */
export async function fetchKeywordIdeas(keyword, { apiKey, country = DEFAULT_COUNTRY, limit = 30 }) {
  const shared = { keywords: cleanKeyword(keyword), country, select: IDEA_FIELDS, order_by: 'volume:desc', limit, where: minVolumeFilter(MIN_IDEA_VOLUME) };

  const [matching, related] = await Promise.all([
    ahrefsGet('/keywords-explorer/matching-terms', { ...shared, match_mode: 'terms' }, { apiKey }),
    ahrefsGet('/keywords-explorer/related-terms', { ...shared, terms: 'also_rank_for', view_for: 'top_10' }, { apiKey }),
  ]);

  const ideas = new Map();
  const add = (rows, source) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row?.keyword) continue;
      const key = normalize(row.keyword);
      if (!key || key === normalize(keyword)) continue;
      const existing = ideas.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        continue;
      }
      ideas.set(key, { ...keywordMetrics(row), sources: [source] });
    }
  };
  add(matching?.keywords, 'bevat het zoekwoord');
  add(related?.keywords, 'top 10 rankt er ook op');

  return [...ideas.values()].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}

// --- Zoekwoorden waarop een URL rankt ---------------------------------------------

const ORGANIC_FIELDS = [
  'keyword', 'best_position', 'volume', 'sum_traffic', 'keyword_difficulty',
  'is_informational', 'is_commercial', 'is_transactional', 'is_navigational', 'is_branded', 'is_local',
].join(',');

/**
 * De zoekwoorden waarop een URL volgens Ahrefs nu rankt. Dit is een schatting
 * uit de index van Ahrefs, geen meting van Google; de aanroeper zet dat erbij.
 * Levert dezelfde vorm op als een Search Console-rij, zodat de rest van de
 * herfocus er niets van merkt.
 */
export async function fetchOrganicKeywords(url, { apiKey, country = DEFAULT_COUNTRY, limit = 50 }) {
  const attempt = (target) =>
    ahrefsGet(
      '/site-explorer/organic-keywords',
      { target, mode: 'exact', country, date: today(), select: ORGANIC_FIELDS, order_by: 'sum_traffic:desc', limit },
      { apiKey }
    );

  // Ahrefs is precies met de slash aan het eind; probeer de andere schrijfwijze als de eerste leeg is.
  let data = await attempt(url);
  let rows = Array.isArray(data?.keywords) ? data.keywords : [];
  if (rows.length === 0) {
    const alternative = url.endsWith('/') ? url.slice(0, -1) : `${url}/`;
    data = await attempt(alternative);
    rows = Array.isArray(data?.keywords) ? data.keywords : [];
  }

  return rows
    .filter((row) => row?.keyword)
    .map((row) => ({
      query: String(row.keyword),
      clicks: null,
      impressions: null,
      ctr: null,
      position: numberOrNull(row.best_position),
      volume: numberOrNull(row.volume),
      traffic: numberOrNull(row.sum_traffic),
      difficulty: numberOrNull(row.keyword_difficulty),
      intents: {
        informatief: Boolean(row.is_informational),
        commercieel: Boolean(row.is_commercial),
        transactioneel: Boolean(row.is_transactional),
        navigatie: Boolean(row.is_navigational),
        merk: Boolean(row.is_branded),
        lokaal: Boolean(row.is_local),
      },
    }));
}
