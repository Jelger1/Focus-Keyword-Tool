/**
 * De intent check: past de doelpagina bij wat de zoeker wil?
 *
 * Verdeling van het werk: de code meet (de paginatypes in de top 10, de
 * intentievlaggen van Ahrefs, de eigen positie, de topzoekwoorden van de
 * concurrenten), Claude oordeelt of de pagina daarbij past, en de code
 * controleert daarna elke positie die Claude als bewijs aanvoert. In de UI
 * staan meting en interpretatie apart.
 */

import { normalize, phraseCoverage } from './text.js';
import { topicHeadings } from './compare.js';
import { describePageType } from './pagetype.js';
import { DEFAULT_REGION, regionInstruction } from './region.js';
import { FACT_RULES } from './facts.js';

const MAX_TARGET_INTRO_CHARS = 2_500;
const MAX_TARGET_HEADINGS = 25;
const MAX_COMPETITOR_HEADINGS = 12;
const MAX_QUESTIONS = 6;
const MAX_REASONS = 6;
const INTRO_WORDS = 120;

export const INTENT_TYPES = ['informatief', 'commercieel', 'transactioneel', 'navigatie', 'lokaal'];
export const CONFIDENCE_LEVELS = ['hoog', 'middel', 'laag'];
export const MISMATCH_KINDS = ['geen', 'te_breed', 'te_specifiek', 'ander_paginatype', 'andere_intentie', 'merk_of_navigatie'];

export const MISMATCH_LABELS = {
  geen: 'geen mismatch',
  te_breed: 'zoekwoord is te breed voor deze pagina',
  te_specifiek: 'zoekwoord is te specifiek voor deze pagina',
  ander_paginatype: 'de SERP wil een ander soort pagina',
  andere_intentie: 'de zoeker wil iets anders dan de pagina biedt',
  merk_of_navigatie: 'zoekwoord is een merk- of navigatiezoekwoord',
  onbekend: 'past niet, reden niet benoemd',
};

// --- Meten -------------------------------------------------------------------------

/**
 * De harde feiten over de SERP, geteld door de code. Dit gaat als input naar
 * Claude én als "gemeten" naar de UI, zodat de marketeer het oordeel kan natrekken.
 */
export function measureSerp({ serp, serpResults }) {
  const byType = new Map();
  for (const result of serp.organic) {
    const type = describePageType(result.pageType);
    if (!type) continue;
    const entry = byType.get(type.label) || { label: type.label, family: type.family, count: 0, positions: [] };
    entry.count += 1;
    entry.positions.push(result.position);
    byType.set(type.label, entry);
  }
  const pageTypes = [...byType.values()].sort((a, b) => b.count - a.count || a.positions[0] - b.positions[0]);

  const byKeyword = new Map();
  for (const result of serp.organic) {
    if (!result.topKeyword) continue;
    const key = normalize(result.topKeyword);
    const entry = byKeyword.get(key) || { keyword: result.topKeyword, volume: result.topKeywordVolume ?? null, count: 0, positions: [] };
    entry.count += 1;
    entry.positions.push(result.position);
    byKeyword.set(key, entry);
  }

  const own = serpResults.find((result) => result.status === 'jouw pagina') || null;

  return {
    total: serp.organic.length,
    typed: pageTypes.reduce((sum, entry) => sum + entry.count, 0),
    pageTypes,
    dominant: pageTypes[0] || null,
    topKeywords: [...byKeyword.values()].sort((a, b) => b.count - a.count),
    features: serp.features || [],
    ownPosition: own ? own.position : null,
    ownPageType: own ? describePageType(own.pageType)?.label ?? null : null,
  };
}

/**
 * Staat het focus zoekwoord op de plekken die ertoe doen? Gemeten, niet
 * geïnterpreteerd; Claude schrijft alleen een nieuwe versie voor wat ontbreekt.
 */
export function keywordPlacement(target, keyword) {
  // De eerste echte alinea na de H1 (lib/page.js); zonder die alinea het begin van de tekst.
  const intro = target.intro || String(target.text || '').split(/\s+/).slice(0, INTRO_WORDS).join(' ');
  const check = (text) => ({ text: text || '', status: text ? phraseCoverage(text, keyword) : 'ontbreekt' });
  return {
    h1: check(target.h1),
    title: check(target.title),
    metaDescription: check(target.metaDescription),
    intro: check(intro),
  };
}

// --- Claude: oordelen ---------------------------------------------------------------

