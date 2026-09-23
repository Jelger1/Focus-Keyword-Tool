/**
 * Pagina's ophalen en uitlezen. Wordt gebruikt voor de doelpagina én voor elke
 * concurrent, zodat woordenaantallen en koppen op exact dezelfde manier geteld
 * worden — anders vergelijk je appels met peren.
 */

import { parse } from 'node-html-parser';
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

// --- Uitlezen: alleen de hoofdinhoud ---------------------------------------------------

/**
 * Elementen zonder leesbare paginatekst, of met tekst van de interface: een knop
 * ("in winkelwagen"), een label ("E-mailadres*"), een keuzelijst.
 */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'template', 'select', 'option', 'button', 'label', 'input', 'textarea',
  'dialog', 'object', 'embed', 'canvas', 'video', 'audio', 'map', 'head', 'title', 'meta', 'link',
]);

/** Binnen een woord: EasyPack<sup>®</sup> blijft aan elkaar. */
const GLUE_TAGS = new Set(['sup', 'sub', 'wbr']);

/** Blokken die een lege regel krijgen, zodat hun tekst niet aan elkaar plakt. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'br', 'hr', 'form', 'fieldset', 'address', 'details', 'summary', 'pre',
]);

/** De tags en rollen van sitechrome: navigatie, kop en voet van de site, zijbalken, pop-ups. */
const CHROME_TAGS = new Set(['nav', 'footer', 'aside']);
const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'search', 'complementary', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar']);

/**
 * Woorden in een class of id die op sitechrome wijzen, gecontroleerd per deel van de
 * naam ("mini-cart" → mini, cart), zodat "research-block" niet als "search" telt.
 *
 * Sterk: bijna altijd sitechrome (menu, header, cookie, winkelwagen). Weg, tenzij het
 * blok de H1 of meer dan de helft van de inhoud bevat: "product-header" om een H1 is
 * inhoud, "site-header" om het menu niet.
 * Zwak: vaak ook een layout-wrapper om echte inhoud ("page-layout-with-sidebar" om de
 * productlijst). Alleen weg als het een klein blok is, zoals de filters zelf.
 */
const STRONG_CHROME = new Set([
  'cookie', 'cookies', 'cookiebar', 'cookielaw', 'consent', 'gdpr', 'cmp', 'newsletter', 'nieuwsbrief', 'subscribe',
  'minicart', 'cart', 'basket', 'winkelwagen', 'winkelmand', 'wishlist', 'breadcrumb', 'breadcrumbs', 'kruimelpad',
  'skip', 'skiplink', 'offcanvas', 'modal', 'popup', 'toast', 'topbar', 'usp', 'usps', 'announcement', 'navbar', 'nav',
  'navigation', 'menu', 'megamenu', 'sidenav', 'header', 'masthead', 'footer', 'share', 'sharing', 'socials', 'login',
  'account', 'myaccount', 'searchbar', 'search', 'livechat', 'chat', 'language', 'languages',
]);
const WEAK_CHROME = new Set(['sidebar', 'drawer', 'filter', 'filters', 'facet', 'facets', 'sorting', 'pagination', 'compare']);
/**
 * Binnen een gevonden inhoudsblok zijn dit onderdelen van een component
 * ("card-footer" met naam en prijs, "section-header" met de kop), geen sitechrome.
 */
const COMPONENT_PARTS = new Set(['header', 'footer', 'masthead']);
/** Blokken rond een alinea die bij de opmaak van een artikel horen, niet bij de tekst: auteur, datum, leestijd. */
const META_PARTS = new Set(['author', 'byline', 'meta', 'date', 'published', 'updated', 'readtime', 'reading', 'leestijd', 'tags', 'breadcrumb', 'breadcrumbs']);
/**
 * Een auteurs- of datumregel: begint zo, of is kort en noemt een bijwerkdatum of
 * leestijd ("Yvo Verschoor · Expert zonnepanelen · Bijgewerkt op: 18 maart 2026").
 */
const BYLINE_START = /^(door|geschreven door|bijgewerkt|laatst bijgewerkt|gepubliceerd|by|written by|updated|last updated|published|posted)\b/i;
const BYLINE_WORDS = /\b(bijgewerkt op|laatst bijgewerkt|geschreven door|gepubliceerd op|leestijd|updated on|last updated|published on|written by|reading time|min read)\b/i;
const BYLINE_MAX_WORDS = 25;

