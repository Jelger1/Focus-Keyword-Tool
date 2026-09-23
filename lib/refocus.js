/**
 * Herfocus: een beter zoekwoord zoeken als de pagina niet bij het gekozen
 * zoekwoord past.
 *
 * B1: in de lijst zoekwoorden waarop de pagina al vertoond wordt (Search
 *     Console, of als schatting Ahrefs) zoekt Claude een zoekwoord dat wél bij
 *     het doel van de pagina past. De code controleert dat de keuze letterlijk
 *     in de lijst staat.
 * B2: staat er niets passends in, dan stelt Claude zelf zoekwoorden voor. De
 *     code haalt daarvan het zoekvolume bij Ahrefs op; alleen een voorstel met
 *     echt volume wordt het nieuwe focus zoekwoord.
 */

import { normalize } from './text.js';
import { DATA_SOURCE, ROW_ORIGIN } from './hybrid.js';

const MAX_ROWS_FOR_MODEL = 100;
const MAX_ALTERNATIVES = 4;
const MAX_PROPOSALS = 5;

/** Onder dit maandvolume telt een AI-voorstel niet als geverifieerd. */
export const MIN_PROPOSAL_VOLUME = 10;

export const REFOCUS_SYSTEM_PROMPT = `Je bent een senior SEO-strateeg. Een pagina past niet bij het focus zoekwoord dat ervoor gekozen was. Je zoekt een zoekwoord dat wél past bij wat de pagina is en wil bereiken.

Je krijgt:
- de doelpagina: URL, titel, H1, koppen en het begin van de tekst;
- het afgekeurde zoekwoord en waarom het niet paste;
- een genummerde lijst zoekwoorden waarop de pagina al vertoond wordt (Search Console, meting) of rankt (Ahrefs, schatting), met klikken, vertoningen en positie, en waar bekend zoekvolume, intenties en parent topic uit Ahrefs. Per zoekwoord staat tussen haken de bron: [Search Console], [Ahrefs] of [beide].

Werkwijze:
1. Zoek in de lijst naar zoekwoorden waarvan de zoekintentie past bij het doel van de pagina. Een zoekwoord past als iemand die het intypt precies deze pagina wil zien. Merknaam-zoekwoorden en zoekwoorden die eigenlijk bij een andere pagina van dezelfde site horen, tellen niet.
2. Weeg per kandidaat: past de intentie (doorslaggevend), zoekvolume en vertoningen (potentie), en de huidige positie (Google ziet de pagina hier al als relevant). Gemeten vertoningen uit Search Console wegen zwaarder dan een geschatte positie van Ahrefs.
3. Staat er een passend zoekwoord in de lijst, kies dan het beste als nieuw focus zoekwoord en noem tot vier alternatieven uit de lijst.
4. Staat er niets passends in de lijst, stel dan zelf drie tot vijf zoekwoorden voor die passen bij wat de pagina is, of hoe hij bedoeld is: concrete Nederlandse zoektermen zoals mensen ze intypen, van specifiek naar breder. De tool controleert hun zoekvolume bij Ahrefs.

Regels:
- Kies uit de lijst alleen zoekwoorden die er letterlijk in staan; de tool controleert dat.
- Verzin geen cijfers.
- Nederlands, je-vorm, concreet.`;

export const REFOCUS_SCHEMA = {
  type: 'object',
  properties: {
    pageSummary: { type: 'string', description: 'Eén of twee zinnen: wat deze pagina is en voor wie.' },
    found: { type: 'boolean', description: 'Staat er in de lijst een zoekwoord dat bij de pagina past?' },
    pick: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Letterlijk uit de lijst. Leeg als er niets past.' },
        why: { type: 'string', description: 'Waarom dit zoekwoord bij de pagina past.' },
      },
      required: ['keyword', 'why'],
      additionalProperties: false,
    },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Letterlijk uit de lijst.' },
          why: { type: 'string' },
          fit: { type: 'string', enum: ['goed', 'matig'] },
        },
        required: ['keyword', 'why', 'fit'],
        additionalProperties: false,
      },
    },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Een nieuw zoekwoord, zoals mensen het intypen.' },
          why: { type: 'string' },
        },
        required: ['keyword', 'why'],
        additionalProperties: false,
      },
      description: 'Alleen gevuld als er in de lijst niets past.',
    },
    rejected: { type: 'string', description: 'Eén of twee zinnen: waarom de rest van de lijst niet past.' },
  },
  required: ['pageSummary', 'found', 'pick', 'alternatives', 'proposals', 'rejected'],
  additionalProperties: false,
};

