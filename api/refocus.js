/**
 * POST /api/refocus
 *
 * Stap 3B: de pagina past niet bij het zoekwoord, dus zoeken we een beter
 * zoekwoord bij de pagina.
 *
 *   1. De doelpagina opnieuw ophalen; we vertrouwen geen paginatekst uit de browser.
 *   2. De lijst zoekwoorden waarop de pagina al vertoond wordt: een Search
 *      Console-export die de marketeer inlaadt, of automatisch Search Console
 *      via het service account plus Ahrefs, samengevoegd. Geen toegang tot
 *      Search Console? Dan alleen Ahrefs (lib/keywordsources.js).
 *   3. Rijen zonder zoekvolume verrijken met volume, intenties en parent topic (Ahrefs).
 *   4. Claude kiest een passend zoekwoord uit de lijst (B1) of stelt er zelf voor (B2).
 *   5. De code controleert: een keuze moet letterlijk in de lijst staan; een
 *      voorstel krijgt pas een plek als Ahrefs er zoekvolume voor kent.
 *
 * De frontend start daarna zelf een nieuwe analyse met het gekozen zoekwoord.
 * Alles gebeurt in de gekozen regio; vraagt de browser erom, dan meldt het
 * endpoint elke fase terwijl hij bezig is (lib/progress.js).
 */

import { fetchPage, fail } from '../lib/page.js';
import { fetchKeywordOverview } from '../lib/ahrefs.js';
import { createClient, askClaude, describeClaudeError } from '../lib/claude.js';
import { collectKeywordRows, rowSource } from '../lib/keywordsources.js';
import {
  REFOCUS_SYSTEM_PROMPT, REFOCUS_SCHEMA, buildRefocusMessage, verifyRefocus, MIN_PROPOSAL_VOLUME,
} from '../lib/refocus.js';
import { normalize } from '../lib/text.js';
import { clientKey, withinRateLimit } from '../lib/ratelimit.js';
import { passwordOk } from '../lib/auth.js';
import { readRegion } from '../lib/region.js';
import { factBase, groundRefocus, factCheckSummary, logRemovedClaims } from '../lib/facts.js';
import { createProgress } from '../lib/progress.js';

