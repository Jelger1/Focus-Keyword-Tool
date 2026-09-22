/**
 * POST /api/analyze
 *
 * Stap 1 en 2 van de tool, en bij een match ook stap 3A:
 *
 *   1. Doelpagina, SERP (Ahrefs) en zoekwoordcijfers tegelijk ophalen; daarna
 *      de top 10 parallel ophalen en op dezelfde manier meten.
 *   2. Intent check: de code meet de verdeling van paginatypes, Claude oordeelt
 *      of de pagina bij de SERP past, de code controleert de geciteerde posities.
 *   3A. Match: zoekwoordideeën (Ahrefs), termen tellen, vragen verzamelen, twee
 *      Claude-calls naast elkaar (onderwerpen en woordkeuze), de code controleert
 *      elke bron (lib/compare.js). Het antwoord is het complete rapport.
 *   3B. Geen match: het antwoord stopt na de intent check; de frontend biedt
 *      dan de herfocus aan (api/refocus.js).
 *
 * Sleutels leven alleen hier, nooit in de browser.
 */

import { fetchPage, fail } from '../lib/page.js';
import { chooseSerpProvider, fetchSerp, describeSerpProvider } from '../lib/serp.js';
import { fetchKeywordOverview, fetchKeywordIdeas } from '../lib/ahrefs.js';
import { createClient, askClaude, describeClaudeError } from '../lib/claude.js';
import {
  fetchCompetitors, termCandidates, collectQuestions, buildReport, mappingCandidates, serpSummary, pageSummary,
} from '../lib/compare.js';
import { measureSerp, keywordPlacement, INTENT_SYSTEM_PROMPT, INTENT_SCHEMA, buildIntentMessage, verifyIntent } from '../lib/intent.js';
import {
  GAP_TOPICS_SYSTEM_PROMPT, GAP_TOPICS_SCHEMA, buildGapTopicsMessage,
  GAP_TERMS_SYSTEM_PROMPT, GAP_TERMS_SCHEMA, buildGapTermsMessage,
} from '../lib/gap.js';
import { describePageType } from '../lib/pagetype.js';
import { normalize } from '../lib/text.js';
import { clientKey, withinRateLimit } from '../lib/ratelimit.js';

const MAX_KEYWORD_CHARS = 120;

/** Onder dit aantal vergeleken concurrenten is er geen patroon te herkennen. */
const MIN_COMPETITORS = 2;

/** Na zoveel herfocusrondes stopt de tool en kiest de marketeer zelf. */
const MAX_ROUNDS = 2;

const RATE_LIMIT_MAX = 20;

const ORIGIN_SOURCES = new Set(['handmatig', 'gsc', 'ahrefs', 'ai']);

/** Waar het zoekwoord vandaan komt: handmatig ingevuld, of gekozen in een herfocusronde. */
function readOrigin(raw) {
  const source = ORIGIN_SOURCES.has(raw?.source) ? raw.source : 'handmatig';
  const round = Math.min(Math.max(Number.parseInt(raw?.round, 10) || 0, 0), 9);
  return {
    source,
    round,
    previousKeyword: String(raw?.previousKeyword || '').slice(0, MAX_KEYWORD_CHARS),
    why: String(raw?.why || '').slice(0, 600),
  };
}

/**
 * Aanvullende Ahrefs-data mag de analyse niet laten vallen: mislukt de call,
 * dan gaat de analyse door zonder en zegt de UI dat de cijfers ontbreken.
 */
