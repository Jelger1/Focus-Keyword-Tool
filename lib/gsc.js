/**
 * Leest een Search Console-export in.
 *
 * De marketeer exporteert in Search Console het prestatierapport van één
 * pagina (Prestaties, filter op pagina, Exporteren) en laadt dat bestand hier
 * in. We accepteren CSV met Nederlandse of Engelse koppen (komma, puntkomma of
 * tab) en JSON in de vorm van de Search Console API of een simpele lijst.
 * Dit is echte data van Google: de zoekwoorden waarop de pagina al vertoond
 * wordt. De tool leest, telt en sorteert; het verzint er niets bij.
 */

import { fail } from './page.js';

const MAX_CHARS = 1_000_000;
const MAX_ROWS = 5_000;

/** Kopnamen zoals Search Console en de gangbare exports ze noemen. */
const COLUMN_ALIASES = {
  query: [
    'meest gebruikte zoekopdrachten', 'zoekopdrachten', 'zoekopdracht', 'top queries', 'queries', 'query',
    'zoekwoord', 'zoekwoorden', 'zoekterm', 'zoektermen', 'keyword', 'keywords', 'search query',
  ],
  clicks: ['klikken', 'clicks', 'kliks'],
  impressions: ['vertoningen', 'impressions', 'impressies', 'weergaven'],
  ctr: ['ctr', 'klikfrequentie', 'click-through rate'],
  position: ['positie', 'position', 'gemiddelde positie', 'average position', 'avg. position', 'gem. positie'],
};

/**
 * @returns {Array<{query: string, clicks: number|null, impressions: number|null, ctr: number|null, position: number|null}>}
 *          gesorteerd op vertoningen, hoogste eerst
 */
export function parseGscExport(raw) {
  const text = String(raw ?? '').replace(/^﻿/, '');
  if (text.length > MAX_CHARS) {
    throw fail(413, 'gsc_too_large', 'Het bestand is groter dan 1 MB. Exporteer alleen het tabblad Zoekopdrachten van één pagina.');
  }
  const trimmed = text.trim();
  if (!trimmed) throw fail(400, 'gsc_empty', 'Het bestand is leeg.');

  const records = /^[[{]/.test(trimmed) ? recordsFromJson(trimmed) : recordsFromCsv(trimmed);
  const rows = normalizeRecords(records);
  if (rows.length === 0) {
    throw fail(
      422,
      'gsc_no_queries',
      'Er zijn geen zoekopdrachten herkend. Controleer of het bestand een kolom met zoekopdrachten en een kolom met vertoningen heeft.'
    );
  }
  return rows;
}

// --- JSON ---------------------------------------------------------------------

function recordsFromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw fail(400, 'gsc_bad_json', 'Het JSON-bestand kon niet gelezen worden.');
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.rows) ? data.rows : Array.isArray(data?.data) ? data.data : null;
  if (!list) throw fail(422, 'gsc_no_queries', 'De JSON bevat geen lijst met rijen.');

  return list
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      // De Search Console API zet de zoekopdracht in `keys`; exports zetten hem in een kolom.
      const record = { ...item };
      if (Array.isArray(item.keys) && item.keys.length) record.query = item.keys[0];
      return pickColumns(record);
    });
}

// --- CSV ----------------------------------------------------------------------

function recordsFromCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) throw fail(422, 'gsc_no_queries', 'Het bestand bevat alleen een koprij.');

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter).map(normalizeHeader);
  const columns = mapHeaders(headers, lines.slice(1, 6).map((line) => parseCsvLine(line, delimiter)));

  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line, delimiter);
    const record = {};
    for (const [field, index] of Object.entries(columns)) {
      if (index !== null && index < cells.length) record[field] = cells[index];
    }
    return record;
  });
}

/** Kiest het scheidingsteken dat het vaakst in de koprij staat. */
function detectDelimiter(headerLine) {
  let best = ',';
  let bestCount = -1;
  for (const candidate of ['\t', ';', ',']) {
    const count = headerLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Splitst één regel, met respect voor aanhalingstekens ("a, b" blijft één cel). */
function parseCsvLine(line, delimiter) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

function normalizeHeader(header) {
  return String(header || '').toLowerCase().replace(/^["']+|["']+$/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Koppelt kolommen aan velden op naam. Staat er geen herkenbare kop boven de
 * zoekopdrachten, dan nemen we de eerste kolom als die geen getallen bevat.
 */
function mapHeaders(headers, sampleRows) {
  const columns = { query: null, clicks: null, impressions: null, ctr: null, position: null };

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const exact = headers.findIndex((header) => aliases.includes(header));
    if (exact >= 0) {
      columns[field] = exact;
      continue;
    }
    const loose = headers.findIndex((header) => aliases.some((alias) => header.includes(alias)));
    if (loose >= 0) columns[field] = loose;
  }

  if (columns.query === null) {
    const firstIsText = sampleRows.every((cells) => cells[0] && !/^[\d.,\s%]+$/.test(cells[0]));
    if (firstIsText) columns.query = 0;
  }
  return columns;
}

// --- Normaliseren -------------------------------------------------------------

/** Zoekt in een los object de velden op naam, ongeacht hoofdletters of taal. */
function pickColumns(record) {
  const lower = new Map(Object.keys(record).map((key) => [normalizeHeader(key), record[key]]));
  const picked = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (field in record) {
      picked[field] = record[field];
      continue;
    }
    const alias = aliases.find((name) => lower.has(name));
    if (alias) picked[field] = lower.get(alias);
  }
  return picked;
}

/** Hele getallen (klikken, vertoningen): alle scheidingstekens weg. */
function parseCount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const digits = String(value ?? '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

/**
 * Decimalen (positie, CTR): "5,5" en "5.5" zijn allebei vijfenhalf. Staan beide
 * tekens erin, dan is het laatste de decimaal en het andere een duizendtal.
 */
function parseDecimal(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value ?? '').replace(/[\s% ]/g, '');
  if (!text) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    text = lastComma > lastDot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    text = text.replace(',', '.');
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

/** CTR als percentage: "12,5%" en 0.125 worden allebei 12,5. */
function parseCtr(value) {
  const number = parseDecimal(value);
  if (number === null) return null;
  const isPercentText = typeof value === 'string' && value.includes('%');
  const percent = !isPercentText && number <= 1 ? number * 100 : number;
  return Math.round(percent * 10) / 10;
}

function normalizeRecords(records) {
  const byQuery = new Map();

  for (const record of records) {
    const query = String(record.query ?? '').replace(/\s+/g, ' ').trim();
    if (!query || query.length > 200) continue;

    const row = {
      query,
      clicks: parseCount(record.clicks),
      impressions: parseCount(record.impressions),
      ctr: parseCtr(record.ctr),
      position: record.position === undefined ? null : roundTo(parseDecimal(record.position), 1),
    };

    // Dezelfde zoekopdracht kan meerdere keren voorkomen (per apparaat of land):
    // de rij met de meeste vertoningen telt.
    const key = query.toLowerCase();
    const existing = byQuery.get(key);
    if (!existing || (row.impressions ?? 0) > (existing.impressions ?? 0)) byQuery.set(key, row);
  }

  return [...byQuery.values()]
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0) || (b.clicks ?? 0) - (a.clicks ?? 0))
    .slice(0, MAX_ROWS);
}

function roundTo(value, decimals) {
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
