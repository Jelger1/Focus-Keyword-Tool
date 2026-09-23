/**
 * De Google-resultaten voor een zoekwoord.
 *
 * Dit is de enige plek die de SERP-provider kent. Standaard is dat Ahrefs:
 * die levert naast de top 10 ook het paginatype en het topzoekwoord per
 * resultaat, en de "Mensen vragen ook"-vragen. Serper.dev blijft als terugval
 * beschikbaar (live Google, maar zonder die extra velden). Beide leveren
 * dezelfde vorm op, dus de rest van de analyse merkt het verschil niet, op de
 * velden na die bij Serper leeg blijven.
 */

import { fail, domainOf } from './page.js';
import { fetchSerpOverview } from './ahrefs.js';
import { DEFAULT_REGION } from './region.js';

const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const SERPER_TIMEOUT_MS = 10_000;

/**
 * Welke provider draait: expliciet via SERP_PROVIDER, anders Ahrefs zodra er
 * een Ahrefs-sleutel is. Het endpoint geeft de omgevingsvariabelen door; deze
 * module leest ze niet zelf.
 */
export function chooseSerpProvider({ SERP_PROVIDER, AHREFS_API_KEY, SERPER_API_KEY }) {
  const configured = String(SERP_PROVIDER || '').toLowerCase();
  const provider = configured === 'serper' || configured === 'ahrefs' ? configured : AHREFS_API_KEY ? 'ahrefs' : 'serper';
  const apiKey = provider === 'ahrefs' ? AHREFS_API_KEY : SERPER_API_KEY;
  if (!apiKey) {
    const variable = provider === 'ahrefs' ? 'AHREFS_API_KEY' : 'SERPER_API_KEY';
    throw fail(500, 'no_serp_key', `${variable} is niet ingesteld op de server.`);
  }
  return { provider, apiKey };
}

/** Naam en datum van de bron, zoals de UI en het rapport die tonen. */
export function describeSerpProvider(provider, updatedAt, region = DEFAULT_REGION) {
  if (provider === 'ahrefs') {
    const date = updatedAt ? new Date(updatedAt) : null;
    const stamp = date && !Number.isNaN(date.getTime())
      ? `, stand ${date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}`
      : '';
    return `Ahrefs (Google ${region.label}${stamp})`;
  }
  return `Serper.dev (Google ${region.label}, live)`;
}

/**
 * @returns {Promise<{
 *   provider: 'ahrefs'|'serper',
 *   organic: Array<{position: number, title: string, url: string, domain: string, snippet: string,
 *                   pageType?: string|null, topKeyword?: string|null, topKeywordVolume?: number|null,
 *                   traffic?: number|null, domainRating?: number|null}>,
 *   peopleAlsoAsk: Array<{question: string, snippet: string, url: string}>,
 *   relatedSearches: string[],
 *   features: Array<{type: string, count: number}>,
 *   updatedAt: string|null,
 * }>}
 */
export async function fetchSerp(keyword, { provider, apiKey, region = DEFAULT_REGION }) {
  if (provider === 'ahrefs') {
    const serp = await fetchSerpOverview(keyword, { apiKey, country: region.ahrefsCountry });
    return { provider, ...serp };
  }
  const serp = await fetchSerper(keyword, { apiKey, region });
  return { provider: 'serper', ...serp, features: [], updatedAt: null };
}

// --- Serper.dev (terugval) --------------------------------------------------------

async function fetchSerper(keyword, { apiKey, region }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);

  let response;
  let data;
  try {
    response = await fetch(SERPER_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      // Land en taal expliciet: zonder gl/hl krijg je de Amerikaanse SERP, en die
      // zegt niets over waar een Nederlandse pagina tegen concurreert.
      body: JSON.stringify({ q: keyword, gl: region.serper.gl, hl: region.serper.hl, num: 10 }),
    });
    data = await response.json().catch(() => ({}));
  } catch (error) {
    if (error.name === 'AbortError') {
      throw fail(504, 'serp_timeout', 'Google-resultaten ophalen duurde te lang. Probeer het zo opnieuw.');
    }
    throw fail(502, 'serp_failed', `Google-resultaten konden niet opgehaald worden (${error.message}).`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw fail(502, 'serp_auth', 'De Serper-sleutel wordt geweigerd. Controleer SERPER_API_KEY.');
  }
  if (response.status === 429) {
    throw fail(429, 'serp_quota', 'Het Serper-tegoed of de limiet is bereikt.');
  }
  if (!response.ok) {
    throw fail(502, 'serp_failed', `Serper gaf status ${response.status}${data?.message ? `: ${data.message}` : ''}.`);
  }

  const organic = (Array.isArray(data.organic) ? data.organic : [])
    .filter((item) => item?.link)
    .map((item, index) => ({
      position: Number(item.position) || index + 1,
      title: String(item.title || ''),
      url: String(item.link),
      domain: domainOf(item.link),
      snippet: String(item.snippet || ''),
      pageType: null,
      topKeyword: null,
      topKeywordVolume: null,
      traffic: null,
      domainRating: null,
    }));

  if (organic.length === 0) {
    throw fail(404, 'serp_empty', 'Google gaf geen organische resultaten voor dit zoekwoord.');
  }

  return {
    organic,
    peopleAlsoAsk: (Array.isArray(data.peopleAlsoAsk) ? data.peopleAlsoAsk : [])
      .filter((item) => item?.question)
      .map((item) => ({
        question: String(item.question),
        snippet: String(item.snippet || ''),
        url: String(item.link || ''),
      })),
    relatedSearches: (Array.isArray(data.relatedSearches) ? data.relatedSearches : [])
      .map((item) => String(item?.query || ''))
      .filter(Boolean),
  };
}