export const INTENT_SYSTEM_PROMPT = `Je bent een senior SEO-strateeg bij een online-marketingbureau. Je beoordeelt of een pagina past bij het focus zoekwoord dat ervoor gekozen is. De hoofdvraag: komt het doel van deze pagina overeen met de gemeenschappelijke zoekintentie van de Google-topresultaten voor dat zoekwoord?

Je krijgt:
- de doelpagina: URL, titel, meta description, H1, koppen en het begin van de tekst;
- het zoekwoord met cijfers van Ahrefs: zoekvolume, moeilijkheid, parent topic (het bredere onderwerp waarop de nummer 1 het meeste verkeer krijgt) en de intentievlaggen die Ahrefs eraan geeft;
- de top 10 van Google, genummerd op positie, met per resultaat titel, domein, het paginatype dat Ahrefs eraan toekent, het topzoekwoord van die pagina (waarop hij het meeste verkeer krijgt) en de koppen van de pagina als die opgehaald kon worden;
- de door de tool gemeten verdeling van paginatypes in de top 10, de topzoekwoorden van de concurrenten en de SERP-features (vragen, local pack, shopping);
- of de doelpagina zelf in de top 10 staat;
- als die beschikbaar is: Search Console-data van de doelpagina (een meting van Google): hoe vaak de pagina vertoond werd op het focus zoekwoord en op welke zoekopdrachten hij het vaakst vertoond wordt.

Werkwijze:
1. Bepaal het paginatype en het doel van de doelpagina: wat wil deze pagina voor wie bereiken? Denk aan productoverzicht, productpagina, dienstpagina, gids of uitleg, homepage, tool, vergelijking.
2. Bepaal de dominante intentie en het dominante paginatype van de SERP. Kijk naar de meerderheid, niet naar één uitschieter. Het parent topic en de topzoekwoorden van de concurrenten vertellen of de SERP eigenlijk over een breder of ander onderwerp gaat dan het zoekwoord zelf.
3. Oordeel: past de pagina bij die SERP? "Ja" betekent: een pagina van dit type met dit doel kan realistisch met deze top 10 concurreren. "Nee" betekent: de zoeker verwacht iets anders dan deze pagina biedt, of het zoekwoord is te breed of te specifiek voor deze pagina.
4. Onderbouw elk argument met posities uit de top 10. De tool controleert die posities; noem alleen posities die in de input staan.
5. Bij "nee": benoem het soort mismatch en de richting waarin een beter zoekwoord gezocht moet worden (specifieker, breder, ander paginatype, andere intentie). Kies zelf nog geen zoekwoord.

Regels:
- Staat de doelpagina zelf al hoog in de top 10, dan is dat sterk bewijs voor een match, maar geen garantie: een pagina kan ranken op een zoekwoord dat niet bij zijn doel past.
- De intentievlaggen van Ahrefs zijn een signaal, geen oordeel: bijna elk commercieel zoekwoord heeft ook een informatieve vlag.
- Search Console is een meting en weegt zwaarder dan de schattingen van Ahrefs. Veel vertoningen op een goede positie voor het focus zoekwoord steunt een match. Valt het gros van de vertoningen op heel andere zoekopdrachten, dan ziet Google de pagina kennelijk als antwoord op iets anders: noem dat als argument. Ontbreekt Search Console, oordeel dan zonder en verzin er niets bij.
- Van de concurrenten zie je titel, paginatype, topzoekwoord en koppen, niet hun lopende tekst: beweer niets over wat een concurrent zegt of aanbiedt dat daar niet uit blijkt.
- Alles in het Nederlands, je-vorm, concreet, zonder jargon dat een contentschrijver niet kent.

${FACT_RULES}`;

export const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    page: {
      type: 'object',
      properties: {
        pageType: { type: 'string', description: 'Soort pagina, in twee tot vier woorden.' },
        intentType: { type: 'string', enum: INTENT_TYPES },
        summary: { type: 'string', description: 'Eén of twee zinnen: wat wil deze pagina voor wie bereiken?' },
      },
      required: ['pageType', 'intentType', 'summary'],
      additionalProperties: false,
    },
    serp: {
      type: 'object',
      properties: {
        dominantPageType: { type: 'string', description: 'Het paginatype dat de meerderheid van de top 10 heeft.' },
        intentType: { type: 'string', enum: INTENT_TYPES },
        summary: { type: 'string', description: 'Eén of twee zinnen: wat wil de zoeker die dit intypt?' },
        positions: { type: 'array', items: { type: 'integer' }, description: 'De posities die samen de dominante groep vormen.' },
      },
      required: ['dominantPageType', 'intentType', 'summary', 'positions'],
      additionalProperties: false,
    },
    match: { type: 'boolean', description: 'Past het doel van de pagina bij de intentie van de SERP?' },
    confidence: { type: 'string', enum: CONFIDENCE_LEVELS },
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Eén argument, in één of twee zinnen.' },
          positions: { type: 'array', items: { type: 'integer' }, description: 'De posities uit de top 10 die dit argument onderbouwen.' },
        },
        required: ['text', 'positions'],
        additionalProperties: false,
      },
    },
    mismatch: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: MISMATCH_KINDS, description: '"geen" bij een match.' },
        explanation: { type: 'string', description: 'Bij een mismatch: waarom pagina en SERP uit elkaar lopen. Leeg bij een match.' },
        direction: { type: 'string', description: 'Bij een mismatch: in welke richting een beter zoekwoord ligt, zonder er zelf een te kiezen. Leeg bij een match.' },
      },
      required: ['kind', 'explanation', 'direction'],
      additionalProperties: false,
    },
  },
  required: ['page', 'serp', 'match', 'confidence', 'reasons', 'mismatch'],
  additionalProperties: false,
};

