/**
 * Google Search Console via een service account.
 *
 * Search Console is een aanvulling, geen voorwaarde: het service account heeft
 * alleen toegang tot de properties van klanten die het als gebruiker hebben
 * toegevoegd. Deze module gooit daarom nooit een fout. Elke aanroep geeft een
 * resultaat met een status terug, zodat de analyse bij "geen toegang" gewoon
 * doorloopt op de Ahrefs-data (de smart fallback).
 *
 * De data is een meting van Google: vertoningen, klikken en gemiddelde positie
 * per zoekopdracht voor precies deze pagina.
 */

import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

/** Eén budget voor token plus aanvragen: Search Console mag de analyse niet ophouden. */
const TIMEOUT_MS = 12_000;

const LOOKBACK_DAYS = 90;

/** Search Console loopt een paar dagen achter; de laatste dagen zijn nog onvolledig. */
const DATA_DELAY_DAYS = 3;

/**
 * Het API-maximum per aanvraag. Google sorteert op klikken: met een lagere
 * limiet vallen juist de zoekopdrachten met vertoningen maar zonder klik weg,
 * en dat is de long tail waar het om gaat. Eén aanvraag, geen extra quotum.
 */
const ROW_LIMIT = 25_000;

/** De lijst properties verandert zelden; opnieuw ophalen per analyse is zonde van de tijd. */
const SITES_TTL_MS = 10 * 60 * 1000;

/**
 * Vindt de gecachete lijst geen property, dan halen we hem opnieuw op: misschien
 * heeft de klant het account net toegevoegd. Niet vaker dan eens per 30 seconden.
 */
const SITES_REFRESH_AFTER_MISS_MS = 30 * 1000;

export const GSC_STATUS = {
  ok: 'ok',
  leeg: 'leeg',
  nietIngesteld: 'niet_ingesteld',
  geenToegang: 'geen_toegang',
  // Onvolledig: de ingestelde waarde is kapot (ontbreekt, afgekapt, verkeerd geplakt).
  // Ongeldig: de waarde is in orde, maar Google weigert de sleutel.
  sleutelOnvolledig: 'sleutel_onvolledig',
  sleutelOngeldig: 'sleutel_ongeldig',
  apiUit: 'api_uit',
  limiet: 'limiet',
  timeout: 'timeout',
  fout: 'fout',
};

/** Statussen waarbij een aanroep geprobeerd is en mislukte: daar hoort gsc_error bij. */
const FAILED = new Set([
  GSC_STATUS.geenToegang, GSC_STATUS.sleutelOnvolledig, GSC_STATUS.sleutelOngeldig, GSC_STATUS.apiUit,
  GSC_STATUS.limiet, GSC_STATUS.timeout, GSC_STATUS.fout,
]);

// --- Sleutel en e-mail uit de omgeving -----------------------------------------------

/**
 * De plekken waar het service account kan staan. Het hele JSON-bestand in één
 * variabele is het minst foutgevoelig: adres en sleutel horen dan zeker bij elkaar.
 * Staat die variabele er, dan tellen de andere twee niet.
 */
export const CREDENTIAL_VARS = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY'];

/**
 * Wat er mis is met de ingestelde waarden, in woorden die in Vercel na te lopen zijn.
 * Nooit de waarde zelf herhalen: staan de variabelen omgewisseld, dan zou de sleutel
 * anders in de interface en de log belanden.
 */
