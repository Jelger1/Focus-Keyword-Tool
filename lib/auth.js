/**
 * Het optionele wachtwoord van de tool.
 *
 * Staat APP_PASSWORD niet ingesteld, dan is de tool open. Staat hij wel
 * ingesteld, dan moet elke aanvraag hem meesturen in de header X-App-Password.
 * Sinds Search Console erbij zit, beschermt dit ook de zoekdata van klanten.
 */

import crypto from 'node:crypto';

/**
 * Vergelijkt in constante tijd, zodat de responstijd niet verraadt hoeveel tekens
 * er klopten. Eerst hashen: timingSafeEqual wil twee buffers van gelijke lengte.
 */
export function passwordOk(req, env) {
  const required = env.APP_PASSWORD;
  if (!required) return true;
  const given = req.headers?.['x-app-password'];
  if (typeof given !== 'string' || !given) return false;
  const hash = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(hash(given), hash(required));
}
