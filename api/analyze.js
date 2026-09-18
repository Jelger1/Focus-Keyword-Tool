/**
 * POST /api/analyze
 *
 * Content gap-analyse tegen de echte Google-top 10:
 *
 *   1. Doelpagina ophalen en meten.
 *   2. De organische top 10 voor het zoekwoord ophalen via Serper (Google NL).
 *   3. Die pagina's parallel ophalen en op dezelfde manier meten.
 *   4. De code telt welke termen bij meerdere concurrenten voorkomen.
 *   5. Claude groepeert concurrentkoppen tot onderwerpen, kiest inhoudelijke
 *      termen uit de getelde lijst en schrijft antwoordrichtingen bij echte vragen.
 *   6. De code controleert elke bron die Claude citeert (lib/compare.js).
 *
 * Sleutels leven alleen hier, nooit in de browser.
 */

import Anthropic from '@anthropic-ai/sdk';
import { fetchPage, fail } from '../lib/page.js';
import { fetchSerp, SERP_PROVIDER } from '../lib/serp.js';
import { fetchCompetitors, topicHeadings, termCandidates, collectQuestions, buildReport } from '../lib/compare.js';

// --- Instellingen ------------------------------------------------------------

const MODEL = 'claude-opus-5';

/**
 * 'medium': in de test scheelde 'low' maar acht seconden op vijftig — de
 * wachttijd zit in de lengte van de JSON, niet in de denkdiepte.
 */
const EFFORT = 'medium';
const MAX_TOKENS = 16_000;

const MAX_TARGET_SAMPLE_CHARS = 12_000;
const MAX_KEYWORD_CHARS = 120;

/** Onder dit aantal vergeleken concurrenten is er geen patroon te herkennen. */
const MIN_COMPETITORS = 2;

// Best-effort rate limit. Serverless draait meerdere instances, dus dit is geen
// harde garantie — het vangt vooral dubbelklikken en losgeslagen scripts.
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const recentRequests = new Map();

// --- Claude: groeperen, kiezen, formuleren ------------------------------------

const SYSTEM_PROMPT = `Je bent een senior SEO-strateeg. Je voert een content gap-analyse uit op échte data: de organische Google-topresultaten (Nederland) voor een zoekwoord, met per resultaat de koppen die op die pagina staan.

Je krijgt:
- de doelpagina: koppen en een groot deel van de tekst;
- de concurrenten, genummerd [1], [2], ..., met titel, snippet en hun koppen;
- een lijst kandidaat-termen die de analysetool in de concurrentpagina's telde, met het aantal concurrenten dat de term gebruikt;
- een genummerde lijst vragen uit "Mensen vragen ook" en uit concurrentkoppen.

Taken:
1. Zoekintentie: leid af uit de titels en snippets van de resultaten wat de zoeker wil.
2. Onderwerpen: groepeer concurrentkoppen die hetzelfde onderwerp behandelen, ook als ze anders geformuleerd zijn. Neem een onderwerp alleen op als het bij minstens twee verschillende concurrenten voorkomt. Geef per onderwerp:
   - een kop zoals die op de doelpagina mag komen: concreet, Nederlands, zonder het zoekwoord er kunstmatig in te proppen;
   - de bronnen: per concurrentnummer de kop LETTERLIJK zoals die in de input staat. De tool controleert elke bron en gooit onderwerpen weg zonder geldige bron bij twee concurrenten. Parafraseer dus nooit.
   - of de doelpagina het onderwerp al behandelt: "kop" (eigen tussenkop, ook anders geformuleerd), "tekst" (inhoudelijk in de lopende tekst, zonder kop) of "ontbreekt". Kijk naar betekenis, niet naar losse woorden; bij twijfel kies je de hogere dekking.
   Neem ook onderwerpen op die de doelpagina al goed behandelt: de marketeer wil zien wat er wél staat.
3. Termen: kies uit de kandidatenlijst 10 tot 25 termen die inhoudelijk bij het onderwerp horen: vaktermen, productsoorten, regelgeving, kosten- en opbrengstbegrippen, alternatieven. Sla algemene woorden, navigatie, merknamen van individuele concurrenten en varianten van hetzelfde begrip over. Neem de term letterlijk over uit de lijst.
4. Vragen: geef per vraagnummer in één zin de richting van een goed antwoord, en of de doelpagina de vraag al beantwoordt.

Regels:
- Alles in het Nederlands, je-vorm.
- Koppen als "Klantenservice", "Gerelateerde artikelen" of "Nieuwsbrief" horen bij de site, niet bij het onderwerp: negeer ze.
- Verzin geen cijfers, prijzen of keurmerken.`;

const COVERAGE = { type: 'string', enum: ['kop', 'tekst', 'ontbreekt'] };