const PROBLEMS = {
  jsonOnleesbaar: 'GOOGLE_SERVICE_ACCOUNT_JSON is geen leesbaar sleutelbestand. Plak de volledige inhoud van het gedownloade .json-bestand, van { tot en met }.',
  oauthClient: 'GOOGLE_SERVICE_ACCOUNT_JSON is een OAuth-client, geen service account. Download in Google Cloud onder IAM → Service Accounts → Keys een sleutel als JSON.',
  emailOntbreekt: (name) => `${name} bevat geen adres van het service account ("client_email"). Neem het over uit het JSON-bestand, of zet het hele bestand in GOOGLE_SERVICE_ACCOUNT_JSON.`,
  emailIsSleutel: 'GOOGLE_CLIENT_EMAIL bevat een sleutel: GOOGLE_CLIENT_EMAIL en GOOGLE_PRIVATE_KEY zijn omgewisseld.',
  emailOngeldig: (name) => `${name} is geen adres van een service account. Dat eindigt op gserviceaccount.com; neem "client_email" over uit het JSON-bestand.`,
  sleutelOntbreekt: (name) => `${name} bevat geen sleutel. Neem "private_key" over uit het JSON-bestand, of zet het hele bestand in GOOGLE_SERVICE_ACCOUNT_JSON.`,
  geenSleutel: (name) => `${name} bevat geen private key. Die begint met -----BEGIN PRIVATE KEY----- en eindigt met -----END PRIVATE KEY-----.`,
  afgekapt: (name) => `De sleutel in ${name} is afgekapt: de regel -----END PRIVATE KEY----- ontbreekt. Plak hem opnieuw, helemaal.`,
  beschadigd: (name) => `De sleutel in ${name} is beschadigd en niet te lezen. Plak hem opnieuw uit het JSON-bestand, of zet het hele bestand in GOOGLE_SERVICE_ACCOUNT_JSON.`,
};

const isSet = (value) => value !== undefined && value !== null && String(value).trim() !== '';

/** Zonder BOM, spaties, aanhalingstekens en komma's eromheen: resten van kopiëren uit een JSON-regel. */
const unwrap = (value) => String(value ?? '').replace(/^\uFEFF/, '').replace(/^[\s"',]+|[\s"',]+$/g, '');

/**
 * Maakt van elke gangbare plakvorm weer de PEM-tekst die de JWT-bibliotheek verwacht:
 * meerregelig, met letterlijke \n (ook dubbel geëscapet), met Windows-regeleindes,
 * tussen aanhalingstekens met een komma erachter, als JSON-regel ("private_key": "…")
 * of als heel JSON-bestand, met spaties waar regeleindes hoorden, of zonder BEGIN- en
 * END-regel. De base64-tekst wordt opnieuw per 64 tekens afgebroken en daarna echt
 * ingelezen: alleen een afgekapte of beschadigde sleutel is niet te redden, en dan
 * zegt het resultaat precies dat.
 *
 * @returns {{key: string}|{problem: string}}
 */
export function parsePrivateKey(raw, name = 'GOOGLE_PRIVATE_KEY') {
  let text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return { problem: PROBLEMS.sleutelOntbreekt(name) };
  const inJson = text.match(/"private_key"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/);
  if (inJson) text = inJson[1];
  // Een backslash hoort nooit in een PEM-sleutel: elke \n of \\n is een geëscapet regeleinde.
  text = text.replace(/\\+r/g, '').replace(/\\+n/g, '\n').replace(/\r/g, '');

  const begin = text.match(/-----BEGIN ((?:RSA )?PRIVATE KEY)-----/);
  let label = 'PRIVATE KEY';
  let body;
  if (begin) {
    label = begin[1];
    const rest = text.slice(begin.index + begin[0].length);
    const end = rest.indexOf(`-----END ${label}-----`);
    if (end < 0) return { problem: PROBLEMS.afgekapt(name) };
    body = rest.slice(0, end);
  } else {
    // Alleen de base64-tekst, zonder de BEGIN- en END-regel eromheen.
    body = unwrap(text);
    if (!/^[A-Za-z0-9+/=\s]{200,}$/.test(body)) return { problem: PROBLEMS.geenSleutel(name) };
  }
  body = body.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return { problem: PROBLEMS.beschadigd(name) };

  const pem = `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  try {
    if (crypto.createPrivateKey(pem).asymmetricKeyType !== 'rsa') return { problem: PROBLEMS.beschadigd(name) };
  } catch {
    return { problem: PROBLEMS.beschadigd(name) };
  }
  return { key: pem };
}

/** De PEM-tekst, of null als er geen bruikbare sleutel in staat. */
export function normalizePrivateKey(raw) {
  return parsePrivateKey(raw).key ?? null;
}

/**
 * Het JSON-bestand van het service account, zoals het uit Google Cloud komt. Ook als
 * base64, en ook als de \n in de sleutel onderweg echte regeleindes werden (dan is
 * het geen geldige JSON meer, maar de velden zijn nog te lezen).
 */
function parseAccountJson(raw) {
  let text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (/^['"]\s*\{/.test(text)) text = text.slice(1, -1).trim();
  if (!text.startsWith('{')) {
    const decoded = Buffer.from(text, 'base64').toString('utf8').trim();
    if (decoded.startsWith('{')) text = decoded;
  }
  let fields = null;
  try {
    fields = JSON.parse(text);
  } catch {
    const field = (key) => text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)"`))?.[1] ?? null;
    if (/"(private_key|client_email)"\s*:/.test(text)) {
      fields = { client_email: field('client_email'), private_key: field('private_key'), private_key_id: field('private_key_id') };
      if (!fields.private_key && /"private_key"\s*:/.test(text)) fields.private_key = text; // afgekapt: parsePrivateKey zegt waar
    }
  }
  if (!fields || typeof fields !== 'object') return { problem: PROBLEMS.jsonOnleesbaar };
  if (fields.installed || fields.web) return { problem: PROBLEMS.oauthClient };
  return { email: fields.client_email ?? '', rawKey: fields.private_key ?? '', keyId: fields.private_key_id ?? null };
}

