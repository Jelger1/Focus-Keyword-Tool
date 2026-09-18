/**
 * Pagina's ophalen en uitlezen. Wordt gebruikt voor de doelpagina én voor elke
 * concurrent, zodat woordenaantallen en koppen op exact dezelfde manier geteld
 * worden — anders vergelijk je appels met peren.
 */

import { normalize } from './text.js';

const MAX_PAGE_CHARS = 120_000;
const MAX_HEADINGS = 60;

export const URL_PATTERN = /^(https?:\/\/\S+|([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?)$/i;

/** Fout met een code die de frontend kan vertalen naar een nette melding. */
export function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function withScheme(value) {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Weigert adressen in het interne netwerk, zodat de proxy niet als scanner te misbruiken is. */
function isPublicHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  if (/^(127|10)\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  if (host === '::1' || host === '0.0.0.0') return false;
  return true;
}

/** Domein zonder www, voor weergave en om de eigen site in de SERP te herkennen. */
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** URL zonder schema, www, query en slash aan het eind: twee schrijfwijzen van dezelfde pagina tellen als één. */
export function canonicalUrl(url) {
  try {
    const parsed = new URL(withScheme(url));
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

/** De named entities die op Nederlandse pagina's daadwerkelijk voorkomen. */
const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å', aelig: 'æ',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', oslash: 'ø',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  ccedil: 'ç', ntilde: 'ñ', szlig: 'ß', yuml: 'ÿ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  euro: '€', pound: '£', copy: '©', reg: '®', trade: '™', deg: '°',
};

/** Decodeert HTML-entities; &amp; als laatste, anders ontstaat dubbele decodering. */
function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name) => {
      const key = name.toLowerCase();
      if (key === 'amp') return match;
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : ' ';
    })
    .replace(/&amp;/gi, '&');
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(code);
  } catch {
    return ' ';
  }
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Haalt structuur en tekst uit ruwe HTML.
 *
 * Bewust geen DOM-parser: dat scheelt een dependency en een cold start, en voor
 * koppen, titel en platte tekst is regex ruim genoeg. Navigatie, footer en
 * formulieren gooien we eerst weg — anders tellen menu-items mee als paginatekst.
 */
export function readPage(html) {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const metaDescription = decodeEntities(
    (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || ''
  ).trim();

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|form|select)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Veel templates zetten dezelfde koppen twee keer in de HTML (mobiel naast
  // desktop, of een inhoudsopgave boven het artikel). Eén keer tellen volstaat.
  const headings = [];
  const seen = new Set();
  const headingPattern = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = headingPattern.exec(cleaned)) !== null && headings.length < MAX_HEADINGS) {
    const text = stripTags(match[2]);
    const key = normalize(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    headings.push({ level: `H${match[1]}`, text });
  }

  const text = stripTags(
    cleaned
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, ' \n ')
      .replace(/<br\s*\/?>/gi, ' \n ')
  ).slice(0, MAX_PAGE_CHARS);

  const words = text.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word));

  return {
    title,
    metaDescription,
    h1: headings.find((heading) => heading.level === 'H1')?.text || '',
    headings,
    text,
    wordCount: words.length,
  };
}

/**
 * Haalt één pagina op en leest hem uit. Gooit een fout met code en Nederlandse
 * uitleg, zodat de aanroeper kan kiezen: afbreken (doelpagina) of noteren en
 * doorgaan (concurrent).
 */
export async function fetchPage(rawUrl, { timeoutMs = 12_000 } = {}) {
  if (!URL_PATTERN.test(String(rawUrl).trim())) {
    throw fail(400, 'invalid_url', 'Dat lijkt geen geldige URL. Gebruik bijvoorbeeld www.klant.nl/dienst.');
  }

  let parsed;
  try {
    parsed = new URL(withScheme(rawUrl));
  } catch {
    throw fail(400, 'invalid_url', 'Deze URL kan niet gelezen worden. Controleer de schrijfwijze.');
  }

  if (!isPublicHost(parsed.hostname)) {
    throw fail(400, 'blocked_host', 'Interne adressen kan de tool niet ophalen. Gebruik een openbare URL.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let html;
  try {
    response = await fetch(parsed.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SeoContentGapAnalyzer/1.0; interne SEO-analysetool)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      },
    });

    if (!response.ok) {
      const hint = response.status === 403
        ? ' De server blokkeert geautomatiseerde bezoekers.'
        : response.status === 404
          ? ' Bestaat deze URL nog?'
          : '';
      throw fail(502, 'http_error', `De pagina gaf status ${response.status}.${hint}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      throw fail(415, 'not_html', `Deze URL levert ${contentType || 'geen HTML'} op. Geef een gewone webpagina op.`);
    }

    // Binnen dezelfde timeout: een server die de headers snel stuurt maar de body
    // traag, mag de analyse ook niet laten hangen.
    html = await response.text();
  } catch (error) {
    if (error.code) throw error;
    if (error.name === 'AbortError') {
      throw fail(504, 'timeout', `De pagina reageerde niet binnen ${timeoutMs / 1000} seconden.`);
    }
    throw fail(502, 'fetch_failed', `De pagina kon niet opgehaald worden (${error.message}).`);
  } finally {
    clearTimeout(timer);
  }

  const page = readPage(html);
  if (page.wordCount < 50) {
    throw fail(422, 'empty_page', 'Er kwam nauwelijks tekst uit deze pagina. Mogelijk is hij volledig client-side gerenderd of staat er een cookiemuur voor.');
  }

  return { ...page, url: response.url || parsed.href };
}
