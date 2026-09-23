/**
 * De gedeelde Claude-aanroep.
 *
 * Beide endpoints (analyse en herfocus) praten via deze ene functie met het
 * model, zodat modelkeuze, foutafhandeling en de server-side terugval op één
 * plek staan. Elke aanroep vraagt JSON volgens een schema: het schema dwingt
 * de vorm af, de inhoud toetst de aanroeper zelf tegen de gemeten data.
 */

import Anthropic from '@anthropic-ai/sdk';
import { fail } from './page.js';
import { repairLatexDiaeresis } from './text.js';

export const MODEL = 'claude-opus-5';

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

  // Weigert het model een aanvraag (zeldzaam bij SEO-analyses), dan handelt
  // Anthropic dat server-side af op een ander model. Die beta staat niet op elk
  // account aan, vandaar de retry zonder.
  let response;
  try {
    response = await client.beta.messages.create({
      ...request,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (error) {
    const rejectedBeta = error?.status === 400 && /beta|fallback/i.test(error?.message || '');
    if (!rejectedBeta) throw error;
    console.warn('Server-side fallback niet beschikbaar, opnieuw zonder.');
    response = await client.messages.create(request);
  }

  if (response.stop_reason === 'refusal') {
    throw fail(502, 'refused', 'Het model heeft deze analyse geweigerd. Controleer het zoekwoord.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw fail(502, 'truncated', 'Het antwoord van het model werd afgekapt. Probeer het opnieuw.');
  }

  const json = response.content.find((block) => block.type === 'text')?.text;
  if (!json) throw fail(502, 'empty_response', 'Het model gaf geen bruikbaar antwoord terug.');

  try {
    return { data: JSON.parse(repairLatexDiaeresis(json)), usage: response.usage };
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