function checkEmail(email, name) {
  if (!email) return PROBLEMS.emailOntbreekt(name);
  if (/PRIVATE KEY/.test(email)) return PROBLEMS.emailIsSleutel;
  if (!/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/i.test(email)) return PROBLEMS.emailOngeldig(name);
  return null;
}

/**
 * Leest het service account uit de omgeving: het hele JSON-bestand in
 * GOOGLE_SERVICE_ACCOUNT_JSON, of GOOGLE_CLIENT_EMAIL plus GOOGLE_PRIVATE_KEY. Staat in
 * GOOGLE_PRIVATE_KEY toch het hele bestand, dan komt het adres uit dat bestand: dat
 * hoort zeker bij de sleutel.
 *
 * @returns {null|{invalid: true, problem: string}|{email: string, key: string, keyId: string|null, from: string}}
 */
export function readCredentials(env = {}) {
  if (!CREDENTIAL_VARS.some((name) => isSet(env[name]))) return null;
  const invalid = (problem) => ({ invalid: true, problem });

  if (isSet(env.GOOGLE_SERVICE_ACCOUNT_JSON)) {
    const name = 'GOOGLE_SERVICE_ACCOUNT_JSON';
    const account = parseAccountJson(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (account.problem) return invalid(account.problem);
    // Eerst de sleutel: in een afgekapt bestand ontbreekt ook het adres dat erna komt,
    // maar de oorzaak is het afkappen.
    const parsed = parsePrivateKey(account.rawKey, name);
    if (parsed.problem) return invalid(parsed.problem);
    const email = unwrap(account.email);
    const emailProblem = checkEmail(email, name);
    if (emailProblem) return invalid(emailProblem);
    return { email, key: parsed.key, keyId: account.keyId, from: name };
  }

  // Omgewisseld eerst: anders zou de melding over een ontbrekende sleutel gaan.
  if (/PRIVATE KEY/.test(String(env.GOOGLE_CLIENT_EMAIL ?? ''))) return invalid(PROBLEMS.emailIsSleutel);
  const rawKey = String(env.GOOGLE_PRIVATE_KEY ?? '');
  const parsed = parsePrivateKey(rawKey, 'GOOGLE_PRIVATE_KEY');
  if (parsed.problem) return invalid(parsed.problem);
  const embedded = /"client_email"\s*:/.test(rawKey) ? parseAccountJson(rawKey) : null;
  const email = unwrap(embedded?.email || String(env.GOOGLE_CLIENT_EMAIL ?? '').replace(/^\s*"?client_email"?\s*:/i, ''));
  const emailProblem = checkEmail(email, embedded?.email ? 'GOOGLE_PRIVATE_KEY' : 'GOOGLE_CLIENT_EMAIL');
  if (emailProblem) return invalid(emailProblem);
  return { email, key: parsed.key, keyId: embedded?.keyId ?? null, from: 'GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY' };
}

/** Alleen de vorm van een waarde, voor de serverlog. Nooit de inhoud. */
export function describeValue(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return 'leeg';
  const has = (pattern) => (pattern.test(text) ? 'ja' : 'nee');
  return `${text.length} tekens, ${text.split('\n').length} regels, ${(text.match(/\\n/g) || []).length}× \\n, `
    + `BEGIN ${has(/-----BEGIN/)}, END ${has(/-----END/)}, JSON ${has(/^\s*['"]?\{/)}`;
}

// --- Welke property hoort bij deze URL? -------------------------------------------------

/**
 * Kiest de property waaronder de pagina valt. Een URL-prefix-property
 * (https://www.klant.nl/) gaat voor een domeinproperty (sc-domain:klant.nl),
 * omdat die specifieker is; bij meerdere kandidaten wint de langste. Properties
 * waarvoor het account geen geverifieerde rechten heeft, geven geen data.
 */
export function matchProperty(sites, pageUrl) {
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const page = url.href.toLowerCase();
  const usable = (sites || []).filter((site) => site?.siteUrl && site.permissionLevel !== 'siteUnverifiedUser');

  const prefix = usable
    .filter((site) => !site.siteUrl.startsWith('sc-domain:'))
    .filter((site) => page.startsWith(site.siteUrl.toLowerCase()))
    .sort((a, b) => b.siteUrl.length - a.siteUrl.length)[0];
  if (prefix) return prefix.siteUrl;

  const domain = usable
    .filter((site) => site.siteUrl.startsWith('sc-domain:'))
    .map((site) => ({ site, name: site.siteUrl.slice('sc-domain:'.length).toLowerCase() }))
    .filter(({ name }) => host === name || host.endsWith(`.${name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return domain ? domain.site.siteUrl : null;
}

/**
 * Search Console bewaart een pagina precies zoals Google hem indexeert: met of
 * zonder slash aan het eind, en zonder trackingparameters. In een test gaf de
 * ene slashvariant 375 zoekopdrachten en de andere nul, en een URL met
 * ?utm_source= ook nul. We proberen eerst de exacte vorm (soms hoort een
 * parameter echt bij de pagina, zoals ?id=), daarna de vormen zonder query.
 */
export function pageVariants(pageUrl) {
  try {
    const url = new URL(pageUrl);
    url.hash = '';
    // De homepage heeft maar één padvorm.
    const toggle = (u) => (u.pathname === '/'
      ? null
      : `${u.origin}${u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : `${u.pathname}/`}${u.search}`);
    const bare = new URL(url.href);
    bare.search = '';
    return [...new Set([url.href, toggle(url), bare.href, toggle(bare)].filter(Boolean))];
  } catch {
    return [String(pageUrl)];
  }
}


// --- Fouten vertalen -------------------------------------------------------------------

/** Waar je na een wijziging in Vercel ziet of de koppeling werkt, zonder analyse. */
const CHECK_HINT = ' Controleer de koppeling via /api/status.';

/**
 * Waarom Google een geldige sleutel weigert, uit de tekst van Google zelf. Die tekst
 * bevat nooit de sleutel; alleen de reden ("Invalid JWT Signature").
 */
function rejectionReason(error, email) {
  const google = String(error?.response?.data?.error_description || error?.message || '').replace(/\s+/g, ' ').trim();
  const account = email ? ` ${email}` : '';
  if (/Invalid JWT Signature/i.test(google)) {
    return `Google kent deze sleutel niet (meer): hij is verwijderd in Google Cloud, of hoort bij een ander service account dan${account || ' GOOGLE_CLIENT_EMAIL'}. Maak een nieuwe JSON-sleutel voor dit account en zet het hele bestand in GOOGLE_SERVICE_ACCOUNT_JSON.`;
  }
  if (/account not found|not found|does not exist|deleted/i.test(google)) {
    return `Google kent het service account${account} niet: controleer het adres, of het account verwijderd is.`;
  }
  if (/disabled/i.test(google)) {
    return `Het service account${account} is uitgeschakeld in Google Cloud.`;
  }
  if (/short-lived|timeframe|\biat\b|\bexp\b/i.test(google)) {
    return 'Google weigert de sleutel omdat de klok van de server afwijkt. Probeer het zo opnieuw.';
  }
  return `De Google-sleutel wordt geweigerd${google ? ` (Google: "${google.slice(0, 140)}")` : ''}.`;
}

/** Zet een fout van Google om in een status met een Nederlandse uitleg. */
export function classifyGscError(error, { email } = {}) {
  const status = Number(error?.status ?? error?.response?.status ?? (Number.isInteger(error?.code) ? error.code : NaN));
  const reason = String(error?.errors?.[0]?.reason ?? error?.response?.data?.error?.errors?.[0]?.reason ?? '');
  const message = String(error?.message || '');

  if (
    error?.code === 'GSC_TIMEOUT'
    || /ETIMEDOUT|ECONNABORTED|timeout/i.test(String(error?.code || ''))
    || error?.name === 'AbortError' || error?.name === 'TimeoutError'
    || /timed? ?out|aborted/i.test(message)
  ) {
    return { status: GSC_STATUS.timeout, message: 'Search Console reageerde niet op tijd.' };
  }
  if (status === 403 && (reason === 'accessNotConfigured' || /has not been used|is disabled|not enabled/i.test(message))) {
    return {
      status: GSC_STATUS.apiUit,
      message: 'De Search Console API staat uit in het Google Cloud-project. Zet hem aan onder APIs & Services → Library.',
    };
  }
  if (status === 403) {
    return {
      status: GSC_STATUS.geenToegang,
      message: `Geen Search Console-toegang voor dit domein.${email ? ` Voeg ${email} toe als gebruiker van de property.` : ''}`,
    };
  }
  // De sleutel kon niet eens gelezen worden: dat is een instelling, geen weigering van Google.
  if (/DECODER|PEM|asn1|secretOrPrivateKey|private key/i.test(message) || /^ERR_OSSL/.test(String(error?.code || ''))) {
    return { status: GSC_STATUS.sleutelOnvolledig, message: `${PROBLEMS.beschadigd('GOOGLE_PRIVATE_KEY')}${CHECK_HINT}` };
  }
  const oauth = String(error?.response?.data?.error || '');
  if (status === 401 || /invalid_grant|invalid_client|unauthorized_client/i.test(`${oauth} ${message}`)) {
    return { status: GSC_STATUS.sleutelOngeldig, message: `${rejectionReason(error, email)}${CHECK_HINT}` };
  }
  if (status === 429) {
    return { status: GSC_STATUS.limiet, message: 'Search Console geeft een limiet aan. Probeer het straks opnieuw.' };
  }
  return { status: GSC_STATUS.fout, message: `Search Console gaf een fout${status ? ` (status ${status})` : ''}.` };
}

// --- De aanroep --------------------------------------------------------------------------

function isoDate(daysAgo, now) {
  return new Date(now - daysAgo * 864e5).toISOString().slice(0, 10);
}

/** Search Console geeft CTR als fractie; de rest van de tool rekent in procenten. */
export function toRow(apiRow) {
  const round = (value, decimals) => (typeof value === 'number' ? Math.round(value * 10 ** decimals) / 10 ** decimals : null);
  return {
    query: String(apiRow?.keys?.[0] || '').trim(),
    clicks: typeof apiRow?.clicks === 'number' ? apiRow.clicks : null,
    impressions: typeof apiRow?.impressions === 'number' ? apiRow.impressions : null,
    ctr: typeof apiRow?.ctr === 'number' ? round(apiRow.ctr * 100, 1) : null,
    position: round(apiRow?.position, 1),
  };
}

const NOT_CONFIGURED = 'Search Console is niet gekoppeld: zet het JSON-bestand van het service account in GOOGLE_SERVICE_ACCOUNT_JSON, of vul GOOGLE_CLIENT_EMAIL en GOOGLE_PRIVATE_KEY.';

/** Voor de serverlog bij een kapotte instelling: welke variabele, en in welke vorm. */
function logShape(env, problem) {
  const shapes = CREDENTIAL_VARS.map((name) => `${name}: ${describeValue(env[name])}`).join(' · ');
  console.warn(`Search Console niet gebruikt: ${GSC_STATUS.sleutelOnvolledig} · ${problem} · ${shapes}`);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'GSC_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Eén client en één propertylijst per serverproces. Vercel hergebruikt warme
// instances, dus het token en de lijst gaan mee naar de volgende analyse.
let cached = { email: null, client: null, sites: null, sitesAt: 0 };

async function clientFor(credentials) {
  // Adres én sleutel: een nieuwe sleutel voor hetzelfde account krijgt een nieuwe client.
  const id = `${credentials.email}:${crypto.createHash('sha256').update(credentials.key).digest('hex')}`;
  if (cached.client && cached.email === id) return cached.client;
  // Pas laden als er credentials zijn: zonder koppeling kost het niets.
  const { searchconsole, auth } = await import('@googleapis/searchconsole');
  const jwt = new auth.JWT({ email: credentials.email, key: credentials.key, scopes: [SCOPE] });
  cached = { email: id, client: searchconsole({ version: 'v1', auth: jwt }), sites: null, sitesAt: 0 };
  return cached.client;
}

async function listSites(client, requestOptions, { maxAgeMs = SITES_TTL_MS } = {}) {
  if (cached.sites && Date.now() - cached.sitesAt < maxAgeMs) return cached.sites;
  const response = await client.sites.list({}, requestOptions);
  cached.sites = response.data.siteEntry || [];
  cached.sitesAt = Date.now();
  return cached.sites;
}

/**
 * Eén aanvraag voor deze pagina. Met een land erbij telt alleen het verkeer uit
 * dat land: dan horen de vertoningen bij dezelfde Google als de top 10.
 */
function queryPage(client, { property, page, startDate, endDate, dimensions, country }, requestOptions) {
  const filters = [{ dimension: 'page', operator: 'equals', expression: page }];
  if (country) filters.push({ dimension: 'country', operator: 'equals', expression: country });
  return client.searchanalytics.query({
    siteUrl: property,
    requestBody: { startDate, endDate, dimensions, dimensionFilterGroups: [{ filters }], rowLimit: ROW_LIMIT },
  }, requestOptions);
}

/**
 * De zoekopdrachten waarop deze ene pagina in Google vertoond werd, plus het
 * echte paginatotaal. Dat totaal is niet de som van de zoekopdrachten: Google
 * laat zeldzame zoekopdrachten weg (geanonimiseerd), en in een test was de som
 * 7.709 vertoningen tegenover 18.962 voor de pagina als geheel.
 *
 * @param {string} pageUrl  de definitieve URL van de pagina (na redirects)
 * @param {object} options.env  process.env van het endpoint; deze module leest zelf geen omgeving
 * @param {object} [options.region]  regio uit lib/region.js; filtert op land (gscCountry)
 * @returns {Promise<{
 *   status: string, attempted: boolean, error: boolean, message: string,
 *   property: string|null, page: string|null, startDate: string|null, endDate: string|null,
 *   rows: Array<{query: string, clicks: number|null, impressions: number|null, ctr: number|null, position: number|null}>,
 *   pageTotals: {clicks: number|null, impressions: number|null, ctr: number|null, position: number|null}|null,
 * }>}
 */
export async function fetchPageQueries(pageUrl, { env, region = null, timeoutMs = TIMEOUT_MS, now = Date.now() } = {}) {
  const base = { attempted: false, error: false, property: null, page: null, startDate: null, endDate: null, rows: [], pageTotals: null, country: null };
  const done = (status, message, extra = {}) => ({ ...base, ...extra, status, message, error: FAILED.has(status) });
  const settings = env || {};

  const credentials = readCredentials(settings);
  if (!credentials) {
    return done(GSC_STATUS.nietIngesteld, NOT_CONFIGURED);
  }
  if (credentials.invalid) {
    logShape(settings, credentials.problem);
    return done(GSC_STATUS.sleutelOnvolledig, `${credentials.problem}${CHECK_HINT}`, { attempted: true });
  }

  const startDate = isoDate(LOOKBACK_DAYS + DATA_DELAY_DAYS, now);
  const endDate = isoDate(DATA_DELAY_DAYS, now);

  try {
    return await withTimeout((async () => {
      const client = await clientFor(credentials);
      const requestOptions = { timeout: timeoutMs };

      let property = matchProperty(await listSites(client, requestOptions), pageUrl);
      if (!property && Date.now() - cached.sitesAt > SITES_REFRESH_AFTER_MISS_MS) {
        property = matchProperty(await listSites(client, requestOptions, { maxAgeMs: 0 }), pageUrl);
      }
      if (!property) {
        return done(GSC_STATUS.geenToegang, `Geen Search Console-toegang voor dit domein. Voeg ${credentials.email} toe als gebruiker van de property.`, { attempted: true });
      }

      const range = { property, startDate, endDate, country: region?.gscCountry || null };
      const where = region ? `, ${region.label}` : '';
      for (const page of pageVariants(pageUrl)) {
        const response = await queryPage(client, { ...range, page, dimensions: ['query'] }, requestOptions);
        const rows = (response.data.rows || []).map(toRow).filter((row) => row.query);
        if (!rows.length) continue;
        rows.sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0) || (b.clicks ?? 0) - (a.clicks ?? 0));

        // Het paginatotaal is een aanvulling: mislukt die aanvraag, dan houden we de rijen.
        let pageTotals = null;
        try {
          const totals = await queryPage(client, { ...range, page, dimensions: ['page'] }, requestOptions);
          const row = totals.data.rows?.[0];
          if (row) {
            const measured = toRow({ ...row, keys: [page] });
            pageTotals = { clicks: measured.clicks, impressions: measured.impressions, ctr: measured.ctr, position: measured.position };
          }
        } catch (error) {
          console.warn('Paginatotaal uit Search Console niet opgehaald:', error?.status ?? error?.code ?? '', String(error?.message || '').slice(0, 120));
        }

        const measuredOther = page.toLowerCase() !== String(pageUrl).toLowerCase() ? ` Gemeten voor ${page}.` : '';
        return done(GSC_STATUS.ok, `${rows.length} zoekopdrachten uit Search Console (${startDate} t/m ${endDate}${where}).${measuredOther}`, {
          attempted: true, property, page, startDate, endDate, rows, pageTotals, country: range.country,
        });
      }
      return done(GSC_STATUS.leeg, `Search Console heeft voor deze pagina geen vertoningen${region ? ` in ${region.label}` : ''} tussen ${startDate} en ${endDate}, ook niet zonder parameters of andere slash.`, {
        attempted: true, property, startDate, endDate, country: range.country,
      });
    })(), timeoutMs);
  } catch (error) {
    const classified = classifyGscError(error, { email: credentials.email });
    // De ruwe fout alleen in de serverlog; de sleutel zit er nooit in.
    console.warn('Search Console niet gebruikt:', classified.status, error?.status ?? error?.code ?? '', String(error?.message || '').slice(0, 200));
    return done(classified.status, classified.message, { attempted: true, startDate, endDate });
  }
}

// --- De koppeling controleren (/api/status) ------------------------------------------------

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/';
const CERTS_TIMEOUT_MS = 8_000;

const shortId = (id) => (id ? `${String(id).slice(0, 8)}…` : null);
const fingerprint = (publicKey) => crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

/**
 * Welke sleutel van het account dit is, en of Google hem nog actief heeft. Google
 * publiceert de publieke helft van elke actieve sleutel per service account; de
 * publieke helft van onze sleutel moet daartussen staan. Zo zie je ook welke oude
 * sleutels nog actief zijn en in Google Cloud weg kunnen.
 */
async function identifyKey(credentials) {
  const known = { id: shortId(credentials.keyId), actief: null, actieveSleutels: [] };
  try {
    const mine = fingerprint(crypto.createPublicKey(crypto.createPrivateKey(credentials.key)));
    const response = await fetch(`${CERTS_URL}${encodeURIComponent(credentials.email)}`, { signal: AbortSignal.timeout(CERTS_TIMEOUT_MS) });
    if (response.status === 404) return { ...known, actief: false, uitleg: 'Google kent dit service account niet.' };
    if (!response.ok) return { ...known, uitleg: `De sleutellijst van Google gaf status ${response.status}.` };
    const certs = Object.entries(await response.json());
    const match = certs.find(([, pem]) => fingerprint(new crypto.X509Certificate(pem).publicKey) === mine);
    return {
      id: match ? shortId(match[0]) : known.id,
      actief: Boolean(match),
      actieveSleutels: certs.map(([id]) => shortId(id)),
      uitleg: match ? 'Deze sleutel is actief bij Google.' : 'Deze sleutel staat niet tussen de actieve sleutels van het account: hij is verwijderd of hoort bij een ander account.',
    };
  } catch (error) {
    return { ...known, uitleg: error?.name === 'TimeoutError' ? 'De sleutellijst van Google reageerde niet op tijd.' : 'De sleutellijst van Google was niet te lezen.' };
  }
}

/**
 * Controleert de koppeling zonder analyse, dus zonder Ahrefs-units of Claude-tokens:
 * staan de variabelen goed, kent Google deze sleutel nog, lukt inloggen, en valt de
 * pagina onder een property van het account. Gooit nooit. Geeft nooit een sleutel
 * terug: alleen namen van variabelen, het adres van het account en sleutel-ID's.
 */
export async function checkSearchConsole(env = {}, { pageUrl = '', timeoutMs = TIMEOUT_MS } = {}) {
  const result = {
    status: null,
    message: '',
    variabelen: Object.fromEntries(CREDENTIAL_VARS.map((name) => [name, isSet(env[name]) ? 'ingesteld' : 'leeg'])),
    // Een tikfout in de naam ("GOOGLE_PRIVATE_KEY " of "GSC_KEY") is in Vercel makkelijk gemaakt.
    andereVariabelen: Object.keys(env).filter((name) => /GOOGLE|GSC|SEARCH_?CONSOLE|SERVICE_?ACCOUNT/i.test(name) && !CREDENTIAL_VARS.includes(name)),
    gebruikt: null,
    serviceAccount: null,
    sleutel: null,
    properties: null,
    pagina: null,
  };
  const finish = (status, message) => ({ ...result, status, message });

  const credentials = readCredentials(env);
  if (!credentials) return finish(GSC_STATUS.nietIngesteld, NOT_CONFIGURED);
  if (credentials.invalid) return finish(GSC_STATUS.sleutelOnvolledig, credentials.problem);
  Object.assign(result, { gebruikt: credentials.from, serviceAccount: credentials.email, sleutel: await identifyKey(credentials) });

  try {
    const sites = await withTimeout((async () => listSites(await clientFor(credentials), { timeout: timeoutMs }, { maxAgeMs: 0 }))(), timeoutMs);
    result.properties = sites.filter((site) => site?.permissionLevel !== 'siteUnverifiedUser').length;
    if (!pageUrl) return finish(GSC_STATUS.ok, `Ingelogd bij Search Console als ${credentials.email}, met toegang tot ${result.properties} ${result.properties === 1 ? 'property' : 'properties'}.`);
    const property = matchProperty(sites, pageUrl);
    result.pagina = { url: pageUrl, property };
    return property
      ? finish(GSC_STATUS.ok, `Ingelogd als ${credentials.email}. De pagina valt onder ${property}: de analyse gebruikt Search Console.`)
      : finish(GSC_STATUS.geenToegang, `Ingelogd als ${credentials.email}, maar zonder toegang tot dit domein. Voeg dit adres toe als gebruiker van de property in Search Console.`);
  } catch (error) {
    const classified = classifyGscError(error, { email: credentials.email });
    return finish(classified.status, classified.message.replace(CHECK_HINT, ''));
  }
}

/** Alleen voor tests: begin met een lege client- en propertycache. */
export function resetSearchConsoleCache() {
  cached = { email: null, client: null, sites: null, sitesAt: 0 };
}