const formatNumber = (value) => (typeof value === 'number' ? value.toLocaleString('nl-NL') : null);

function intentFlags(intents) {
  if (!intents) return null;
  const active = Object.entries(intents).filter(([, on]) => on).map(([name]) => name);
  return active.length ? active.join('/') : 'geen';
}

/** Zodat Claude per zoekwoord ziet of het een meting of een schatting is. */
const ORIGIN_TAGS = {
  [ROW_ORIGIN.gsc]: '[Search Console]',
  [ROW_ORIGIN.upload]: '[Search Console]',
  [ROW_ORIGIN.ahrefs]: '[Ahrefs]',
  [ROW_ORIGIN.both]: '[beide]',
};

const LIST_LABELS = {
  [DATA_SOURCE.hybrid]: 'Zoekwoorden van de pagina: Search Console (meting) aangevuld met Ahrefs (schatting)',
  [DATA_SOURCE.gscOnly]: 'Zoekwoorden waarop de pagina vertoond wordt volgens Search Console (meting)',
  [DATA_SOURCE.gscUpload]: 'Zoekwoorden waarop de pagina vertoond wordt volgens Search Console (meting)',
  [DATA_SOURCE.ahrefsOnly]: 'Zoekwoorden waarop de pagina rankt volgens Ahrefs (schatting)',
};

/** Eén regel per zoekwoord, alleen met cijfers die er echt zijn. */
export function describeRow(row, metrics) {
  const parts = [];
  if (ORIGIN_TAGS[row.origin]) parts.push(ORIGIN_TAGS[row.origin]);
  if (row.clicks !== null && row.clicks !== undefined) parts.push(`${formatNumber(row.clicks)} klikken`);
  if (row.impressions !== null && row.impressions !== undefined) parts.push(`${formatNumber(row.impressions)} vertoningen`);
  // "Positie" betekent per bron iets anders: gemiddeld over een periode in Search
  // Console, de beste positie in Nederland bij Ahrefs. Zonder label vergelijkt
  // Claude appels met peren.
  const fmtPos = (value) => String(value).replace('.', ',');
  if (row.position !== null && row.position !== undefined) {
    parts.push(row.origin === ROW_ORIGIN.ahrefs
      ? `beste positie ${fmtPos(row.position)} (Ahrefs, NL)`
      : `gem. positie ${fmtPos(row.position)} (Search Console)`);
  }
  if (row.ahrefsPosition !== null && row.ahrefsPosition !== undefined) {
    parts.push(`beste positie ${fmtPos(row.ahrefsPosition)} (Ahrefs, NL)`);
  }
  if (row.traffic !== null && row.traffic !== undefined) parts.push(`${formatNumber(row.traffic)} bezoekers per maand (schatting)`);

  const ahrefs = [];
  const volume = metrics?.volume ?? row.volume;
  if (volume !== null && volume !== undefined) ahrefs.push(`volume ${formatNumber(volume)}`);
  const difficulty = metrics?.difficulty ?? row.difficulty;
  if (difficulty !== null && difficulty !== undefined) ahrefs.push(`KD ${difficulty}`);
  const intents = intentFlags(metrics?.intents ?? row.intents);
  if (intents) ahrefs.push(`intenties ${intents}`);
  if (metrics?.parentTopic) ahrefs.push(`parent topic "${metrics.parentTopic}"`);

  const facts = parts.filter((part) => !part.startsWith('['));
  const tag = parts.find((part) => part.startsWith('['));
  return `${tag ? `${tag} ` : ''}${facts.join(', ') || 'geen cijfers'}${ahrefs.length ? ` | Ahrefs: ${ahrefs.join(', ')}` : ''}`;
}