function optional(promise, label) {
  return promise.then(
    (value) => ({ value, error: null }),
    (error) => {
      console.warn(`${label} niet opgehaald:`, error.message);
      return { value: null, error: error.message };
    }
  );
}

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
    // Zonder echte Google-resultaten valt er niets te vergelijken. Bewust geen
    // terugval op geschatte data: dan zou het rapport metingen suggereren die er niet zijn.
    const serpAccess = chooseSerpProvider(process.env);
    const ahrefsKey = process.env.AHREFS_API_KEY || null;

    if (!withinRateLimit(clientKey(req), RATE_LIMIT_MAX)) {
      throw fail(429, 'rate_limited', 'Te veel analyses achter elkaar. Probeer het over een paar minuten opnieuw.');
    }

    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
    const url = String(body.url ?? '').trim();
    const keyword = String(body.keyword ?? '').trim();
    const origin = readOrigin(body.origin);

    if (!url || !keyword) {
      throw fail(400, 'missing_input', 'Vul zowel de doel-URL als het focus zoekwoord in.');
    }
    if (keyword.length > MAX_KEYWORD_CHARS) {
      throw fail(413, 'keyword_too_long', 'Gebruik één zoekwoord, geen hele zin.');
    }

    const startedAt = Date.now();

    // Doelpagina, SERP en zoekwoordcijfers tegelijk: ze hangen niet van elkaar af.
    const [target, serp, keywordLookup] = await Promise.all([
      fetchPage(url),
      fetchSerp(keyword, serpAccess),
      ahrefsKey
        ? optional(fetchKeywordOverview([keyword], { apiKey: ahrefsKey }), 'Zoekwoordcijfers')
        : Promise.resolve({ value: null, error: null }),
    ]);
    const keywordInfo = keywordLookup.value ? keywordLookup.value.get(normalize(keyword)) || null : null;

    // De zoekwoordideeën zijn pas nodig bij een match, maar starten nu al: dan
    // staan ze klaar zodra de intent check klaar is. Bij een mismatch kost dat
    // een paar honderd Ahrefs-units, tegenover een halve minuut wachten bij een match.
    const ideasPromise = ahrefsKey
      ? optional(fetchKeywordIdeas(keyword, { apiKey: ahrefsKey }), 'Zoekwoordideeën')
      : Promise.resolve({ value: [], error: null });

    const serpResults = await fetchCompetitors(serp.organic, target);
    const compared = serpResults.filter((result) => result.status === 'vergeleken');

    if (compared.length < MIN_COMPETITORS) {
      throw fail(
        502,
        'too_few_competitors',
        `Van de top 10 konden er maar ${compared.length} opgehaald worden. Te weinig om een patroon te zien.`
      );
    }

    const providerLabel = describeSerpProvider(serp.provider, serp.updatedAt);
    const measured = measureSerp({ serp, serpResults });
    const placement = keywordPlacement(target, keyword);

    // --- Stap 2: intent check ------------------------------------------------------
    const client = createClient();
    const intentAnswer = await askClaude(client, {
      system: INTENT_SYSTEM_PROMPT,
      schema: INTENT_SCHEMA,
      message: buildIntentMessage({ keyword, target, serp, serpResults, keywordInfo, measured, providerLabel }),
      maxTokens: 4_000,
      effort: 'medium',
    });
    const intent = verifyIntent(intentAnswer.data, { serp });

    const base = {
      keyword,
      origin,
      generatedAt: new Date().toISOString(),
      serp: serpSummary(serp, serpResults, providerLabel),
      page: pageSummary(target),
      keywordInfo,
      keywordInfoError: keywordLookup.error,
      measured,
      intent,
      placement,
      maxRounds: MAX_ROUNDS,
    };

    if (!intent.match) {
      log('Intent check: geen match', startedAt, {
        zoekwoord: keyword,
        ronde: origin.round,
        mismatch: intent.mismatch?.kind,
        input_tokens: intentAnswer.usage?.input_tokens,
        output_tokens: intentAnswer.usage?.output_tokens,
      });
      res.status(200).json({
        stage: 'intent',
        ...base,
        nextStep: origin.round >= MAX_ROUNDS ? 'handmatig' : 'refocus',
      });
      return;
    }

    // --- Stap 3A: content gap, keyword mapping en optimalisatie --------------------------
    const ideas = await ideasPromise;
    const mapping = mappingCandidates(ideas.value || [], serp, keyword);
    const candidates = termCandidates(compared.map((competitor) => competitor.page), target, keyword);
    const questions = collectQuestions(serp.peopleAlsoAsk, compared);
    const pageTypeOf = (raw) => describePageType(raw)?.label || raw;

    // Twee calls naast elkaar: onderwerpen (met de koppen van alle concurrenten) en
    // woordkeuze (termen, mapping, nieuwe teksten). Samen in één call duurde ruim
    // twee minuten; zo is het de helft.
    const [topicsAnswer, termsAnswer] = await Promise.all([
      askClaude(client, {
        system: GAP_TOPICS_SYSTEM_PROMPT,
        schema: GAP_TOPICS_SCHEMA,
        message: buildGapTopicsMessage({ keyword, target, compared, questions, intent, pageTypeOf }),
        maxTokens: 16_000,
        effort: 'medium',
      }),
      askClaude(client, {
        system: GAP_TERMS_SYSTEM_PROMPT,
        schema: GAP_TERMS_SCHEMA,
        message: buildGapTermsMessage({ keyword, target, compared, candidates, intent, placement, mappingCandidates: mapping, pageTypeOf }),
        maxTokens: 8_000,
        effort: 'medium',
      }),
    ]);

    const report = buildReport({
      keyword, target, serp, serpResults, compared, candidates, questions,
      model: { ...topicsAnswer.data, ...termsAnswer.data },
      mappingCandidates: mapping, placement, providerLabel,
    });

    const usage = [intentAnswer, topicsAnswer, termsAnswer].map((answer) => answer.usage || {});
    log('Analyse afgerond', startedAt, {
      zoekwoord: keyword,
      ronde: origin.round,
      vergeleken: compared.length,
      mislukt: serpResults.filter((result) => result.status === 'mislukt').length,
      onderwerpen: report.coverage.topicsTotal,
      onderwerpen_zonder_bron: report.quality.droppedTopics,
      mapping_afgekeurd: report.quality.droppedMapping,
      ideeen: (ideas.value || []).length,
      dekking: report.coverage.score,
      input_tokens: usage.reduce((sum, item) => sum + (item.input_tokens || 0), 0),
      output_tokens: usage.reduce((sum, item) => sum + (item.output_tokens || 0), 0),
    });

    res.status(200).json({ stage: 'compleet', ...base, ...report, ideasError: ideas.error });
  } catch (error) {
    if (error.code && error.status) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    console.error('Analyse mislukt:', error);
    res.status(502).json({ error: describeClaudeError(error), code: 'analysis_failed' });
  }
}

/** Verschijnt in Vercel onder Deployments -> Functions -> Logs. */
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