const formatNumber = (value) => (typeof value === 'number' ? value.toLocaleString('nl-NL') : 'onbekend');

function intentFlags(intents) {
  if (!intents) return 'onbekend';
  const active = Object.entries(intents).filter(([, on]) => on).map(([name]) => name);
  return active.length ? active.join(', ') : 'geen';
}

/**
 * De Search Console-regels voor het bericht: alleen gemeten cijfers, met wat
 * ze precies betekenen, en eerlijk als ze ontbreken.
 */
function searchConsoleLines(gscInsight, gsc, region) {
  if (!gscInsight) {
    return ['# Search Console van de doelpagina', `Niet beschikbaar (${gsc?.message || 'niet gekoppeld'}). Noem dus geen klikken, vertoningen of gemiddelde posities uit Search Console.`];
  }
  const position = (value) => (typeof value === 'number' ? String(value).replace('.', ',') : 'onbekend');
  const row = (item) => `${formatNumber(item.impressions)} vertoningen, ${formatNumber(item.clicks)} klikken, gemiddelde positie ${position(item.position)}`;
  const { focusKeyword, topQueries, totals } = gscInsight;
  const totalLine = totals.scope === 'pagina'
    ? `Hele pagina: ${formatNumber(totals.impressions)} vertoningen, ${formatNumber(totals.clicks)} klikken, gemiddelde positie ${position(totals.position)}. Daarvan zijn ${formatNumber(totals.queries)} zoekopdrachten zichtbaar; de rest heeft Google geanonimiseerd.`
    : `Som van de ${formatNumber(totals.queries)} zoekopdrachten die Search Console toont: ${formatNumber(totals.impressions)} vertoningen, ${formatNumber(totals.clicks)} klikken (geanonimiseerde zoekopdrachten ontbreken, het paginatotaal ligt hoger).`;
  return [
    `# Search Console van de doelpagina (meting van Google, ${gsc.startDate} t/m ${gsc.endDate}, ${gsc.country ? `alleen ${region.label}` : 'alle landen samen'})`,
    'Positie is hier de gemiddelde positie over die periode, niet de positie van vandaag.',
    totalLine,
    focusKeyword
      ? `Focus zoekwoord: ${row(focusKeyword)}`
      : 'Focus zoekwoord: staat niet tussen de zoekopdrachten die Search Console toont (geen vertoningen, of geanonimiseerd).',
    'Zoekopdrachten met de meeste vertoningen:',
    ...topQueries.map((item) => `- ${item.query}: ${row(item)}`),
  ];
}