const MAX_KEYWORD_CHARS = 120;
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
    // Per zoekwoord: gemeten (Search Console) of geschat (Ahrefs). Bepaalt het label in de UI.
    source: rowSource(item.row),
    volume: found?.volume ?? item.row?.volume ?? null,
    difficulty: found?.difficulty ?? item.row?.difficulty ?? null,
    intents: found?.intents ?? item.row?.intents ?? null,
    parentTopic: found?.parentTopic ?? null,
    row: item.row
      ? {
          clicks: item.row.clicks ?? null,
          impressions: item.row.impressions ?? null,
          position: item.row.position ?? null,
          traffic: item.row.traffic ?? null,
          origin: item.row.origin ?? null,
        }
      : null,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Alleen POST wordt ondersteund.', code: 'method_not_allowed' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  const progress = createProgress(req, res);

  try {
    // Wachtwoord is optioneel: staat APP_PASSWORD niet ingesteld, dan is de tool open.
    if (!passwordOk(req, process.env)) {
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
    // 'gsc' = de marketeer stuurt een export mee. Al het andere ('auto', en 'ahrefs'
    // van de bestaande knop) = automatisch: Search Console via het service account plus Ahrefs.
    const mode = body.source === 'gsc' ? 'upload' : 'auto';
    const intent = readIntent(body.intent);
    const round = Math.min(Math.max(Number.parseInt(body.round, 10) || 0, 0), 9);
    const region = readRegion(body.region);
    const ahrefsKey = process.env.AHREFS_API_KEY || null;

    if (!url || !rejectedKeyword) {
      throw fail(400, 'missing_input', 'De doel-URL en het afgekeurde zoekwoord ontbreken.');
    }

    const startedAt = Date.now();

    // --- 1. De pagina: eerst, want Search Console wil de definitieve URL na redirects ---
    progress.step('pagina', 'active', 'Pagina opnieuw ophalen');
    const target = await fetchPage(url, { acceptLanguage: region.acceptLanguage });
    progress.step('pagina', 'done', `Pagina opgehaald: ${target.wordCount.toLocaleString('nl-NL')} woorden`);
    // Elke volgende stap kost Ahrefs-units: bij een afgehaakte gebruiker hier stoppen.
    progress.throwIfGone();

    // --- 2. De lijst: export, of Search Console plus Ahrefs met fallback ------------------
    progress.step('bronnen', 'active', mode === 'upload'
      ? 'Je Search Console-export inlezen'
      : `Search Console en Ahrefs raadplegen (${region.label})`);
    const list = await collectKeywordRows({
      mode, pageUrl: target.url, uploadText: body.gsc, env: process.env, ahrefsKey, region,
    });
    const { rows } = list;
    progress.step('bronnen', 'done', `${rows.length.toLocaleString('nl-NL')} zoekwoorden gevonden`, {
      source: list.source, gsc_error: list.gsc_error, gsc: list.gsc,
    });

    // --- 3. Alleen rijen zonder volume verrijken: de rest heeft het al van Ahrefs --------
    const unenriched = rows.filter((row) => row.volume === null || row.volume === undefined).slice(0, MAX_ENRICHED_ROWS);
    let metrics = new Map();
    if (ahrefsKey && unenriched.length) {
      progress.throwIfGone();
      progress.step('verrijken', 'active', `Zoekvolumes aanvullen bij Ahrefs (${region.label})`);
      metrics = await fetchKeywordOverview(unenriched.map((row) => row.query), { apiKey: ahrefsKey, detail: 'basic', country: region.ahrefsCountry })
        .catch((error) => {
          console.warn('Verrijking met Ahrefs mislukt:', error.message);
          return new Map();
        });
      progress.step('verrijken', 'done', `${metrics.size} zoekvolumes aangevuld`);
    }

    // --- 4. Claude kiest -------------------------------------------------------------------
    progress.throwIfGone();
    progress.step('kiezen', 'active', 'Claude zoekt een zoekwoord dat bij de pagina past');
    const client = createClient();
    const refocusMessage = buildRefocusMessage({
      target, rejectedKeyword, intent, rows: rows.slice(0, MAX_ROWS_FOR_MODEL), metrics, source: list.source, gsc: list.gsc, region,
    });
    const answer = await askClaude(client, {
      system: REFOCUS_SYSTEM_PROMPT,
      schema: REFOCUS_SCHEMA,
      message: refocusMessage,
      maxTokens: 4_000,
      effort: 'medium',
    });
    // Eerst de cijfers in de uitleg, daarna de keuze tegen de lijst.
    const facts = groundRefocus(answer.data, factBase(refocusMessage));
    logRemovedClaims('herfocus', facts.removed);
    const verified = verifyRefocus(facts.model, rows);
    progress.step('kiezen', 'done', verified.pick
      ? `Gevonden in de lijst: "${verified.pick.keyword}"`
      : 'Niets passends in de lijst: Claude stelt zelf zoekwoorden voor');

    // --- 5. Controleren en, bij voorstellen, het volume opzoeken ------------------------------
    let proposals = verified.proposals.map((item) => ({ ...item, volume: null, difficulty: null, intents: null, parentTopic: null, verified: false }));
    if (!verified.pick && proposals.length && ahrefsKey) {
      progress.throwIfGone();
      progress.step('controle', 'active', `Zoekvolume van de voorstellen checken bij Ahrefs (${region.label})`);
      const lookup = await fetchKeywordOverview(proposals.map((item) => item.keyword), { apiKey: ahrefsKey, detail: 'basic', country: region.ahrefsCountry })
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
      progress.step('controle', 'done', `${proposals.filter((item) => item.verified).length} van ${proposals.length} voorstellen hebben zoekvolume`);
    }

    let choice = null;
    if (verified.pick) {
      choice = { ...withMetrics(verified.pick, metrics), verified: true };
    } else {
      const usable = proposals.find((item) => item.verified);
      if (usable) choice = { ...usable, source: 'ai' };
    }

    log('Herfocus afgerond', startedAt, {
      bron: list.source,
      regio: region.id,
      gsc: list.gsc?.status ?? 'upload',
      rijen: rows.length,
      keuze: choice?.keyword || null,
      keuze_bron: choice?.source || null,
      voorstellen: proposals.length,
      cijfers_weggelaten: facts.removed.length,
      input_tokens: answer.usage?.input_tokens,
      output_tokens: answer.usage?.output_tokens,
    });

    progress.send(200, {
      // source: wat er in de lijst zit ('hybrid_gsc_ahrefs', 'ahrefs_only', 'gsc_only', 'gsc_upload');
      // gsc_error: Search Console werd geprobeerd en mislukte. Details in gsc.status en gsc.message.
      source: list.source,
      gsc_error: list.gsc_error,
      gsc: list.gsc,
      region: region.id,
      round,
      rejectedKeyword,
      factCheck: factCheckSummary(facts.removed),
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
      note: list.note,
    });
  } catch (error) {
    if (error.code === 'client_gone') {
      console.log('Herfocus afgebroken: de gebruiker startte iets anders.');
      return;
    }
    if (error.code && error.status) {
      progress.send(error.status, { error: error.message, code: error.code });
      return;
    }
    console.error('Herfocus mislukt:', error);
    progress.send(502, { error: describeClaudeError(error), code: 'refocus_failed' });
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