function isByline(text) {
  return BYLINE_START.test(text) || (BYLINE_WORDS.test(text) && countWords(text) <= BYLINE_MAX_WORDS);
}
/** Boven dit aandeel van de inhoud is een blok met een chrome-klasse toch inhoud. */
const STRONG_KEEP_SHARE = 0.5;
const WEAK_KEEP_SHARE = 0.15;

/** Klassen die een element onzichtbaar maken; "d-none d-md-block" is op desktop wél te zien. */
const HIDDEN_CLASSES = new Set(['hidden', 'is-hidden', 'u-hidden', 'hide', 'invisible', 'sr-only', 'visually-hidden', 'screen-reader-text', 'screen-reader-only']);

/** Kandidaten voor het blok met de hoofdinhoud, van sterk naar zwak signaal. */
const MAIN_SELECTORS = 'main, [role="main"], article, #main, #content, #main-content, #maincontent, .main-content, #primary, .site-main, .site-content, .content-area, #page-content';

/** Een formulier met minder woorden is interface: een zoekveld, nieuwsbrief of inlog. */
const SMALL_FORM_WORDS = 60;
const MIN_MAIN_WORDS = 60;
/** Onder dit aandeel van de opgeschoonde body vertrouwen we een <main> niet: dan mist er inhoud. */
const MIN_MAIN_SHARE = 0.3;
const INTRO_MIN_PARAGRAPH_WORDS = 8;
const INTRO_TARGET_WORDS = 40;
const INTRO_MAX_WORDS = 120;

function countWords(text) {
  return String(text || '').split(/\s+/).filter((word) => /[\p{L}\d]/u.test(word)).length;
}

function classParts(node) {
  const names = `${node.getAttribute?.('class') || ''} ${node.getAttribute?.('id') || ''}`.toLowerCase();
  return names.split(/\s+/).filter(Boolean);
}

