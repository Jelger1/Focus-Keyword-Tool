/**
 * GET /api/status
 * GET /api/status?url=https://www.klant.nl/pagina/
 *
 * Controleert de instellingen zonder analyse, dus zonder Ahrefs-units of
 * Claude-tokens: welke sleutels er staan, en of Search Console werkt (welke
 * variabele gebruikt wordt, welk service account, welke sleutel en of Google die nog
 * kent, en met ?url= of de pagina onder een property valt). Open het na elke
 * wijziging in Vercel: je ziet meteen of de koppeling werkt.
 *
 * Geeft nooit een sleutel terug, alleen of hij er staat.
 */

import { checkSearchConsole } from '../lib/searchconsole.js';
import { URL_PATTERN } from '../lib/page.js';
import { passwordOk } from '../lib/auth.js';
import { clientKey, withinRateLimit } from '../lib/ratelimit.js';

/** Elke controle logt in bij Google: genoeg voor een paar pogingen, niet voor een script. */
const RATE_LIMIT_MAX = 30;

/** Dezelfde schrijfwijzen en dezelfde controle als het formulier: met of zonder https://. */
function readPageUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (!URL_PATTERN.test(value)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Alleen GET wordt ondersteund.', code: 'method_not_allowed' });
    return;
  }
  // Wachtwoord is optioneel: staat APP_PASSWORD niet ingesteld, dan is de tool open.
  if (!passwordOk(req, process.env)) {
    res.status(401).json({ error: 'Onjuist wachtwoord. Stuur het mee in de header X-App-Password.', code: 'auth_required' });
    return;
  }
  if (!withinRateLimit(`status:${clientKey(req)}`, RATE_LIMIT_MAX)) {
    res.status(429).json({ error: 'Te veel controles achter elkaar. Probeer het over een paar minuten opnieuw.', code: 'rate_limited' });
    return;
  }

  const query = new URL(req.url || '/', 'http://localhost').searchParams;
  const pageUrl = readPageUrl(query.get('url'));
  if (pageUrl === null) {
    res.status(400).json({ error: 'Dat lijkt geen geldige URL. Gebruik bijvoorbeeld ?url=www.klant.nl/dienst.', code: 'invalid_url' });
    return;
  }

  const set = (name) => (String(process.env[name] ?? '').trim() ? 'ingesteld' : 'ontbreekt');
  res.status(200).json({
    // production of preview: variabelen in Vercel gelden per omgeving.
    omgeving: process.env.VERCEL_ENV || 'lokaal',
    anthropic: set('ANTHROPIC_API_KEY'),
    ahrefs: set('AHREFS_API_KEY'),
    wachtwoord: process.env.APP_PASSWORD ? 'ingesteld' : 'geen',
    searchConsole: await checkSearchConsole(process.env, { pageUrl }),
  });
}
