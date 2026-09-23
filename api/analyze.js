/**
 * POST /api/analyze
 *
 * Stap 1 en 2 van de tool, en bij een match ook stap 3A:
 *
 *   1. Doelpagina, SERP (Ahrefs) en zoekwoordcijfers tegelijk ophalen; daarna
 *      de top 10 parallel ophalen en op dezelfde manier meten. Tegelijk met die
 *      top 10 probeert de tool Search Console voor deze pagina (service account).
 *      Geen toegang? Dan loopt alles door op de Ahrefs-data (smart fallback).
 *   2. Intent check: de code meet de verdeling van paginatypes, Claude oordeelt
 *      of de pagina bij de SERP past, de code controleert de geciteerde posities.
 *   3A. Match: zoekwoordideeën (Ahrefs), termen tellen, vragen verzamelen, twee
 *      Claude-calls naast elkaar (onderwerpen en woordkeuze), de code controleert
 *      elke bron (lib/compare.js). Het antwoord is het complete rapport.
 *   3B. Geen match: het antwoord stopt na de intent check; de frontend biedt
 *      dan de herfocus aan (api/refocus.js).
 *
 * Alles gebeurt in de gekozen regio (lib/region.js). Vraagt de browser erom,
 * dan meldt het endpoint elke fase terwijl hij bezig is (lib/progress.js).
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
import { fetchPageQueries, GSC_STATUS } from '../lib/searchconsole.js';
import { sourceFlags, gscSummary, pageInsight } from '../lib/hybrid.js';
import { readRegion } from '../lib/region.js';
import { createProgress } from '../lib/progress.js';
import { factBase, groundIntent, groundGapTopics, groundGapTerms, factCheckSummary, logRemovedClaims } from '../lib/facts.js';
import { normalize } from '../lib/text.js';
import { clientKey, withinRateLimit } from '../lib/ratelimit.js';
import { passwordOk } from '../lib/auth.js';

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

/** Wat de frontend over de bron moet weten, zodra het bekend is: ook al tijdens het laden. */
function sourceInfo(gsc, flags) {
  return { source: flags.source, gsc_error: flags.gsc_error, gsc: gscSummary(gsc) };
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
    const region = readRegion(body.region);

    if (!url || !keyword) {
      throw fail(400, 'missing_input', 'Vul zowel de doel-URL als het focus zoekwoord in.');
    }
    if (keyword.length > MAX_KEYWORD_CHARS) {
      throw fail(413, 'keyword_too_long', 'Gebruik één zoekwoord, geen hele zin.');
    }

    const startedAt = Date.now();

    // --- Stap 1: verzamelen ------------------------------------------------------------
    progress.step('bronnen', 'active', `Pagina, Google-top 10 (${region.label}) en zoekwoordcijfers ophalen`);
    const [target, serp, keywordLookup] = await Promise.all([
      fetchPage(url, { acceptLanguage: region.acceptLanguage }),
      fetchSerp(keyword, { ...serpAccess, region }),
      ahrefsKey
        ? optional(fetchKeywordOverview([keyword], { apiKey: ahrefsKey, country: region.ahrefsCountry }), 'Zoekwoordcijfers')
        : Promise.resolve({ value: null, error: null }),
    ]);
    const keywordInfo = keywordLookup.value ? keywordLookup.value.get(normalize(keyword)) || null : null;
    progress.step('bronnen', 'done', `Top 10 opgehaald: ${serp.organic.length} resultaten. Jouw pagina: ${target.wordCount.toLocaleString('nl-NL')} woorden.`);

    // Afgehaakt tijdens het ophalen? Dan geen Ahrefs-ideeën en geen concurrenten meer.
    progress.throwIfGone();

    // De zoekwoordideeën zijn pas nodig bij een match, maar starten nu al: dan
    // staan ze klaar zodra de intent check klaar is. Bij een mismatch kost dat
    // een paar honderd Ahrefs-units, tegenover een halve minuut wachten bij een match.
    const ideasPromise = ahrefsKey
      ? optional(fetchKeywordIdeas(keyword, { apiKey: ahrefsKey, country: region.ahrefsCountry }), 'Zoekwoordideeën')
      : Promise.resolve({ value: [], error: null });

    // Search Console wil de definitieve URL na redirects, dus pas na de pagina. Het loopt
    // parallel met de top 10 en gooit nooit: bij geen toegang komt er een status terug.
    progress.step('lezen', 'active', 'Concurrenten lezen en Search Console raadplegen');
    const gscPromise = fetchPageQueries(target.url, { env: process.env, region });
    const [serpResults, gsc] = await Promise.all([
      fetchCompetitors(serp.organic, target, { acceptLanguage: region.acceptLanguage }),
      gscPromise,
    ]);
    const compared = serpResults.filter((result) => result.status === 'vergeleken');
    const gscInsight = pageInsight(gsc, keyword);
    // Ahrefs telt als gebruikt als de SERP of de zoekwoordcijfers van Ahrefs komen;
    // bij een match komen de zoekwoordideeën er later nog bij.
    const ahrefsInIntent = serp.provider === 'ahrefs' || Boolean(keywordInfo);
    const flags = sourceFlags(gsc, { ahrefsUsed: ahrefsInIntent });
    progress.step('lezen', 'done', `${compared.length} van ${serp.organic.length} concurrenten gelezen. Search Console: ${gsc.message}`, sourceInfo(gsc, flags));

    if (compared.length < MIN_COMPETITORS) {
      throw fail(
        502,
        'too_few_competitors',
        `Van de top 10 konden er maar ${compared.length} opgehaald worden. Te weinig om een patroon te zien.`
      );
    }

    const providerLabel = describeSerpProvider(serp.provider, serp.updatedAt, region);
    const measured = measureSerp({ serp, serpResults });
    const placement = keywordPlacement(target, keyword);

    // --- Stap 2: intent check ------------------------------------------------------
    progress.throwIfGone();
    progress.step('intent', 'active', 'Claude beoordeelt of je pagina past bij de zoekintentie');
    const client = createClient();
    const intentMessage = buildIntentMessage({ keyword, target, serp, serpResults, keywordInfo, measured, providerLabel, gsc, gscInsight, region });
    const intentAnswer = await askClaude(client, {
      system: INTENT_SYSTEM_PROMPT,
      schema: INTENT_SCHEMA,
      message: intentMessage,
      maxTokens: 4_000,
      effort: 'medium',
    });
    // Eerst de cijfers: een getal dat niet in het bericht stond, haalt het rapport niet.
    const intentFacts = groundIntent(intentAnswer.data, factBase(intentMessage));
    const intent = verifyIntent(intentFacts.model, { serp });
    progress.step('intent', 'done', intent.match ? 'Match: de pagina past bij dit zoekwoord' : 'Geen match: de pagina past niet bij dit zoekwoord');

    const base = {
      keyword,
      origin,
      region: region.id,
      generatedAt: new Date().toISOString(),
      serp: serpSummary(serp, serpResults, providerLabel),
      page: pageSummary(target),
      keywordInfo,
      keywordInfoError: keywordLookup.error,
      measured,
      intent,
      placement,
      maxRounds: MAX_ROUNDS,
      // source: 'hybrid_gsc_ahrefs' als Search Console-data meegenomen is, anders 'ahrefs_only'.
      // gsc_error: Search Console werd geprobeerd en mislukte (bijvoorbeeld geen toegang).
      source: flags.source,
      gsc_error: flags.gsc_error,
      gsc: { ...gscSummary(gsc), insight: gscInsight },
      factCheck: factCheckSummary(intentFacts.removed),
    };
    logRemovedClaims('intent check', intentFacts.removed);

    if (!intent.match) {
      log('Intent check: geen match', startedAt, {
        zoekwoord: keyword,
        regio: region.id,
        ronde: origin.round,
        mismatch: intent.mismatch?.kind,
        gsc: gsc.status,
        input_tokens: intentAnswer.usage?.input_tokens,
        output_tokens: intentAnswer.usage?.output_tokens,
      });
      progress.send(200, {
        stage: 'intent',
        ...base,
        nextStep: origin.round >= MAX_ROUNDS ? 'handmatig' : 'refocus',
      });
      return;
    }

    // --- Stap 3A: content gap, keyword mapping en optimalisatie --------------------------
    progress.throwIfGone();
    progress.step('aanbevelingen', 'active', 'Claude schrijft de aanbevelingen: onderwerpen, termen en keyword mapping');
    const ideas = await ideasPromise;
    const mapping = mappingCandidates(ideas.value || [], serp, keyword, gsc.status === GSC_STATUS.ok ? gsc.rows : []);
    const candidates = termCandidates(compared.map((competitor) => competitor.page), target, keyword, { region });
    const questions = collectQuestions(serp.peopleAlsoAsk, compared);
    const pageTypeOf = (raw) => describePageType(raw)?.label || raw;

    // Twee calls naast elkaar: onderwerpen (met de koppen van alle concurrenten) en
    // woordkeuze (termen, mapping, nieuwe teksten). Samen in één call duurde ruim
    // twee minuten; zo is het de helft.
    const topicsMessage = buildGapTopicsMessage({ keyword, target, compared, questions, intent, pageTypeOf, region });
    const termsMessage = buildGapTermsMessage({ keyword, target, compared, candidates, intent, placement, mappingCandidates: mapping, pageTypeOf, region });
    const [topicsAnswer, termsAnswer] = await Promise.all([
      askClaude(client, {
        system: GAP_TOPICS_SYSTEM_PROMPT,
        schema: GAP_TOPICS_SCHEMA,
        message: topicsMessage,
        maxTokens: 16_000,
        effort: 'medium',
      }),
      askClaude(client, {
        system: GAP_TERMS_SYSTEM_PROMPT,
        schema: GAP_TERMS_SCHEMA,
        message: termsMessage,
        maxTokens: 8_000,
        effort: 'medium',
      }),
    ]);

    // Elk antwoord tegen zijn eigen bericht: een call kan alleen cijfers kennen die hij zelf kreeg.
    const topicsFacts = groundGapTopics(topicsAnswer.data, factBase(topicsMessage));
    const termsFacts = groundGapTerms(termsAnswer.data, factBase(termsMessage));
    logRemovedClaims('content gap', [...topicsFacts.removed, ...termsFacts.removed]);
    const report = buildReport({
      keyword, target, serp, serpResults, compared, candidates, questions,
      model: { ...topicsFacts.model, ...termsFacts.model },
      mappingCandidates: mapping, placement, providerLabel,
    });
    const factCheck = factCheckSummary(intentFacts.removed, topicsFacts.removed, termsFacts.removed);
    progress.step('aanbevelingen', 'done', `${report.coverage.topicsTotal} onderwerpen en ${report.coverage.termsTotal} termen gecontroleerd tegen de bronnen`);

    const usage = [intentAnswer, topicsAnswer, termsAnswer].map((answer) => answer.usage || {});
    log('Analyse afgerond', startedAt, {
      zoekwoord: keyword,
      regio: region.id,
      ronde: origin.round,
      vergeleken: compared.length,
      mislukt: serpResults.filter((result) => result.status === 'mislukt').length,
      onderwerpen: report.coverage.topicsTotal,
      onderwerpen_zonder_bron: report.quality.droppedTopics,
      mapping_afgekeurd: report.quality.droppedMapping,
      cijfers_weggelaten: factCheck.removed,
      ideeen: (ideas.value || []).length,
      gsc: gsc.status,
      dekking: report.coverage.score,
      input_tokens: usage.reduce((sum, item) => sum + (item.input_tokens || 0), 0),
      output_tokens: usage.reduce((sum, item) => sum + (item.output_tokens || 0), 0),
    });

    const finalFlags = sourceFlags(gsc, { ahrefsUsed: ahrefsInIntent || (ideas.value || []).length > 0 });
    progress.send(200, { stage: 'compleet', ...base, ...report, ...finalFlags, factCheck, ideasError: ideas.error });
  } catch (error) {
    if (error.code === 'client_gone') {
      console.log('Analyse afgebroken: de gebruiker startte iets anders.');
      return;
    }
    if (error.code && error.status) {
      progress.send(error.status, { error: error.message, code: error.code });
      return;
    }
    console.error('Analyse mislukt:', error);
    progress.send(502, { error: describeClaudeError(error), code: 'analysis_failed' });
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
