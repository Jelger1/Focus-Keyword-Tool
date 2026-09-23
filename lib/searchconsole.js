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
  sleutelOngeldig: 'sleutel_ongeldig',
  apiUit: 'api_uit',
  limiet: 'limiet',
  timeout: 'timeout',
  fout: 'fout',
};

/** Statussen waarbij een aanroep geprobeerd is en mislukte: daar hoort gsc_error bij. */
const FAILED = new Set([
  GSC_STATUS.geenToegang, GSC_STATUS.sleutelOngeldig, GSC_STATUS.apiUit,
  GSC_STATUS.limiet, GSC_STATUS.timeout, GSC_STATUS.fout,
]);

// --- Sleutel en e-mail uit de omgeving -----------------------------------------------

/**
 * Een private key komt in allerlei vormen binnen: met echte regeleindes (Vercel,
 * meerregelig geplakt), met letterlijke \n (één regel in .env.local), met
 * Windows-regeleindes, en soms nog tussen aanhalingstekens. Alles wordt hier de
 * PEM-tekst die de JWT-bibliotheek verwacht.
 */
export function normalizePrivateKey(raw) {
  if (!raw) return null;
  let key = String(raw).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\r\\n|\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) || !/-----END [A-Z ]*PRIVATE KEY-----$/.test(key)) return null;
  return `${key}\n`;
}

/** @returns {{email: string, key: string}|null|{invalid: true}} */
export function readCredentials(env) {
  const email = String(env.GOOGLE_CLIENT_EMAIL || '').trim().replace(/^["']|["']$/g, '');
  const rawKey = env.GOOGLE_PRIVATE_KEY;
  if (!email && !rawKey) return null;
  const key = normalizePrivateKey(rawKey);
  if (!email || !key) return { invalid: true };
  return { email, key };
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
  if (status === 401 || /invalid_grant|invalid_client|unauthorized_client|DECODER|PEM|asn1|private key/i.test(message)) {
    return { status: GSC_STATUS.sleutelOngeldig, message: 'De Google-sleutel wordt geweigerd. Controleer GOOGLE_CLIENT_EMAIL en GOOGLE_PRIVATE_KEY.' };
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
  if (cached.client && cached.email === credentials.email) return cached.client;
  // Pas laden als er credentials zijn: zonder koppeling kost het niets.
  const { searchconsole, auth } = await import('@googleapis/searchconsole');
  const jwt = new auth.JWT({ email: credentials.email, key: credentials.key, scopes: [SCOPE] });
  cached = { email: credentials.email, client: searchconsole({ version: 'v1', auth: jwt }), sites: null, sitesAt: 0 };
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
    return done(GSC_STATUS.nietIngesteld, 'Search Console is niet gekoppeld: GOOGLE_CLIENT_EMAIL en GOOGLE_PRIVATE_KEY ontbreken.');
  }
  if (credentials.invalid) {
    return done(GSC_STATUS.sleutelOngeldig, 'GOOGLE_CLIENT_EMAIL of GOOGLE_PRIVATE_KEY is onvolledig. De sleutel moet beginnen met -----BEGIN PRIVATE KEY-----.', { attempted: true });
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

/** Alleen voor tests: begin met een lege client- en propertycache. */
export function resetSearchConsoleCache() {
  cached = { email: null, client: null, sites: null, sitesAt: 0 };
}