function isHidden(node) {
  // React-streaming zet inhoud eerst in <div hidden id="S:3"> en verplaatst hem daarna
  // met JavaScript: dat is zichtbare inhoud, geen verborgen blok.
  if (node.hasAttribute?.('hidden') && !/^S:/.test(node.getAttribute('id') || '')) return true;
  if (node.getAttribute?.('aria-hidden') === 'true') return true;
  const style = (node.getAttribute?.('style') || '').replace(/\s+/g, '').toLowerCase();
  if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
  const classes = (node.getAttribute?.('class') || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (classes.some((name) => HIDDEN_CLASSES.has(name))) return true;
  return classes.includes('d-none') && !classes.some((name) => /^d-(sm|md|lg|xl|xxl)-(block|flex|inline|grid|table)/.test(name));
}

/** Sitechrome die de HTML zelf zo noemt: navigatie, voet, zijbalk, de kop van de site. */
function isSemanticChrome(node) {
  const tag = node.rawTagName?.toLowerCase();
  if (CHROME_TAGS.has(tag)) return true;
  if (CHROME_ROLES.has((node.getAttribute?.('role') || '').toLowerCase())) return true;
  // Een <header> in een artikel of in <main> is de kop van de inhoud, geen sitekop.
  return tag === 'header' && !node.closest?.('main, article, [role="main"]');
}

/** Voorvoegsels waarmee "header" en "footer" wél de kop of voet van de site zijn. */
const SITE_PREFIXES = new Set(['site', 'main', 'page', 'top', 'global', 'primary', 'sticky']);

/**
 * "header", "footer" en "masthead" zijn alleen sitechrome als de naam ermee begint
 * (#header, header_main) of als er "site-", "main-" of "top-" voor staat; anders zijn
 * het onderdelen van een component (card-footer, section-header). Binnen een gevonden
 * inhoudsblok tellen ze nooit mee.
 */
function nameParts(name, insideMain) {
  const parts = name.split(/[-_]/).filter(Boolean);
  return parts.filter((part, index) => {
    if (!COMPONENT_PARTS.has(part)) return true;
    if (insideMain) return false;
    return index === 0 || (index === 1 && SITE_PREFIXES.has(parts[0]));
  });
}

/** 'strong', 'weak' of null: hoe hard de class of id op sitechrome wijst. */
function chromeByName(node, { insideMain = false } = {}) {
  const parts = classParts(node).flatMap((name) => nameParts(name, insideMain));
  // Cookie-namen worden vaak aaneengeschreven (cookieconsent-optout, cookiewall): het voorvoegsel is genoeg.
  if (parts.some((part) => STRONG_CHROME.has(part) || part.startsWith('cookie'))) return 'strong';
  if (parts.some((part) => WEAK_CHROME.has(part))) return 'weak';
  return null;
}

function holdsContent(node) {
  return node.rawTagName?.toLowerCase() === 'h1' || Boolean(node.querySelector('h1, main, [role="main"]'));
}

/** De tekst van een uitklap- of doorlinkknop midden in een alinea ("Toon meer"), geen inhoud. */
const TOGGLE_TEXT = /^(toon|lees|laat|bekijk)\s+(meer|minder|alles)$|^meer\s+(lezen|tonen|informatie)$|^(read|show|see|view)\s+(more|less|all)$/i;

function isToggle(node) {
  const tag = node.rawTagName?.toLowerCase();
  return (tag === 'a' || tag === 'span' || tag === 'div') && node.childNodes.length <= 3 && TOGGLE_TEXT.test(node.text.replace(/\s+/g, ' ').trim());
}

/** Verwijdert alles wat aan `test` voldoet, behalve blokken die `keep` beschermt. */
function prune(root, test, keep = () => false) {
  for (const node of root.querySelectorAll('*')) {
    if (!node.parentNode || !test(node) || keep(node)) continue;
    node.remove();
  }
}

/** Spaties netjes: geen spatie voor een leesteken of na een haakje. */
function tidy(text) {
  return String(text).replace(/\s+/g, ' ').replace(/\s+([,.;:!?%)\]])/g, '$1').replace(/([(\[])\s+/g, '$1').trim();
}

/** De tekst van één element: elke tag telt als spatie, zodat losse woorden niet aan elkaar plakken. */
function textOf(node) {
  const parts = [];
  const walk = (current) => {
    for (const child of current.childNodes) {
      if (child.nodeType === 3) parts.push(child.text);
      else if (child.nodeType === 1 && !SKIP_TAGS.has(child.rawTagName?.toLowerCase())) {
        const glue = GLUE_TAGS.has(child.rawTagName?.toLowerCase());
        if (!glue) parts.push(' ');
        walk(child);
        if (!glue) parts.push(' ');
      }
    }
  };
  walk(node);
  return tidy(parts.join(''));
}

/**
 * Tekst per blok, en de alinea's in leesvolgorde. Elke tag telt als spatie, net als
 * vroeger, zodat losse woorden in de opmaak niet aan elkaar plakken en woordenaantallen
 * vergelijkbaar blijven.
 */
function collectText(root) {
  const parts = [];
  const paragraphs = [];
  let seenH1 = false;
  let inMeta = 0;
  let section = 0;
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        parts.push(child.text);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = child.rawTagName?.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === 'h1') seenH1 = true;
      if (/^h[1-6]$/.test(tag)) section += 1;
      const meta = classParts(child).some((name) => name.split(/[-_]/).some((part) => META_PARTS.has(part)));
      if (meta) inMeta += 1;
      const separator = BLOCK_TAGS.has(tag) ? '\n' : GLUE_TAGS.has(tag) ? '' : ' ';
      parts.push(separator);
      if (tag === 'p') {
        const text = textOf(child);
        if (text && !inMeta && !isByline(text)) paragraphs.push({ text, afterH1: seenH1, section });
      }
      walk(child);
      parts.push(separator);
      if (meta) inMeta -= 1;
    }
  };
  walk(root);
  const text = parts.join('').split('\n').map(tidy).filter(Boolean).join('\n');
  return { text, paragraphs };
}

/**
 * De eerste alinea zoals een lezer hem ziet: de eerste echte alinea's (minstens acht
 * woorden) na de H1, tot ongeveer veertig woorden en nooit voorbij de volgende kop.
 * Geen <p> te vinden, dan de tekst direct na de H1.
 */
function firstParagraph(paragraphs, text, h1) {
  const usable = paragraphs.filter((item) => countWords(item.text) >= INTRO_MIN_PARAGRAPH_WORDS);
  const afterH1 = usable.filter((item) => item.afterH1);
  const pool = afterH1.length ? afterH1 : usable;
  // Alleen alinea's uit hetzelfde tekstblok: bij de volgende kop begint iets anders.
  const block = pool.length ? pool.filter((item) => item.section === pool[0].section) : [];
  const picked = [];
  for (const item of block.slice(0, 3)) {
    picked.push(item.text);
    if (countWords(picked.join(' ')) >= INTRO_TARGET_WORDS) break;
  }
  let intro = picked.join(' ');
  if (!intro) {
    const flat = text.replace(/\s+/g, ' ');
    const at = h1 ? flat.indexOf(h1) : -1;
    intro = at >= 0 ? flat.slice(at + h1.length) : flat;
  }
  return intro.split(/\s+/).filter(Boolean).slice(0, INTRO_MAX_WORDS).join(' ');
}

