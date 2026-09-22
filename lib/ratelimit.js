/**
 * Best-effort rate limit per afzender. Serverless draait meerdere instances,
 * dus dit is geen harde garantie: het vangt vooral dubbelklikken en
 * losgeslagen scripts, zodat één sessie niet in een minuut het Ahrefs- en
 * Claude-tegoed opmaakt.
 */

const WINDOW_MS = 10 * 60 * 1000;
const recentRequests = new Map();

export function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'onbekend';
}

export function withinRateLimit(key, maximum) {
  const now = Date.now();
  const timestamps = (recentRequests.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= maximum) {
    recentRequests.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  recentRequests.set(key, timestamps);
  return true;
}
