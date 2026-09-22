/**
 * POST /api/refocus
 *
 * Stap 3B: de pagina past niet bij het zoekwoord, dus zoeken we een beter
 * zoekwoord bij de pagina.
 *
 *   1. De lijst zoekwoorden waarop de pagina al vertoond wordt: een Search
 *      Console-export (meting) of, zonder export, de rankende zoekwoorden
 *      volgens Ahrefs (schatting).
 *   2. De doelpagina opnieuw ophalen; we vertrouwen geen paginatekst uit de browser.
 *   3. De bovenste rijen verrijken met volume, intenties en parent topic (Ahrefs).
 *   4. Claude kiest een passend zoekwoord uit de lijst (B1) of stelt er zelf voor (B2).
 *   5. De code controleert: een keuze moet letterlijk in de lijst staan; een
 *      voorstel krijgt pas een plek als Ahrefs er zoekvolume voor kent.
 *
 * De frontend start daarna zelf een nieuwe analyse met het gekozen zoekwoord.
 */

import { fetchPage, fail } from '../lib/page.js';
import { fetchKeywordOverview, fetchOrganicKeywords } from '../lib/ahrefs.js';
import { createClient, askClaude, describeClaudeError } from '../lib/claude.js';
import { parseGscExport } from '../lib/gsc.js';
import {
  REFOCUS_SYSTEM_PROMPT, REFOCUS_SCHEMA, buildRefocusMessage, verifyRefocus, MIN_PROPOSAL_VOLUME,
} from '../lib/refocus.js';
import { normalize } from '../lib/text.js';
import { clientKey, withinRateLimit } from '../lib/ratelimit.js';

const MAX_KEYWORD_CHARS = 120;
const MAX_GSC_CHARS = 1_000_000;
const MAX_ROWS_FOR_MODEL = 100;
const MAX_ENRICHED_ROWS = 30;
const MAX_ROWS_IN_RESPONSE = 25;
const RATE_LIMIT_MAX = 20;

/** Alleen de velden uit de intent check die de prompt nodig heeft, afgekapt. */
function readIntent(raw) {
  const text = (value, max = 600) => String(value || '').slice(0, max);
  return {
    page: { pageType: text(raw?.page?.pageType, 80), summary: text(raw?.page?.summary) },
    mismatch: raw?.mismatch
      ? { label: text(raw.mismatch.label, 120), explanation: text(raw.mismatch.explanation), direction: text(raw.mismatch.direction) }
      : null,
  };
}