/** Het schema dwingt de vorm af; de inhoud toetst lib/compare.js tegen de gemeten data. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    searchIntent: { type: 'string', description: 'Eén zin: wat wil de zoeker bereiken?' },
    intentType: { type: 'string', enum: ['informatief', 'commercieel', 'transactioneel', 'navigatie'] },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'De kop zoals hij op de doelpagina mag komen.' },
          level: { type: 'string', enum: ['H2', 'H3'] },
          why: { type: 'string', description: 'Eén zin: waarom dit onderwerp in de topresultaten terugkomt.' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                result: { type: 'integer', description: 'Concurrentnummer uit de input.' },
                heading: { type: 'string', description: 'De kop letterlijk zoals in de input.' },
              },
              required: ['result', 'heading'],
              additionalProperties: false,
            },
          },
          coverage: { ...COVERAGE, description: 'Behandelt de doelpagina dit al?' },
          subheadings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nul tot drie H3-suggesties, gebaseerd op wat de concurrenten eronder behandelen.',
          },
        },
        required: ['heading', 'level', 'why', 'sources', 'coverage', 'subheadings'],
        additionalProperties: false,
      },
    },
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'Letterlijk uit de kandidatenlijst.' },
          context: { type: 'string', description: 'Korte uitleg waar deze term thuishoort.' },
        },
        required: ['term', 'context'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Vraagnummer uit de input.' },
          angle: { type: 'string', description: 'In één zin: wat het antwoord moet raken.' },
          coverage: { ...COVERAGE, description: 'Beantwoordt de doelpagina deze vraag al?' },
        },
        required: ['index', 'angle', 'coverage'],
        additionalProperties: false,
      },
    },
  },
  required: ['searchIntent', 'intentType', 'topics', 'terms', 'questions'],
  additionalProperties: false,
};

function buildUserMessage({ keyword, target, compared, candidates, questions }) {
  const lines = [
    '# Zoekwoord',
    keyword,
    '',
    '# Doelpagina',
    `URL: ${target.url}`,
    target.title && `Titel: ${target.title}`,
    `Woordenaantal: ${target.wordCount}`,
    '',
    '## Koppen',
    target.headings.length
      ? target.headings.map((heading) => `${heading.level}: ${heading.text}`).join('\n')
      : '(geen koppen gevonden)',
    '',
    '## Tekst (begin)',
    target.text.slice(0, MAX_TARGET_SAMPLE_CHARS),
    '',
    '# Concurrenten uit de Google-top 10',
  ];

  compared.forEach((competitor, index) => {
    lines.push(
      '',
      `## [${index + 1}] positie ${competitor.position} · ${competitor.domain}`,
      `Titel: ${competitor.title}`,
      competitor.snippet && `Snippet: ${competitor.snippet}`,
      `Woordenaantal: ${competitor.wordCount}`,
      'Koppen:',
      ...topicHeadings(competitor.page).map((heading) => `- ${heading.level}: ${heading.text}`)
    );
  });

  lines.push(
    '',
    '# Kandidaat-termen (term — aantal concurrenten dat hem gebruikt — staat al op doelpagina?)',
    ...candidates.map((candidate) => `- ${candidate.term} — ${candidate.usedBy} — ${candidate.present ? 'ja' : 'nee'}`),
    '',
    '# Vragen',
    ...(questions.length
      ? questions.map((item, index) => `${index + 1}. ${item.question} (${item.source})`)
      : ['(geen vragen gevonden)'])
  );

  return lines.filter((line) => line !== false && line !== undefined && line !== '').join('\n');
}

async function askClaude(client, input) {
  const request = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: buildUserMessage(input) }],
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
  if (message.stop_reason === 'max_tokens') {
    throw fail(502, 'truncated', 'Het antwoord van het model werd afgekapt. Probeer het opnieuw.');
  }

  const json = message.content.find((block) => block.type === 'text')?.text;
  if (!json) throw fail(502, 'empty_response', 'Het model gaf geen bruikbaar antwoord terug.');

  try {
    return { data: JSON.parse(json), usage: message.usage };
  } catch {
    throw fail(502, 'bad_json', 'Het antwoord van het model was geen geldige JSON.');
  }
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
    // Zonder echte Google-resultaten valt er niets te vergelijken. Bewust geen
    // terugval op geschatte data: dan zou het rapport metingen suggereren die er niet zijn.
    if (!process.env.SERPER_API_KEY) {
      throw fail(500, 'no_serp_key', 'SERPER_API_KEY is niet ingesteld op de server.');
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

    // Doelpagina en SERP tegelijk: ze hangen niet van elkaar af.
    const [target, serp] = await Promise.all([
      fetchPage(url),
      fetchSerp(keyword, { apiKey: process.env.SERPER_API_KEY }),
    ]);

    const serpResults = await fetchCompetitors(serp.organic, target);
    const compared = serpResults.filter((result) => result.status === 'vergeleken');

    if (compared.length < MIN_COMPETITORS) {
      throw fail(
        502,
        'too_few_competitors',
        `Van de top 10 konden er maar ${compared.length} opgehaald worden. Te weinig om een patroon te zien.`
      );
    }

    const candidates = termCandidates(compared.map((competitor) => competitor.page), target, keyword);
    const questions = collectQuestions(serp.peopleAlsoAsk, compared);

    const client = new Anthropic(); // leest ANTHROPIC_API_KEY uit de omgeving
    const { data, usage } = await askClaude(client, { keyword, target, compared, candidates, questions });

    const report = buildReport({
      keyword, target, serp, serpResults, compared, candidates, questions, model: data, provider: SERP_PROVIDER,
    });

    // Verschijnt in Vercel onder Deployments -> Functions -> Logs.
    console.log(
      'Analyse afgerond:',
      JSON.stringify({
        seconden: Math.round((Date.now() - startedAt) / 100) / 10,
        zoekwoord: keyword,
        vergeleken: compared.length,
        mislukt: serpResults.filter((result) => result.status === 'mislukt').length,
        onderwerpen: report.coverage.topicsTotal,
        onderwerpen_zonder_bron: report.quality.droppedTopics,
        dekking: report.coverage.score,
        input_tokens: usage?.input_tokens,
        output_tokens: usage?.output_tokens,
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
