/**
 * Hybride zoekwoorddata: Search Console (meting) samengevoegd met Ahrefs
 * (schatting), en de vlaggen die de frontend vertellen wat er gebruikt is.
 *
 * Search Console weet welke long-tail zoekopdrachten deze pagina echt vertoning
 * geven; Ahrefs weet hoeveel er in heel Nederland op gezocht wordt en welke
 * intentie erbij hoort. Samen geven ze het volledigste beeld. Lukt Search
 * Console niet, dan blijft Ahrefs over, zonder dat de analyse stopt.
 */

import { normalize } from './text.js';
import { GSC_STATUS } from './searchconsole.js';

export const DATA_SOURCE = {
  hybrid: 'hybrid_gsc_ahrefs',
  ahrefsOnly: 'ahrefs_only',
  gscOnly: 'gsc_only',
  gscUpload: 'gsc_upload',
  // Alleen de SERP van Serper: geen Ahrefs-sleutel en geen Search Console.
  serpOnly: 'serp_only',
};

/** Waar een zoekwoordrij vandaan komt: bepaalt het label in de UI en in de prompt. */
export const ROW_ORIGIN = { gsc: 'gsc', ahrefs: 'ahrefs', both: 'gsc+ahrefs', upload: 'upload' };

/**
 * Voegt beide lijsten samen op zoekwoord. Een zoekwoord dat in allebei staat,
 * houdt de gemeten cijfers van Search Console en krijgt volume, verkeer en
 * intenties van Ahrefs erbij. Search Console-rijen gaan voor (gesorteerd op
 * vertoningen), daarna wat alleen Ahrefs kent (gesorteerd op verkeer).
 */
export function mergeKeywordLists(gscRows = [], ahrefsRows = []) {
  const byKey = new Map();

  for (const row of gscRows) {
    const key = normalize(row.query);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, { ...row, volume: null, traffic: null, difficulty: null, intents: null, origin: ROW_ORIGIN.gsc });
  }

  for (const row of ahrefsRows) {
    const key = normalize(row.query);
    if (!key) continue;
    const existing = byKey.get(key);
    // Ahrefs geeft soms hetzelfde zoekwoord twee keer terug. Alleen een match met een
    // Search Console-rij maakt er "beide" van; anders zou een schatting als meting ogen.
    if (existing?.origin === ROW_ORIGIN.ahrefs) continue;
    if (existing) {
      byKey.set(key, {
        ...existing,
        volume: row.volume ?? null,
        traffic: row.traffic ?? null,
        difficulty: row.difficulty ?? null,
        intents: row.intents ?? null,
        ahrefsPosition: row.position ?? null,
        origin: ROW_ORIGIN.both,
      });
    } else {
      byKey.set(key, { ...row, origin: ROW_ORIGIN.ahrefs });
    }
  }

  const measured = [...byKey.values()].filter((row) => row.origin !== ROW_ORIGIN.ahrefs);
  const estimated = [...byKey.values()].filter((row) => row.origin === ROW_ORIGIN.ahrefs);
  measured.sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0) || (b.clicks ?? 0) - (a.clicks ?? 0));
  estimated.sort((a, b) => (b.traffic ?? 0) - (a.traffic ?? 0) || (b.volume ?? 0) - (a.volume ?? 0));
  return [...measured, ...estimated];
}

/** Komt deze rij (ook) uit Search Console? Dan is het een meting, anders een schatting. */
export function isMeasured(row) {
  return row?.origin === ROW_ORIGIN.gsc || row?.origin === ROW_ORIGIN.both || row?.origin === ROW_ORIGIN.upload;
}

/**
 * De vlaggen voor de frontend.
 *   source:    wat er in de data zit ('hybrid_gsc_ahrefs', 'ahrefs_only', 'gsc_only', 'gsc_upload', 'serp_only');
 *   gsc_error: Search Console werd geprobeerd en mislukte (bijvoorbeeld geen toegang).
 *              Niet gekoppeld, of wel toegang maar geen vertoningen, is geen fout.
 */
export function sourceFlags(gsc, { ahrefsUsed = true, upload = false } = {}) {
  if (upload) return { source: DATA_SOURCE.gscUpload, gsc_error: false };
  const gscUsed = gsc?.status === GSC_STATUS.ok;
  let source;
  if (gscUsed) source = ahrefsUsed ? DATA_SOURCE.hybrid : DATA_SOURCE.gscOnly;
  else source = ahrefsUsed ? DATA_SOURCE.ahrefsOnly : DATA_SOURCE.serpOnly;
  return { source, gsc_error: Boolean(gsc?.error) };
}

/** Wat de frontend over Search Console mag weten: status en herkomst, niet de sleutel of de ruwe fout. */
export function gscSummary(gsc) {
  if (!gsc) return null;
  return {
    status: gsc.status,
    message: gsc.message,
    property: gsc.property,
    page: gsc.page,
    startDate: gsc.startDate,
    endDate: gsc.endDate,
    rowCount: gsc.rows?.length ?? 0,
    pageTotals: gsc.pageTotals ?? null,
  };
}

/**
 * Wat Search Console zegt over de doelpagina en het focus zoekwoord: het bewijs
 * dat in de focus keyword-documenten van het team terugkomt ("688 vertoningen,
 * positie 5,5").
 */
export function pageInsight(gsc, keyword, { topCount = 15 } = {}) {
  if (gsc?.status !== GSC_STATUS.ok) return null;
  const wanted = normalize(keyword);
  const rows = gsc.rows || [];
  // Het paginatotaal als Search Console het gaf. Anders de som van de getoonde
  // zoekopdrachten, en dat zeggen we er dan ook bij: die som ligt lager.
  const totals = gsc.pageTotals
    ? { scope: 'pagina', impressions: gsc.pageTotals.impressions, clicks: gsc.pageTotals.clicks, position: gsc.pageTotals.position }
    : {
        scope: 'getoonde_zoekopdrachten',
        impressions: rows.reduce((sum, row) => sum + (row.impressions || 0), 0),
        clicks: rows.reduce((sum, row) => sum + (row.clicks || 0), 0),
        position: null,
      };
  return {
    focusKeyword: rows.find((row) => normalize(row.query) === wanted) || null,
    topQueries: rows.slice(0, topCount),
    totals: { queries: rows.length, ...totals },
  };
}