/** Wat de cijfers in de lijst betekenen: periode en landen van Search Console, bereik van Ahrefs. */
function listExplanation(source, gsc) {
  const lines = [];
  if (source === DATA_SOURCE.gscUpload) {
    lines.push('Search Console: vertoningen en klikken uit een export van de marketeer; periode en landen van de export zijn onbekend.');
  } else if (gsc?.startDate && (source === DATA_SOURCE.hybrid || source === DATA_SOURCE.gscOnly)) {
    lines.push(`Search Console: vertoningen en klikken van ${gsc.startDate} t/m ${gsc.endDate}, alle landen samen; gem. positie = gemiddelde over die periode.`);
  }
  if (source !== DATA_SOURCE.gscUpload && source !== DATA_SOURCE.gscOnly) {
    lines.push('Ahrefs: volume = zoekopdrachten per maand in Nederland; beste positie = de hoogste positie van deze URL in Nederland volgens Ahrefs; bezoekers per maand is een schatting.');
  }
  return lines;
}

export function buildRefocusMessage({ target, rejectedKeyword, intent, rows, metrics, source, gsc = null }) {
  const sourceLabel = LIST_LABELS[source] || LIST_LABELS[DATA_SOURCE.ahrefsOnly];

  const lines = [
    '# Doelpagina',
    `URL: ${target.url}`,
    `Titel: ${target.title || '(geen)'}`,
    `H1: ${target.h1 || '(geen)'}`,
    `Meta description: ${target.metaDescription || '(geen)'}`,
    '## Koppen',
    target.headings.length ? target.headings.slice(0, 25).map((heading) => `${heading.level}: ${heading.text}`).join('\n') : '(geen)',
    '## Begin van de tekst',
    target.text.slice(0, 2_000),
    '',
    '# Afgekeurd zoekwoord',
    rejectedKeyword,
    intent?.page?.summary ? `Doel van de pagina volgens de intent check: ${intent.page.summary}` : '',
    intent?.page?.pageType ? `Paginatype: ${intent.page.pageType}` : '',
    intent?.mismatch?.label ? `Soort mismatch: ${intent.mismatch.label}` : '',
    intent?.mismatch?.explanation ? `Uitleg: ${intent.mismatch.explanation}` : '',
    intent?.mismatch?.direction ? `Richting voor een beter zoekwoord: ${intent.mismatch.direction}` : '',
    '',
    `# ${sourceLabel}`,
    ...listExplanation(source, gsc),
    ...rows.slice(0, MAX_ROWS_FOR_MODEL).map((row, index) => `${index + 1}. "${row.query}": ${describeRow(row, metrics.get(normalize(row.query)))}`),
  ];

  return lines.filter((line) => line !== '' && line !== undefined).join('\n');
}

/**
 * Houdt het antwoord van Claude tegen de lijst: een keuze moet er letterlijk in
 * staan. Voorstellen (B2) komen ongecontroleerd terug; het endpoint haalt daar
 * eerst het zoekvolume van op.
 */
export function verifyRefocus(model, rows) {
  const byKey = new Map(rows.map((row) => [normalize(row.query), row]));
  const lookup = (keyword) => byKey.get(normalize(keyword));

  const seen = new Set();
  const fromList = [];
  const consider = (keyword, why, fit) => {
    const row = lookup(keyword);
    if (!row || seen.has(normalize(keyword))) return;
    seen.add(normalize(keyword));
    fromList.push({ keyword: row.query, why: String(why || ''), fit: fit === 'matig' ? 'matig' : 'goed', row });
  };

  if (model.found && model.pick?.keyword) consider(model.pick.keyword, model.pick.why, 'goed');
  for (const item of Array.isArray(model.alternatives) ? model.alternatives : []) {
    if (fromList.length > MAX_ALTERNATIVES) break;
    consider(item?.keyword, item?.why, item?.fit);
  }

  const proposals = (Array.isArray(model.proposals) ? model.proposals : [])
    .filter((item) => item?.keyword && String(item.keyword).trim())
    .slice(0, MAX_PROPOSALS)
    .map((item) => ({ keyword: String(item.keyword).trim().toLowerCase(), why: String(item.why || '') }));

  return {
    pageSummary: String(model.pageSummary || ''),
    rejected: String(model.rejected || ''),
    pick: fromList[0] || null,
    alternatives: fromList.slice(1),
    proposals,
  };
}
