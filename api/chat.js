/**
 * POST /api/chat
 *
 * De chat over een rapport: de marketeer vraagt waarom de tool iets adviseert, geeft
 * kritiek of laat teksten herschrijven. De browser stuurt het rapport, de herfocus die
 * erbij hoort, de eerdere beurten en de nieuwe vraag mee; de server bewaart niets.
 *
 * Ook hier meet de code, interpreteert Claude en controleert de code: Claude krijgt
 * alleen het rapport en het gesprek (lib/chat.js), zinnen met een cijfer dat daar niet
 * in staat verdwijnen (lib/facts.js), en elke voorgestelde tekst meet de code zelf na.
 * Het antwoord is gewoon JSON: { antwoord, teksten, factCheck }.
 *
 * Sleutels leven alleen hier, nooit in de browser.
 */

import { fail } from '../lib/page.js';
import { createClient, converseWithClaude, describeChatError } from '../lib/claude.js';
import {
  CHAT_SYSTEM_PROMPT, CHAT_SCHEMA, readChatRequest, buildChatContext, buildChatMessages, chatFactBase, chatAnswer,
} from '../lib/chat.js';
import { factCheckSummary, logRemovedClaims } from '../lib/facts.js';
import { clientKey, withinRateLimit } from '../lib/ratelimit.js';
import { passwordOk } from '../lib/auth.js';

/** Een mens stelt hooguit een paar vragen per minuut; elke vraag kost Claude-tokens. */
const RATE_LIMIT_MAX = 30;

/**
 * Een vraag stopt vóór de functie dat zelf doet (300 s in vercel.json), zodat de
 * marketeer een Nederlandse melding krijgt in plaats van een kale time-out van Vercel.
 */
const DEADLINE_MS = 280_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Alleen POST wordt ondersteund.', code: 'method_not_allowed' });
    return;
  }

  // Sluit de marketeer de chat of begint die opnieuw, dan stopt ook de aanroep naar
  // Claude: een antwoord dat niemand leest, hoeft niemand te betalen. Op Vercel komt
  // dat signaal alleen binnen omdat vercel.json supportsCancellation aanzet voor dit pad.
  const gone = new AbortController();
  res.on?.('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  const deadline = AbortSignal.timeout(DEADLINE_MS);

  const startedAt = Date.now();
  try {
    // Wachtwoord is optioneel: staat APP_PASSWORD niet ingesteld, dan is de tool open.
    if (!passwordOk(req, process.env)) {
      throw fail(401, 'auth_required', 'Onjuist wachtwoord.');
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw fail(500, 'no_api_key', 'ANTHROPIC_API_KEY is niet ingesteld op de server.');
    }
    if (!withinRateLimit(`chat:${clientKey(req)}`, RATE_LIMIT_MAX)) {
      throw fail(429, 'rate_limited', 'Te veel vragen achter elkaar. Probeer het over een paar minuten opnieuw.');
    }

    const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
    const { report, refocus, history, message } = readChatRequest(body);
    const context = buildChatContext(report, refocus);
    const messages = buildChatMessages({ context, history, message });

    const { data, usage } = await converseWithClaude(createClient(), {
      system: CHAT_SYSTEM_PROMPT,
      messages,
      schema: CHAT_SCHEMA,
      signal: AbortSignal.any([gone.signal, deadline]),
    });

    const answer = chatAnswer(data, { base: chatFactBase({ context, history, message }), keyword: report.keyword });
    logRemovedClaims('chat', answer.removed);
    log('Chatvraag beantwoord', startedAt, {
      vraag: history.length / 2 + 1,
      zoekwoord: report.keyword,
      herfocus: Boolean(refocus),
      teksten: answer.teksten.length,
      teksten_overgeslagen: answer.skipped,
      cijfers_weggelaten: answer.removed.length,
      input_tokens: usage?.input_tokens ?? null,
      cache_gelezen: usage?.cache_read_input_tokens ?? null,
      cache_geschreven: usage?.cache_creation_input_tokens ?? null,
      output_tokens: usage?.output_tokens ?? null,
    });

    res.status(200).json({
      antwoord: answer.antwoord,
      teksten: answer.teksten,
      // zinnen en teksten apart: een weggelaten voorstel is iets anders dan een weggelaten zin.
      factCheck: { ...factCheckSummary(answer.removed), zinnen: answer.removed.length - answer.dropped, teksten: answer.dropped },
      overgeslagen: answer.skipped,
    });
  } catch (error) {
    if (gone.signal.aborted) {
      console.log('Chatvraag afgebroken: de marketeer is weg.');
      return;
    }
    if (deadline.aborted) {
      console.warn('Chatvraag te traag:', Math.round((Date.now() - startedAt) / 1000), 's');
      res.status(504).json({ error: 'Claude gaf niet op tijd antwoord. Probeer het opnieuw, of stel een kortere vraag.', code: 'timeout' });
      return;
    }
    if (error.code && error.status) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    console.error('Chatvraag mislukt:', error);
    const described = describeChatError(error);
    res.status(described.status).json({ error: described.message, code: described.code });
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
