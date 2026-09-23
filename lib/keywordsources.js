/**
 * De lijst zoekwoorden waarop een pagina al vertoond wordt, uit de beste bron
 * die er is:
 *
 *   - upload: een Search Console-export die de marketeer zelf inlaadt (meting);
 *   - automatisch: Search Console via het service account (meting) en Ahrefs
 *     (schatting) tegelijk, samengevoegd. Heeft het service account geen
 *     toegang tot dit domein, dan blijft alleen Ahrefs over: de smart fallback.
 *
 * Geen van beide bronnen mag de andere tegenhouden. Alleen als er uit geen
 * enkele bron een zoekwoord komt, stopt de herfocus met een melding.
 */

import { fail } from './page.js';
import { fetchOrganicKeywords } from './ahrefs.js';
import { parseGscExport } from './gsc.js';
import { fetchPageQueries } from './searchconsole.js';
import { mergeKeywordLists, sourceFlags, gscSummary, isMeasured, DATA_SOURCE, ROW_ORIGIN } from './hybrid.js';

const MAX_UPLOAD_CHARS = 1_000_000;

const NOTES = {
  [DATA_SOURCE.gscUpload]: 'De lijst komt uit jouw Search Console-export: gemeten vertoningen en klikken.',
  [DATA_SOURCE.hybrid]: 'De lijst combineert Search Console (gemeten vertoningen en klikken van deze pagina) met Ahrefs (geschat zoekvolume en verkeer). Per zoekwoord staat de bron erbij.',
  [DATA_SOURCE.gscOnly]: 'De lijst komt uit Search Console: gemeten vertoningen en klikken van deze pagina.',
  [DATA_SOURCE.ahrefsOnly]: 'De lijst is een schatting van Ahrefs, geen meting van Google. Klikken en vertoningen ontbreken daarom.',
};

/** 'gsc' als een rij (ook) gemeten is, anders 'ahrefs': de bron van een gekozen zoekwoord. */
export function rowSource(row) {
  return isMeasured(row) ? 'gsc' : 'ahrefs';
}

/**
 * @param {'upload'|'auto'} options.mode
 * @param {string} options.pageUrl   de definitieve URL van de pagina (na redirects)
 * @returns {Promise<{rows: object[], source: string, gsc_error: boolean, gsc: object|null, note: string}>}
 */
export async function collectKeywordRows({ mode, pageUrl, uploadText, env, ahrefsKey }) {
  if (mode === 'upload') {
    const text = String(uploadText ?? '');
    if (!text.trim()) throw fail(400, 'gsc_empty', 'Er is geen Search Console-export meegestuurd.');
    if (text.length > MAX_UPLOAD_CHARS) throw fail(413, 'gsc_too_large', 'Het bestand is groter dan 1 MB.');
    const rows = parseGscExport(text).map((row) => ({ ...row, origin: ROW_ORIGIN.upload }));
    return { rows, ...sourceFlags(null, { upload: true }), gsc: null, note: NOTES[DATA_SOURCE.gscUpload] };
  }

  const [gsc, ahrefs] = await Promise.all([
    fetchPageQueries(pageUrl, { env }),
    ahrefsKey
      ? fetchOrganicKeywords(pageUrl, { apiKey: ahrefsKey }).then(
          (rows) => ({ rows, error: null }),
          (error) => ({ rows: [], error })
        )
      : Promise.resolve({ rows: [], error: fail(500, 'no_ahrefs_key', 'AHREFS_API_KEY is niet ingesteld op de server.') }),
  ]);
  if (ahrefs.error) console.warn('Ahrefs-zoekwoorden niet opgehaald:', ahrefs.error.message);

  const rows = mergeKeywordLists(gsc.rows, ahrefs.rows);
  if (rows.length === 0) {
    // Een Ahrefs-fout (geen sleutel, limiet, storing) is de echte oorzaak, niet "geen
    // zoekwoorden". Alleen als Ahrefs gewoon niets kent, klopt "nergens ranken".
    if (ahrefs.error) {
      const known = ahrefs.error.code && ahrefs.error.status;
      throw fail(
        known ? ahrefs.error.status : 502,
        known ? ahrefs.error.code : 'ahrefs_failed',
        `${known ? ahrefs.error.message : 'Ahrefs gaf een onverwachte fout.'} Search Console: ${gsc.message}`
      );
    }
    throw fail(
      404,
      'ahrefs_no_keywords',
      `Er zijn geen zoekwoorden gevonden voor deze URL. Ahrefs ziet hem nergens ranken. Search Console: ${gsc.message}`
    );
  }

  const flags = sourceFlags(gsc, { ahrefsUsed: ahrefs.rows.length > 0 });
  const gscNote = flags.source === DATA_SOURCE.ahrefsOnly ? ` Search Console is niet gebruikt: ${gsc.message}` : '';
  // Ahrefs kan falen, of gewoon niets weten: dat laatste is geen storing.
  const ahrefsNote = flags.source !== DATA_SOURCE.gscOnly
    ? ''
    : ahrefs.error ? ' Ahrefs-cijfers waren niet beschikbaar.' : ' Ahrefs ziet deze URL in Nederland niet ranken.';
  return { rows, ...flags, gsc: gscSummary(gsc), note: `${NOTES[flags.source]}${gscNote}${ahrefsNote}` };
}
