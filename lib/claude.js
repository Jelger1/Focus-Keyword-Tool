/**
 * De gedeelde Claude-aanroep.
 *
 * De endpoints (analyse, herfocus en chat) praten via deze functies met het
 * model, zodat modelkeuze, foutafhandeling en de server-side terugval op één
 * plek staan. Elke aanroep vraagt JSON volgens een schema: het schema dwingt
 * de vorm af, de inhoud toetst de aanroeper zelf tegen de gemeten data.
 */

import Anthropic from '@anthropic-ai/sdk';
import { fail } from './page.js';
import { repairLatexDiaeresis } from './text.js';

export const MODEL = 'claude-opus-5';

/**
 * De chat over een rapport draait op Claude Opus 5.5: goedkoper per token, en volgens
 * Anthropic veel minder geneigd een cijfer te noemen dat niet in de input staat. De
 * rapportcalls blijven op MODEL; daarop zijn de prompts en controles afgesteld.
 */
export const CHAT_MODEL = 'claude-opus-5-5';

/**
 * Een antwoord duurt meestal 15 tot 30 seconden, maar een grote herschrijfvraag kan
 * langer: één poging krijgt daarom bijna de hele functietijd (300 s in vercel.json).
 * Snelle storingen (429, 5xx) probeert de SDK opnieuw; de harde grens daarboven is
 * de deadline die api/chat.js meegeeft.
 */
const CHAT_TIMEOUT_MS = 240_000;
const CHAT_RETRIES = 2;

/**
 * Het model schreef in een test trema's als LaTeX (\"e voor ë), wat in de UI als
 * commerci"ele verscheen. Deze regel voorkomt dat meestal; repairLatexDiaeresis()
 * vangt de rest op.
 */
const WRITING_RULE = 'Schrijf ë, ï, é en andere Nederlandse tekens gewoon als letters, nooit in LaTeX-notatie zoals \\"e.';

/** Leest ANTHROPIC_API_KEY uit de omgeving; de sleutel komt nooit in de browser. */
export function createClient() {
  return new Anthropic();
}

/**
 * @param {object} options
 * @param {string} options.system    vaste instructie, wordt gecachet
 * @param {string} options.message   de data voor deze ene aanroep
 * @param {object} options.schema    JSON-schema van het antwoord
 * @param {number} [options.maxTokens]
 * @param {'low'|'medium'|'high'} [options.effort]  'medium': in de test scheelde
 *        'low' maar acht seconden op vijftig; de wachttijd zit in de lengte van de JSON.
 */
export async function askClaude(client, { system, message, schema, maxTokens = 8_000, effort = 'medium' }) {
  const request = {
    model: MODEL,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: `${system}

${WRITING_RULE}`, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: message }],
  };

  const response = await createWithFallback(client, request);
  return { data: readJson(response, 'Het model heeft deze analyse geweigerd. Controleer het zoekwoord.'), usage: response.usage };
}

/**
 * Een gesprek: dezelfde soort aanroep als askClaude, maar met de hele geschiedenis.
 *
 * Eerdere antwoorden gaan als tekst mee, zonder thinking-blokken. Die blokken horen
 * bij het gesprek waarin ze ontstonden, en de server bewaart geen gesprekken; zonder
 * blokken kan een beurt nooit vastlopen op een gewijzigde geschiedenis. De
 * geschiedenis groeit alleen aan het eind, dus Anthropic leest hem uit de cache: de
 * vaste instructie (gedeeld door elke chat), het rapport in het eerste bericht (een
 * eigen cachepunt, zie lib/chat.js) en automatisch de groeiende staart.
 *
 * @param {object} options
 * @param {string} options.system     vaste instructie, wordt gecachet
 * @param {Array}  options.messages   het gesprek in de vorm van de Messages API
 * @param {object} options.schema     JSON-schema van het antwoord
 * @param {number} [options.maxTokens]  denken plus antwoord; een antwoord is in de praktijk
 *        zo'n 1.500 tokens, dit laat ruimte en houdt de duur binnen de functietijd
 * @param {AbortSignal} [options.signal]  breekt de aanroep af: de browser is weg, of de deadline is bereikt
 */
export async function converseWithClaude(client, { system, messages, schema, maxTokens = 12_000, effort = 'medium', signal }) {
  const request = {
    model: CHAT_MODEL,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: `${system}

${WRITING_RULE}`, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    cache_control: { type: 'ephemeral' },
    messages,
  };
  const response = await createWithFallback(client, request, { timeout: CHAT_TIMEOUT_MS, maxRetries: CHAT_RETRIES, signal });
  return { data: readJson(response, 'Het model weigerde deze vraag. Formuleer hem anders.'), usage: response.usage };
}

/**
 * Weigert het model een aanvraag (zeldzaam bij SEO-analyses), dan handelt Anthropic
 * dat server-side af op een ander model. Die beta staat niet op elk account aan,
 * vandaar de retry zonder.
 */
async function createWithFallback(client, request, options) {
  try {
    return await client.beta.messages.create({
      ...request,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    }, options);
  } catch (error) {
    const rejectedBeta = error?.status === 400 && /beta|fallback/i.test(error?.message || '');
    if (!rejectedBeta) throw error;
    console.warn('Server-side fallback niet beschikbaar, opnieuw zonder.');
    return client.messages.create(request, options);
  }
}

function readJson(response, refusedMessage) {
  if (response.stop_reason === 'refusal') {
    throw fail(502, 'refused', refusedMessage);
  }
  if (response.stop_reason === 'max_tokens') {
    throw fail(502, 'truncated', 'Het antwoord van het model werd afgekapt. Probeer het opnieuw.');
  }

  const json = response.content.find((block) => block.type === 'text')?.text;
  if (!json) throw fail(502, 'empty_response', 'Het model gaf geen bruikbaar antwoord terug.');

  try {
    return JSON.parse(repairLatexDiaeresis(json));
  } catch {
    throw fail(502, 'bad_json', 'Het antwoord van het model was geen geldige JSON.');
  }
}

/** Vertaalt een fout van de Anthropic-client naar een melding voor de marketeer. */
export function describeClaudeError(error) {
  if (error?.status === 401) return 'De API-key wordt geweigerd. Controleer ANTHROPIC_API_KEY.';
  if (error?.status === 429) return 'Anthropic heeft een rate limit bereikt. Probeer het zo opnieuw.';
  return error?.message || 'Onbekende fout.';
}

/**
 * Voor de chat: status, code en een Nederlandse melding. Een time-out of een
 * onbereikbare API krijgt een eigen tekst, in plaats van de Engelse van de SDK.
 */
export function describeChatError(error) {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { status: 504, code: 'timeout', message: 'Claude gaf niet op tijd antwoord. Probeer het opnieuw, of stel een kortere vraag.' };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { status: 502, code: 'claude_unreachable', message: 'Claude is nu niet bereikbaar. Probeer het zo opnieuw.' };
  }
  if (error?.status === 529 || error?.status >= 500) {
    return { status: 502, code: 'claude_failed', message: 'Claude is tijdelijk overbelast. Probeer het zo opnieuw.' };
  }
  return { status: 502, code: 'chat_failed', message: describeClaudeError(error) };
}