/**
 * Haalt structuur en tekst uit ruwe HTML: alleen de hoofdinhoud van de pagina.
 *
 * Met een echte parser in plaats van regex: een siteheader, een winkelwagen-drawer
 * of een cookiebalk is een genest blok, en dat knip je met regex niet betrouwbaar
 * weg. Vroeger kwamen zo de paginatitel, het menu, "Inloggen" en telefoonnummers in
 * de tekst en in de eerste alinea terecht; dat mat ook verkeerd (het zoekwoord uit
 * de titel telde als "staat in de eerste alinea").
 *
 * Werkwijze: alleen de <body>; eerst wat onzichtbaar of interface is weg, dan de
 * sitechrome (op tag, rol en class), en daarna het blok met de hoofdinhoud als dat er
 * is (<main>, role="main", #content, <article>), anders de opgeschoonde body. Een blok
 * met de H1 of met het grootste deel van de tekst blijft altijd staan.
 */
export function readPage(html) {
  const doc = parse(String(html || ''), { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const title = tidy(doc.querySelector('title')?.text || '');
  const description = doc.querySelectorAll('meta').find((meta) => (meta.getAttribute('name') || '').toLowerCase() === 'description');
  const metaDescription = (description?.getAttribute('content') || '').replace(/\s+/g, ' ').trim();

  const body = doc.querySelector('body') || doc;
  prune(body, (node) => SKIP_TAGS.has(node.rawTagName?.toLowerCase()) || isHidden(node));
  // Alleen kleine formulieren (zoekveld, nieuwsbrief, inloggen) zijn interface: een
  // productlijst staat vaak in een "in winkelwagen"-formulier, en op oude
  // ASP.NET-sites staat de hele pagina in één formulier.
  prune(body, (node) => node.rawTagName?.toLowerCase() === 'form', (node) => holdsContent(node) || countWords(node.text) >= SMALL_FORM_WORDS);
  prune(body, isSemanticChrome, holdsContent);
  prune(body, isToggle);

  // Het inhoudsblok, als de site er een aanwijst; anders de opgeschoonde body.
  const totalWords = countWords(body.text);
  const main = body.querySelectorAll(MAIN_SELECTORS)
    .map((node) => ({ node, words: countWords(node.text) }))
    .filter((item) => item.words >= MIN_MAIN_WORDS && item.words >= totalWords * MIN_MAIN_SHARE)
    .sort((a, b) => b.words - a.words)[0];
  const root = main?.node || body;

  // Pas binnen dat blok de klassenregels, gewogen tegen de omvang van de inhoud.
  const rootWords = countWords(root.text);
  const insideMain = root !== body;
  prune(root, (node) => chromeByName(node, { insideMain }) !== null, (node) => {
    if (holdsContent(node)) return true;
    const share = countWords(node.text) / Math.max(rootWords, 1);
    return share > (chromeByName(node, { insideMain }) === 'strong' ? STRONG_KEEP_SHARE : WEAK_KEEP_SHARE);
  });

  // Staat de H1 buiten het inhoudsblok (in een hero erboven), dan telt hij wel mee.
  const outsideH1 = root.querySelector('h1') ? null : body.querySelector('h1');
  const headings = [];
  const seen = new Set();
  for (const node of [...(outsideH1 ? [outsideH1] : []), ...root.querySelectorAll('h1, h2, h3, h4, h5, h6')]) {
    if (headings.length >= MAX_HEADINGS) break;
    const text = textOf(node);
    const key = normalize(text);
    // Veel templates zetten dezelfde koppen twee keer in de HTML (mobiel naast desktop).
    if (!text || seen.has(key)) continue;
    seen.add(key);
    headings.push({ level: node.rawTagName.toUpperCase(), text });
  }

  const collected = collectText(root);
  const h1 = headings.find((heading) => heading.level === 'H1')?.text || '';
  const text = (outsideH1 ? `${h1}\n${collected.text}` : collected.text).slice(0, MAX_PAGE_CHARS);
  return {
    title,
    metaDescription,
    h1,
    headings,
    text,
    intro: firstParagraph(collected.paragraphs, text, h1),
    wordCount: countWords(text),
  };
}

/**
 * Haalt één pagina op en leest hem uit. Gooit een fout met code en Nederlandse
 * uitleg, zodat de aanroeper kan kiezen: afbreken (doelpagina) of noteren en
 * doorgaan (concurrent).
 */
export async function fetchPage(rawUrl, { timeoutMs = 12_000, acceptLanguage = 'nl-NL,nl;q=0.9,en;q=0.8' } = {}) {
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
        'Accept-Language': acceptLanguage,
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