export function buildIntentMessage({ keyword, target, serp, serpResults, keywordInfo, measured, providerLabel, gsc = null, gscInsight = null, region = DEFAULT_REGION }) {
  const lines = [regionInstruction(region), '', '# Zoekwoord', keyword, ''];

  if (keywordInfo) {
    lines.push(
      '## Cijfers van Ahrefs',
      `Zoekvolume: ${formatNumber(keywordInfo.volume)} per maand · Moeilijkheid: ${formatNumber(keywordInfo.difficulty)}`,
      keywordInfo.parentTopic
        ? `Parent topic: ${keywordInfo.parentTopic} (${formatNumber(keywordInfo.parentVolume)} per maand)`
        : 'Parent topic: onbekend',
      `Intentievlaggen: ${intentFlags(keywordInfo.intents)}`,
      keywordInfo.serpFeatures.length ? `SERP-features volgens Ahrefs: ${keywordInfo.serpFeatures.join(', ')}` : ''
    );
  } else {
    lines.push('## Cijfers van Ahrefs', 'Ahrefs kent dit zoekwoord niet: geen volume, geen moeilijkheid, geen intentievlaggen. Noem dus geen zoekvolume voor dit zoekwoord.');
  }

  lines.push(
    '',
    '# Doelpagina',
    `URL: ${target.url}`,
    `Titel: ${target.title || '(geen)'}`,
    `Meta description: ${target.metaDescription || '(geen)'}`,
    `H1: ${target.h1 || '(geen)'}`,
    `Woordenaantal: ${target.wordCount}`,
    '## Koppen',
    target.headings.length
      ? target.headings.slice(0, MAX_TARGET_HEADINGS).map((heading) => `${heading.level}: ${heading.text}`).join('\n')
      : '(geen koppen gevonden)',
    '## Begin van de tekst',
    target.text.slice(0, MAX_TARGET_INTRO_CHARS),
    '',
    ...searchConsoleLines(gscInsight, gsc, region),
    '',
    `# Top 10 van Google (${providerLabel})`
  );

  lines.push(
    measured.pageTypes.length
      ? `Gemeten verdeling paginatypes (${measured.typed} van ${measured.total} resultaten getypeerd): ` +
          measured.pageTypes.map((entry) => `${entry.label} ${entry.count}× (posities ${entry.positions.join(', ')})`).join(' · ')
      : 'Paginatypes: niet beschikbaar bij deze bron.',
    measured.topKeywords.length
      ? 'Topzoekwoorden van de concurrenten: ' +
          measured.topKeywords.map((entry) => `${entry.keyword} ${entry.count}× (${formatNumber(entry.volume)} per maand)`).join(' · ')
      : '',
    measured.features.length
      ? 'SERP-features: ' + measured.features.map((feature) => `${feature.type} ${feature.count}×`).join(', ')
      : 'SERP-features: geen',
    measured.ownPosition ? `Doelpagina in de top 10: ja, op positie ${measured.ownPosition}` : 'Doelpagina in de top 10: nee'
  );

  const byUrl = new Map(serpResults.map((result) => [result.url, result]));
  for (const result of serp.organic) {
    const fetched = byUrl.get(result.url);
    const type = describePageType(result.pageType);
    lines.push(
      '',
      `## [${result.position}] ${result.domain}`,
      `Titel: ${result.title}`,
      result.snippet ? `Snippet: ${result.snippet}` : '',
      `Paginatype (Ahrefs): ${type ? `${type.label} (${type.raw})` : 'onbekend'}`,
      result.topKeyword ? `Topzoekwoord: ${result.topKeyword} (${formatNumber(result.topKeywordVolume)} per maand)` : '',
      `Status: ${fetched ? fetched.status : 'niet opgehaald'}${fetched?.reason ? ` (${fetched.reason})` : ''}`
    );
    if (fetched?.page) {
      const headings = topicHeadings(fetched.page).slice(0, MAX_COMPETITOR_HEADINGS);
      lines.push(headings.length ? `Koppen: ${headings.map((heading) => `${heading.level} ${heading.text}`).join(' | ')}` : 'Koppen: geen');
    }
  }

  if (serp.peopleAlsoAsk.length) {
    lines.push('', '# Mensen vragen ook', ...serp.peopleAlsoAsk.slice(0, MAX_QUESTIONS).map((item) => `- ${item.question}`));
  }

  return lines.filter((line) => line !== '' && line !== undefined).join('\n');
}

// --- Controleren ---------------------------------------------------------------------

/**
 * Houdt het oordeel van Claude tegen de SERP: posities die niet bestaan
 * verdwijnen, zodat elk argument in de UI naar een echt resultaat wijst.
 */
export function verifyIntent(model, { serp }) {
  const valid = new Set(serp.organic.map((result) => result.position));
  const clean = (positions) =>
    [...new Set((Array.isArray(positions) ? positions : []).map(Number).filter((position) => valid.has(position)))].sort((a, b) => a - b);

  const match = Boolean(model.match);
  const kind = MISMATCH_KINDS.includes(model.mismatch?.kind) ? model.mismatch.kind : 'onbekend';

  return {
    match,
    confidence: CONFIDENCE_LEVELS.includes(model.confidence) ? model.confidence : 'middel',
    page: {
      pageType: String(model.page?.pageType || ''),
      intentType: INTENT_TYPES.includes(model.page?.intentType) ? model.page.intentType : 'onbekend',
      summary: String(model.page?.summary || ''),
    },
    serp: {
      dominantPageType: String(model.serp?.dominantPageType || ''),
      intentType: INTENT_TYPES.includes(model.serp?.intentType) ? model.serp.intentType : 'onbekend',
      summary: String(model.serp?.summary || ''),
      positions: clean(model.serp?.positions),
    },
    reasons: (Array.isArray(model.reasons) ? model.reasons : [])
      .filter((reason) => reason?.text)
      .slice(0, MAX_REASONS)
      .map((reason) => ({ text: String(reason.text), positions: clean(reason.positions) })),
    mismatch: match
      ? null
      : {
          kind: kind === 'geen' ? 'onbekend' : kind,
          label: MISMATCH_LABELS[kind === 'geen' ? 'onbekend' : kind],
          explanation: String(model.mismatch?.explanation || ''),
          direction: String(model.mismatch?.direction || ''),
        },
  };
}
