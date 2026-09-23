/**
 * Echte voortgang tijdens een analyse.
 *
 * Een analyse duurt tot twee minuten. In plaats van een nepbalkje meldt de
 * server elke fase die hij begint of afrondt, als één regel JSON per bericht
 * (NDJSON). Alleen als de browser daarom vraagt (Accept: application/x-ndjson);
 * anders blijft het antwoord één gewoon JSON-object, zoals tests en scripts
 * verwachten.
 *
 * Regels in de stroom:
 *   {"type":"progress","step":"serp","state":"active"|"done","message":"...","data":{...}}
 *   {"type":"heartbeat"}                       elke 10 s, zodat niets de verbinding dichtgooit
 *   {"type":"result","data":{...}}             het rapport, altijd de laatste regel
 *   {"type":"error","status":502,"error":"...","code":"..."}
 */

const HEARTBEAT_MS = 10_000;

/** Een fout die betekent: de gebruiker is weg, stop met werk dat geld kost. */
export class ClientGoneError extends Error {
  constructor() {
    super('De aanvraag is afgebroken door de gebruiker.');
    this.code = 'client_gone';
  }
}

export function createProgress(req, res) {
  const streaming = /application\/x-ndjson/i.test(String(req.headers?.accept || ''));
  let started = false;
  let heartbeat = null;
  let gone = false;

  // 'close' op de response: de verbinding is dicht voordat wij klaar waren.
  res.on?.('close', () => {
    if (!res.writableFinished) gone = true;
    clearInterval(heartbeat);
  });

  const write = (message) => {
    if (gone || res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify(message)}\n`);
  };

  const start = () => {
    if (started) return;
    started = true;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    // Geen buffering onderweg: anders komen alle regels pas aan het eind binnen.
    res.setHeader('X-Accel-Buffering', 'no');
    heartbeat = setInterval(() => write({ type: 'heartbeat' }), HEARTBEAT_MS);
  };

  return {
    streaming,

    /** Meld een fase. Zonder stroom doet dit niets. */
    step(step, state, message, data) {
      if (!streaming) return;
      start();
      write({ type: 'progress', step, state, message, ...(data ? { data } : {}) });
    },

    /** Gooit als de gebruiker is afgehaakt: aanroepen vóór elke dure stap. */
    throwIfGone() {
      if (gone) throw new ClientGoneError();
    },

    get gone() {
      return gone;
    },

    /**
     * Het eindantwoord. Is de stroom al begonnen, dan als laatste regel (de
     * HTTP-status is dan al 200); anders als gewoon JSON-antwoord met de status.
     */
    send(status, body) {
      clearInterval(heartbeat);
      if (gone) return;
      if (!started) {
        res.status(status).json(body);
        return;
      }
      write(status >= 400 ? { type: 'error', status, ...body } : { type: 'result', data: body });
      res.end();
    },
  };
}
