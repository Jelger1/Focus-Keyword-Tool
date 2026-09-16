/**
 * POST /api/analyze
 *
 * Hybride content gap-analyse:
 *
 *   1. De doel-URL wordt echt opgehaald en hard gemeten: koppenstructuur,
 *      woordenaantal, titel, meta description en de volledige tekst.
 *   2. Claude levert de SERP-kant: welke onderwerpen, termen en vragen de
 *      topresultaten voor dit zoekwoord behandelen. Die kant is een schatting.
 *   3. Deze function toetst elke suggestie van Claude tegen de échte paginatekst.
 *      Alleen wat daar aantoonbaar ontbreekt, komt als "ontbrekend" terug.
 *
 * Stap 3 is het punt van de hele opzet: het model mag voorstellen doen, maar de
 * code bepaalt wat er daadwerkelijk mist. Zo staat er nooit een suggestie in het
 * rapport voor iets dat al op de pagina staat.
 *
 * De API-sleutel leeft alleen hier, nooit in de browser.
 */

import Anthropic from '@anthropic-ai/sdk';

// --- Instellingen ------------------------------------------------------------

const MODEL = 'claude-opus-5';

/**
 * Een analyse duurt hiermee ongeveer vijftig seconden. 'low' scheelde in de test
 * maar acht seconden — de wachttijd zit in de lengte van de JSON, niet in de
 * denkdiepte. Die acht seconden zijn de mindere suggesties niet waard.
 */
const EFFORT = 'medium';
const MAX_TOKENS = 16_000;

const FETCH_TIMEOUT_MS = 12_000;
const MAX_PAGE_CHARS = 120_000;   // ruwe tekst die we bewaren om suggesties tegen te toetsen
const MAX_SAMPLE_CHARS = 16_000;  // deel van die tekst dat we naar het model sturen
const MAX_HEADINGS = 60;
const MAX_KEYWORD_CHARS = 120;

// Best-effort rate limit. Serverless draait meerdere instances, dus dit is geen
// harde garantie — het vangt vooral dubbelklikken en losgeslagen scripts.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const recentRequests = new Map();

// --- Tekstnormalisatie --------------------------------------------------------

/** Kleine letters, accenten eraf, leestekens naar spaties. Basis voor elke vergelijking. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Nederlandse stopwoorden; die zeggen niets over onderwerpdekking. */
const STOPWORDS = new Set([
  'de', 'het', 'een', 'en', 'van', 'in', 'op', 'te', 'dat', 'die', 'is', 'voor', 'met', 'als',
  'zijn', 'er', 'aan', 'ook', 'je', 'om', 'uit', 'bij', 'naar', 'of', 'maar', 'dan', 'wat',
  'hoe', 'wie', 'waar', 'welke', 'niet', 'geen', 'wel', 'meer', 'over', 'door', 'tot', 'per',
  'u', 'we', 'wij', 'ze', 'zij', 'hun', 'hij', 'kan', 'kun', 'kunt', 'kunnen', 'moet', 'wordt',
  'worden', 'heeft', 'hebben', 'heb', 'was', 'waren', 'this', 'the', 'and', 'for', 'you',
]);

/**
 * Ruwe Nederlandse stam: haalt de meest voorkomende meervouds- en werkwoords-
 * uitgangen eraf, zodat "kosten" en "kost" of "panelen" en "paneel" als hetzelfde
 * begrip tellen. Geen echte stemmer — wel genoeg om te voorkomen dat de tool
 * adviseert iets toe te voegen dat in een andere verbuiging al op de pagina staat.
 */
function stem(word) {
  if (word.length > 5 && word.endsWith('en')) return word.slice(0, -2);
  if (word.length > 5 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith('e')) return word.slice(0, -1);
  return word;
}