function withMetrics(item, metrics) {
  const found = metrics.get(normalize(item.keyword));
  return {
    keyword: item.keyword,
    why: item.why,
    fit: item.fit,
    volume: found?.volume ?? item.row?.volume ?? null,
    difficulty: found?.difficulty ?? item.row?.difficulty ?? null,
    intents: found?.intents ?? item.row?.intents ?? null,
    parentTopic: found?.parentTopic ?? null,
    row: item.row
      ? { clicks: item.row.clicks ?? null, impressions: item.row.impressions ?? null, position: item.row.position ?? null, traffic: item.row.traffic ?? null }
      : null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Alleen POST wordt ondersteund.', code: 'method_not_allowed' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');

  try {
    const requiredPassword = process.env.APP_PASSWORD;
    if (requiredPassword && req.headers['x-app-password'] !== requiredPassword) {
      throw fail(401, 'auth_required', 'Onjuist wachtwoord.');
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw fail(500, 'no_api_key', 'ANTHROPIC_API_KEY is niet ingesteld op de server.');
    }
    if (!withinRateLimit(clientKey(req), RATE_LIMIT_MAX)) {
      throw fail(429, 'rate_limited', 'Te veel aanvragen achter elkaar. Probeer het over een paar minuten opnieuw.');
    }

    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
    const url = String(body.url ?? '').trim();
    const rejectedKeyword = String(body.keyword ?? '').trim().slice(0, MAX_KEYWORD_CHARS);
    const source = body.source === 'ahrefs' ? 'ahrefs' : 'gsc';
    const intent = readIntent(body.intent);
    const round = Math.min(Math.max(Number.parseInt(body.round, 10) || 0, 0), 9);
    const ahrefsKey = process.env.AHREFS_API_KEY || null;

    if (!url || !rejectedKeyword) {
      throw fail(400, 'missing_input', 'De doel-URL en het afgekeurde zoekwoord ontbreken.');
    }

    const startedAt = Date.now();

    // --- 1. De lijst ------------------------------------------------------------------
    let rows;
    if (source === 'ahrefs') {
      if (!ahrefsKey) throw fail(500, 'no_ahrefs_key', 'AHREFS_API_KEY is niet ingesteld op de server.');
      rows = await fetchOrganicKeywords(url, { apiKey: ahrefsKey });
      if (rows.length === 0) {
        throw fail(404, 'ahrefs_no_keywords', 'Ahrefs kent geen zoekwoorden waarop deze URL rankt. Laad een Search Console-export in.');
      }
    } else {
      const text = String(body.gsc ?? '');
      if (!text.trim()) throw fail(400, 'gsc_empty', 'Er is geen Search Console-export meegestuurd.');
      if (text.length > MAX_GSC_CHARS) throw fail(413, 'gsc_too_large', 'Het bestand is groter dan 1 MB.');
      rows = parseGscExport(text);
    }

    // --- 2 en 3. Pagina en cijfers --------------------------------------------------------
    const [target, metrics] = await Promise.all([
      fetchPage(url),
      ahrefsKey
        ? fetchKeywordOverview(rows.slice(0, MAX_ENRICHED_ROWS).map((row) => row.query), { apiKey: ahrefsKey, detail: 'basic' })
            .catch((error) => {
              console.warn('Verrijking met Ahrefs mislukt:', error.message);
              return new Map();
            })
        : Promise.resolve(new Map()),
    ]);

    // --- 4. Claude kiest -------------------------------------------------------------------
    const client = createClient();
    const answer = await askClaude(client, {
      system: REFOCUS_SYSTEM_PROMPT,
      schema: REFOCUS_SCHEMA,
      message: buildRefocusMessage({ target, rejectedKeyword, intent, rows: rows.slice(0, MAX_ROWS_FOR_MODEL), metrics, source }),
      maxTokens: 4_000,
      effort: 'medium',
    });
    const verified = verifyRefocus(answer.data, rows);

    // --- 5. Controleren en, bij voorstellen, het volume opzoeken ------------------------------
    let proposals = verified.proposals.map((item) => ({ ...item, volume: null, difficulty: null, intents: null, parentTopic: null, verified: false }));
    if (!verified.pick && proposals.length && ahrefsKey) {
      const lookup = await fetchKeywordOverview(proposals.map((item) => item.keyword), { apiKey: ahrefsKey, detail: 'basic' })
        .catch((error) => {
          console.warn('Volume van voorstellen niet opgehaald:', error.message);
          return new Map();
        });
      proposals = proposals.map((item) => {
        const found = lookup.get(normalize(item.keyword));
        return {
          ...item,
          keyword: found?.keyword || item.keyword,
          volume: found?.volume ?? null,
          difficulty: found?.difficulty ?? null,
          intents: found?.intents ?? null,
          parentTopic: found?.parentTopic ?? null,
          verified: (found?.volume ?? 0) >= MIN_PROPOSAL_VOLUME,
        };
      });
    }

    let choice = null;
    if (verified.pick) {
      choice = { ...withMetrics(verified.pick, metrics), source, verified: true };
    } else {
      const usable = proposals.find((item) => item.verified);
      if (usable) choice = { ...usable, source: 'ai' };
    }

    log('Herfocus afgerond', startedAt, {
      bron: source,
      rijen: rows.length,
      keuze: choice?.keyword || null,
      keuze_bron: choice?.source || null,
      voorstellen: proposals.length,
      input_tokens: answer.usage?.input_tokens,
      output_tokens: answer.usage?.output_tokens,
    });

    res.status(200).json({
      source,
      round,
      rejectedKeyword,
      rowCount: rows.length,
      rows: rows.slice(0, MAX_ROWS_IN_RESPONSE).map((row) => {
        const found = metrics.get(normalize(row.query));
        return { ...row, volume: found?.volume ?? row.volume ?? null, intents: found?.intents ?? row.intents ?? null };
      }),
      pageSummary: verified.pageSummary,
      rejected: verified.rejected,
      choice,
      alternatives: verified.alternatives.map((item) => withMetrics(item, metrics)),
      proposals,
      note: source === 'ahrefs'
        ? 'De lijst is een schatting van Ahrefs, geen meting van Google. Klikken en vertoningen ontbreken daarom.'
        : 'De lijst komt uit jouw Search Console-export: gemeten vertoningen en klikken.',
    });
  } catch (error) {
    if (error.code && error.status) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    console.error('Herfocus mislukt:', error);
    res.status(502).json({ error: describeClaudeError(error), code: 'refocus_failed' });
  }
}

function log(label, startedAt, details) {
  console.log(`${label}:`, JSON.stringify({ seconden: Math.round((Date.now() - startedAt) / 100) / 10, ...details }));
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
