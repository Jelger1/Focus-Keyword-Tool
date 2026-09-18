/**
 * De echte Google-resultaten, via Serper.dev.
 *
 * Alles wat met de SERP-provider te maken heeft, zit in dit ene bestand. Stappen
 * we ooit over naar SerpApi, DataForSEO of Ahrefs, dan hoeft alleen fetchSerp()
 * dezelfde vorm terug te geven; de rest van de analyse merkt er niets van.
 */

import { fail, domainOf } from './page.js';

const ENDPOINT = 'https://google.serper.dev/search';
const TIMEOUT_MS = 10_000;

export const SERP_PROVIDER = 'Serper.dev (Google Nederland)';

/**
 * @returns {Promise<{
 *   organic: Array<{position: number, title: string, url: string, domain: string, snippet: string}>,
 *   peopleAlsoAsk: Array<{question: string, snippet: string, url: string}>,
 *   relatedSearches: string[],
 * }>}
 */
export async function fetchSerp(keyword, { apiKey }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response;
  let data;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      // Nederlandse resultaten in het Nederlands: zonder gl/hl krijg je de
      // Amerikaanse SERP, en die zegt niets over waar een NL-pagina tegen concurreert.
      body: JSON.stringify({ q: keyword, gl: 'nl', hl: 'nl', num: 10 }),
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