function contentWords(text) {
  return normalize(text)
    .split(' ')
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map(stem);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Staat dit losse woord op de pagina? Op woordgrens, met ruimte voor verbuiging:
 * "dak" matcht niet op "dakkapel", maar "zonnepaneel" wel op "zonnepanelen".
 */
function wordOnPage(word, normalizedPage) {
  return new RegExp(`(^| )${escapeRegex(word)}[a-z]{0,3}( |$)`).test(normalizedPage);
}

/**
 * Staat deze term op de pagina? Een meerwoordsterm telt als aanwezig zodra álle
 * woorden ergens op de pagina staan — niet per se naast elkaar. Bewust ruim:
 * onterecht adviseren iets toe te voegen dat er al staat is vervelender dan een
 * gemiste suggestie.
 */
function appearsOnPage(term, normalizedPage) {
  const needle = normalize(term);
  if (!needle) return true; // lege term nooit als "ontbrekend" tonen
  if (normalizedPage.includes(needle)) return true;

  const words = needle.split(' ').filter((word) => word.length > 2 && !STOPWORDS.has(word));
  if (words.length === 0) return true;
  return words.every((word) => wordOnPage(stem(word), normalizedPage));
}

const STATUS_RANK = { ontbreekt: 0, tekst: 1, kop: 2 };

/**
 * Combineert het oordeel van het model met dat van de code. De hoogste van de
 * twee wint, dus de code kan de uitkomst alleen milder maken.
 *
 * Dat is bewust asymmetrisch. Het model ziet betekenis ("Kosten en opbrengst"
 * dekt een voorstel over prijzen) maar kan zich vergissen; de woordvergelijking
 * hieronder ziet alleen letterlijke overlap en is synoniem-blind. Door nooit naar
 * beneden bij te stellen, kan geen van beide een gat verzinnen dat er niet is.
 */
function settleStatus(fromModel, fromCode) {
  const model = STATUS_RANK[fromModel] ?? 0;
  const code = STATUS_RANK[fromCode] ?? 0;
  return Object.keys(STATUS_RANK).find((key) => STATUS_RANK[key] === Math.max(model, code));
}

/**
 * De letterlijke tegencheck: staan de onderscheidende woorden uit deze suggestie
 * al in een kop, of anders in de lopende tekst? Vangt het geval waarin het model
 * iets adviseert dat woord voor woord al op de pagina staat.
 *
 * De woorden uit het zoekwoord tellen niet mee: die staan overal op de pagina en
 * zouden elk onderwerp als "behandeld" laten lijken.
 */
function assessTopic(suggestion, { headings, normalizedText }, keywordWords) {
  const wanted = contentWords(suggestion).filter((word) => !keywordWords.has(word));
  if (wanted.length === 0) return 'kop'; // niets onderscheidends: geen advies van maken

  const inHeading = headings.some((heading) => {
    const present = new Set(contentWords(heading.text));
    if (present.size === 0) return false;
    const hits = wanted.filter((word) => present.has(word)).length;
    const ratio = hits / Math.min(wanted.length, present.size);
    return hits >= Math.min(2, wanted.length) && ratio >= 0.6;
  });
  if (inHeading) return 'kop';

  const hits = wanted.filter((word) => wordOnPage(word, normalizedText)).length;
  return hits / wanted.length >= 0.6 ? 'tekst' : 'ontbreekt';
}

// --- Pagina ophalen en uitlezen -----------------------------------------------

const URL_PATTERN = /^(https?:\/\/\S+|([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?)$/i;

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
 * koppen, titel en platte tekst is regex ruim genoeg. Navigatie, header en footer
 * gooien we eerst weg — anders tellen menu-items mee als paginatekst.
 */
function readPage(html) {
  const title = stripTags((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const metaDescription = decodeEntities(
    (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || ''
  ).trim();

  // Alles wat geen paginacontent is. Genest voorkomen van deze tags is zeldzaam;
  // lukt het strippen niet volledig, dan is het resultaat hooguit wat ruiziger.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template|form|select)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Veel templates zetten dezelfde koppen twee keer in de HTML (mobiel naast
  // desktop, of een inhoudsopgave boven het artikel). Eén keer tellen volstaat.
  const headings = [];
  const seenHeadings = new Set();
  const headingPattern = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = headingPattern.exec(cleaned)) !== null && headings.length < MAX_HEADINGS) {
    const text = stripTags(match[2]);
    const key = normalize(text);
    if (!text || seenHeadings.has(key)) continue;
    seenHeadings.add(key);
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

/** Fout met een code die de frontend kan vertalen naar een nette lege staat. */
function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function fetchPage(rawUrl) {
  if (!URL_PATTERN.test(rawUrl)) {
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
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
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
  } catch (error) {
    if (error.name === 'AbortError') {
      throw fail(504, 'timeout', `De pagina reageerde niet binnen ${FETCH_TIMEOUT_MS / 1000} seconden.`);
    }
    throw fail(502, 'fetch_failed', `De pagina kon niet opgehaald worden (${error.message}).`);
  } finally {
    clearTimeout(timer);
  }

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

  const page = readPage(await response.text());

  if (page.wordCount < 50) {
    throw fail(422, 'empty_page', 'Er kwam nauwelijks tekst uit deze pagina. Mogelijk is hij volledig client-side gerenderd of staat er een cookiemuur voor.');
  }

  return { ...page, url: parsed.href };
}

// --- De SERP-kant door Claude -------------------------------------------------

const SYSTEM_PROMPT = `Je bent een senior SEO-strateeg. Je analyseert welke onderwerpen de organische topresultaten voor een zoekwoord behandelen, zodat een marketeer weet wat er op de eigen pagina ontbreekt.

Je krijgt een zoekwoord en de structuur van één pagina. Je hebt geen live toegang tot Google: je baseert de SERP-kant op je kennis van hoe goed rankende pagina's voor dit type zoekwoord zijn opgebouwd. Dat is een onderbouwde inschatting, geen meting — overdrijf je zekerheid niet.

Werkwijze:
- Bepaal eerst de zoekintentie: wat wil iemand die dit intypt precies bereiken?
- Denk vanuit de volledige onderwerpdekking die een lezer verwacht, niet vanuit trucjes.
- Stel koppen voor die als H2 of H3 op de pagina kunnen staan. Schrijf ze uit zoals ze er letterlijk mogen komen: concreet, in het Nederlands, zonder jargon en zonder het zoekwoord er kunstmatig in te proppen.
- Noem semantische termen die inhoudelijk horen bij dit onderwerp: vaktermen, materialen, merken, regelgeving, kosten, alternatieven. Geen losse stopwoorden en geen varianten van hetzelfde woord.
- Formuleer vragen zoals een gebruiker ze in Google typt.

Beoordeel per onderwerp en per vraag ook of de pagina die al behandelt. Je ziet de volledige koppenstructuur en een groot deel van de tekst:
- "kop" — er staat een tussenkop over dit onderwerp, ook als die anders geformuleerd is. "Kosten en opbrengst" dekt bijvoorbeeld een voorstel over prijzen.
- "tekst" — het onderwerp komt inhoudelijk voor in de lopende tekst, maar heeft geen eigen kop.
- "ontbreekt" — er staat niets over.
Kijk daarbij naar betekenis, niet naar losse woorden. Bij twijfel kies je de hogere dekking: liever een gemiste suggestie dan een advies om iets toe te voegen dat er al staat.

Regels:
- Alles in het Nederlands, je-vorm.
- Verzin geen cijfers, prijzen of keurmerken. Blijf bij onderwerpen en vragen.
- Noem ook onderwerpen die de pagina al behandelt; de marketeer wil zien wat er wél goed staat.
- Lever tussen 8 en 14 onderwerpen, 10 en 20 termen en 4 en 8 vragen.`;

/** Het schema dwingt de vorm af; de inhoud toetsen we daarna zelf tegen de pagina. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    searchIntent: {
      type: 'string',
      description: 'Eén zin: wat wil de zoeker bereiken?',
    },
    intentType: {
      type: 'string',
      enum: ['informatief', 'commercieel', 'transactioneel', 'navigatie'],
    },
    benchmarkWordCount: {
      type: 'integer',
      description: 'Geschat mediaan woordenaantal van de organische top 10 voor dit zoekwoord.',
    },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'De kop zoals hij op de pagina mag komen.' },
          level: { type: 'string', enum: ['H2', 'H3'] },
          why: { type: 'string', description: 'Eén zin: waarom lezers dit verwachten.' },
          prevalence: {
            type: 'string',
            enum: ['vrijwel alle', 'meerdere', 'enkele'],
            description: 'Hoeveel topresultaten dit onderwerp behandelen.',
          },
          coverage: {
            type: 'string',
            enum: ['kop', 'tekst', 'ontbreekt'],
            description: 'Behandelt de opgegeven pagina dit onderwerp al? kop = eigen tussenkop, tekst = wel inhoudelijk maar zonder kop, ontbreekt = niet aanwezig.',
          },
          subheadings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nul tot drie H3-suggesties onder deze kop.',
          },
        },
        required: ['heading', 'level', 'why', 'prevalence', 'coverage', 'subheadings'],
        additionalProperties: false,
      },
    },
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          importance: { type: 'string', enum: ['hoog', 'middel', 'laag'] },
          context: { type: 'string', description: 'Korte uitleg waar deze term thuishoort.' },
        },
        required: ['term', 'importance', 'context'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          angle: { type: 'string', description: 'In één zin: wat het antwoord moet raken.' },
          coverage: {
            type: 'string',
            enum: ['kop', 'tekst', 'ontbreekt'],
            description: 'Beantwoordt de opgegeven pagina deze vraag al?',
          },
        },
        required: ['question', 'angle', 'coverage'],
        additionalProperties: false,
      },
    },
  },
  required: ['searchIntent', 'intentType', 'benchmarkWordCount', 'topics', 'terms', 'questions'],
  additionalProperties: false,
};

/**
 * Vraagt Claude om de SERP-kant.
 *
 * De pagina gaat samengevat mee (koppen plus een stuk tekst): het model hoeft
 * alleen te weten waar de pagina ongeveer over gaat, zodat het niet het
 * overduidelijke voorstelt. Wat er écht ontbreekt, bepaalt de code hierna.
 */
async function askClaude(client, { keyword, page }) {
  const userMessage = [
    `# Zoekwoord`,
    keyword,
    '',
    `# De pagina die moet ranken`,
    `URL: ${page.url}`,
    page.title && `Titel: ${page.title}`,
    page.metaDescription && `Meta description: ${page.metaDescription}`,
    `Woordenaantal: ${page.wordCount}`,
    '',
    '## Huidige koppenstructuur',
    page.headings.length
      ? page.headings.map((heading) => `${heading.level}: ${heading.text}`).join('\n')
      : '(geen koppen gevonden)',
    '',
    '## Begin van de paginatekst',
    page.text.slice(0, MAX_SAMPLE_CHARS),
  ]
    .filter((line) => line !== false && line !== undefined && line !== '')
    .join('\n');

  const request = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: userMessage }],
  };

  // Weigert het model een aanvraag (zeldzaam bij SEO-analyses), dan handelt
  // Anthropic dat server-side af op een ander model. Die beta staat niet op elk
  // account aan — vandaar de retry zonder.
  let message;
  try {
    message = await client.beta.messages.create({
      ...request,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (error) {
    const rejectedBeta = error?.status === 400 && /beta|fallback/i.test(error?.message || '');
    if (!rejectedBeta) throw error;
    console.warn('Server-side fallback niet beschikbaar, opnieuw zonder.');
    message = await client.messages.create(request);
  }

  if (message.stop_reason === 'refusal') {
    throw fail(502, 'refused', 'Het model heeft deze analyse geweigerd. Controleer het zoekwoord.');
  }

  const json = message.content.find((block) => block.type === 'text')?.text;
  if (!json) throw fail(502, 'empty_response', 'Het model gaf geen bruikbaar antwoord terug.');

  try {
    return { data: JSON.parse(json), usage: message.usage };
  } catch {
    throw fail(502, 'bad_json', 'Het antwoord van het model was geen geldige JSON.');
  }
}

// --- De twee kanten naast elkaar leggen ---------------------------------------

/**
 * Hier gebeurt de eigenlijke gap-analyse: elke suggestie van het model wordt
 * getoetst tegen de echte paginatekst. Wat al aanwezig is, verhuist naar de
 * "gedekt"-kant en telt mee voor de score in plaats van als advies te blijven staan.
 */
function buildReport({ keyword, page, serp }) {
  const normalizedText = normalize(`${page.text} ${page.title} ${page.metaDescription}`);
  const keywordWords = new Set(contentWords(keyword));
  const haystack = { headings: page.headings, normalizedText };

  const topics = (serp.topics || []).map((topic) => ({
    ...topic,
    subheadings: (topic.subheadings || []).filter(Boolean),
    status: settleStatus(topic.coverage, assessTopic(topic.heading, haystack, keywordWords)),
  }));

  const terms = (serp.terms || []).map((term) => ({
    ...term,
    present: appearsOnPage(term.term, normalizedText),
  }));

  const questions = (serp.questions || []).map((item) => ({
    ...item,
    status: settleStatus(item.coverage, assessTopic(item.question, haystack, keywordWords)),
  }));

  const missingTopics = topics.filter((topic) => topic.status === 'ontbreekt');
  const partialTopics = topics.filter((topic) => topic.status === 'tekst');
  const missingTerms = terms.filter((term) => !term.present);

  // Dekkingsgraad: onderwerpen wegen zwaarder dan losse termen, want een
  // ontbrekend onderwerp kost meer dan een ontbrekend synoniem. Een onderwerp dat
  // wel in de tekst staat maar geen eigen kop heeft, telt half mee.
  const topicScore = topics.length
    ? (topics.filter((topic) => topic.status === 'kop').length + partialTopics.length * 0.5) / topics.length
    : 0;
  const termScore = terms.length ? (terms.length - missingTerms.length) / terms.length : 0;
  const coverageScore = topics.length || terms.length
    ? Math.round((topicScore * 0.65 + termScore * 0.35) * 100)
    : null;

  const benchmark = Number.isFinite(serp.benchmarkWordCount) ? serp.benchmarkWordCount : null;

  return {
    keyword,
    generatedAt: new Date().toISOString(),
    page: {
      url: page.url,
      title: page.title,
      metaDescription: page.metaDescription,
      h1: page.h1,
      wordCount: page.wordCount,
      headings: page.headings,
    },
    intent: {
      summary: serp.searchIntent,
      type: serp.intentType,
    },
    coverage: {
      score: coverageScore,
      topicsWithHeading: topics.length - missingTopics.length - partialTopics.length,
      topicsInTextOnly: partialTopics.length,
      topicsMissing: missingTopics.length,
      topicsTotal: topics.length,
      termsPresent: terms.length - missingTerms.length,
      termsTotal: terms.length,
      wordCount: page.wordCount,
      benchmarkWordCount: benchmark,
      wordCountRatio: benchmark ? Math.round((page.wordCount / benchmark) * 100) : null,
    },
    missingTopics,
    partialTopics,
    coveredTopics: topics.filter((topic) => topic.status === 'kop'),
    missingTerms,
    presentTerms: terms.filter((term) => term.present),
    questions,
    disclaimer:
      'De pagina is echt opgehaald en gemeten. De vergelijking met de topresultaten is een inschatting op basis van modelkennis, geen live SERP-meting.',
  };
}

// --- Rate limit ---------------------------------------------------------------

function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'onbekend';
}

function withinRateLimit(key) {
  const now = Date.now();
  const timestamps = (recentRequests.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    recentRequests.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  recentRequests.set(key, timestamps);
  return true;
}

// --- Handler ------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Alleen POST wordt ondersteund.', code: 'method_not_allowed' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    // Wachtwoord is optioneel: staat APP_PASSWORD niet ingesteld, dan is de tool open.
    const requiredPassword = process.env.APP_PASSWORD;
    if (requiredPassword && req.headers['x-app-password'] !== requiredPassword) {
      throw fail(401, 'auth_required', 'Onjuist wachtwoord.');
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      throw fail(500, 'no_api_key', 'ANTHROPIC_API_KEY is niet ingesteld op de server.');
    }

    if (!withinRateLimit(clientKey(req))) {
      throw fail(429, 'rate_limited', 'Te veel analyses achter elkaar. Probeer het over een paar minuten opnieuw.');
    }

    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
    const url = String(body.url ?? '').trim();
    const keyword = String(body.keyword ?? '').trim();

    if (!url || !keyword) {
      throw fail(400, 'missing_input', 'Vul zowel de doel-URL als het primaire zoekwoord in.');
    }
    if (keyword.length > MAX_KEYWORD_CHARS) {
      throw fail(413, 'keyword_too_long', 'Gebruik één zoekwoord, geen hele zin.');
    }

    const startedAt = Date.now();
    const page = await fetchPage(url);

    const client = new Anthropic(); // leest ANTHROPIC_API_KEY uit de omgeving
    const { data, usage } = await askClaude(client, { keyword, page });
    const report = buildReport({ keyword, page, serp: data });

    // Verschijnt in Vercel onder Deployments -> Functions -> Logs.
    console.log(
      'Analyse afgerond:',
      JSON.stringify({
        seconden: Math.round((Date.now() - startedAt) / 100) / 10,
        zoekwoord: keyword,
        woorden: page.wordCount,
        koppen: page.headings.length,
        dekking: report.coverage.score,
        input_tokens: usage?.input_tokens,
        output_tokens: usage?.output_tokens,
        cache_gelezen: usage?.cache_read_input_tokens,
      })
    );

    res.status(200).json(report);
  } catch (error) {
    if (error.code && error.status) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }

    console.error('Analyse mislukt:', error);
    const message = error?.status === 401
      ? 'De API-key wordt geweigerd. Controleer ANTHROPIC_API_KEY.'
      : error?.status === 429
        ? 'Anthropic heeft een rate limit bereikt. Probeer het zo opnieuw.'
        : error?.message || 'Onbekende fout.';
    res.status(502).json({ error: message, code: 'analysis_failed' });
  }
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
