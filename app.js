/**
 * Keyword Focus & Intent Check — frontend
 *
 * Praat met /api/analyze en /api/refocus en zet de JSON om in kaarten. Alle tekst
 * uit het rapport komt via textContent in de DOM, nooit via innerHTML: de inhoud
 * is deels door een model geschreven en deels van een vreemde website afkomstig.
 *
 * De flow:
 *   1. formulier -> /api/analyze -> intent check (stage 'intent' of 'compleet');
 *   2. geen match -> Search Console-export of Ahrefs-schatting -> /api/refocus;
 *   3. met het gekozen zoekwoord automatisch opnieuw /api/analyze (max. twee rondes).
 */

const form = document.getElementById('analyze-form');
const urlField = document.getElementById('target-url');
const keywordField = document.getElementById('keyword');
const urlHint = document.getElementById('url-hint');
const submitBtn = document.getElementById('submit-btn');
const submitLabel = document.getElementById('submit-label');
const submitSpinner = document.getElementById('submit-spinner');
const submitArrow = document.getElementById('submit-arrow');
const resetBtn = document.getElementById('reset-btn');
const resultCard = document.getElementById('result-card');
const resultScroll = document.getElementById('result-scroll');
const output = document.getElementById('result-output');
const actions = document.getElementById('result-actions');
const statusBadge = document.getElementById('status-badge');
const progressBar = document.getElementById('progress-bar');
const stepItems = [...document.querySelectorAll('#steps .step')];
const sourceBadgeSlot = document.getElementById('source-badge');
const regionRadios = [...document.querySelectorAll('input[name="region"]')];
const recheckForm = document.getElementById('recheck-form');
const recheckKeyword = document.getElementById('recheck-keyword');
const recheckRegion = document.getElementById('recheck-region');
const recheckHint = document.getElementById('recheck-hint');
const recheckError = document.getElementById('recheck-error');

const passwordOverlay = document.getElementById('password-overlay');
const passwordForm = document.getElementById('password-form');
const passwordInput = document.getElementById('password-input');
const passwordError = document.getElementById('password-error');

const FIELDS = [urlField, keywordField];
const URL_HINT = urlHint.textContent;
const EMPTY_STATE = output.innerHTML; // de lege staat staat in index.html en komt hier terug

const STORAGE = {
  password: 'focus-password',
  draft: 'focus-draft',
  report: 'focus-report',
  refocus: 'focus-refocus',
  gsc: 'focus-gsc',
  region: 'focus-region',
};

/** Zelfde herkenning als in lib/page.js, zodat de hint klopt met wat de server doet. */
const URL_PATTERN = /^(https?:\/\/\S+|([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?)$/i;

const MAX_GSC_BYTES = 1_000_000;

/** Grotere exports bewaren we niet in de browser: localStorage heeft maar een paar MB. */
const MAX_STORED_GSC_CHARS = 400_000;

const SOURCE_LABELS = {
  handmatig: 'opgegeven door jou',
  gsc: 'gekozen uit Search Console',
  ahrefs: 'gekozen uit Ahrefs (schatting)',
  ai: 'AI-voorstel, zoekvolume geverifieerd bij Ahrefs',
};

const FEATURE_LABELS = {
  question: 'vragen (Mensen vragen ook)', local_pack: 'local pack', local_teaser: 'local teaser', sitelinks: 'sitelinks',
  snippet: 'featured snippet', image: 'afbeeldingen', video: 'video', news: 'nieuws', shopping: 'shopping',
  knowledge_panel: 'kennispaneel', knowledge_card: 'kenniskaart', article: 'artikelen', ai_overview: 'AI overview',
  discussion: 'discussies',
};

const PLACEMENT_LABELS = { h1: 'H1', title: 'Meta title', metaDescription: 'Meta description', intro: 'Eerste alinea' };
const PLACEMENT_STATUS = {
  letterlijk: { pill: 'pill-good', text: 'staat erin' },
  los: { pill: 'pill-mid', text: 'woorden los, niet als geheel' },
  ontbreekt: { pill: 'pill-bad', text: 'ontbreekt' },
};

/**
 * Dezelfde regio's als lib/region.js op de server. De server is de bron: hij
 * valt voor een onbekende waarde terug op Nederland. Hier staan alleen de labels.
 */
const REGION_INFO = {
  nl: { id: 'nl', label: 'Nederland', short: 'NL', language: 'Nederlands' },
  us: { id: 'us', label: 'Verenigde Staten', short: 'US', language: 'Engels' },
};

/** De regio van een rapport of herfocus; oude rapporten zonder regio waren Nederlands. */
function regionOf(item) {
  return REGION_INFO[item?.region] || REGION_INFO.nl;
}

let lastReport = null;
let lastRefocus = null;
let appPassword = storageGet(STORAGE.password) || '';
let isLoading = false;
let timer = null;

/** De laatst ingeladen Search Console-export: een tweede ronde gaat over dezelfde pagina. */
let lastGscText = storageGet(STORAGE.gsc) || '';

/** Wat er opnieuw moet gebeuren nadat de marketeer het wachtwoord heeft ingevuld. */
let retryAfterPassword = null;

/**
 * De aanvraag die nu loopt. Start de marketeer iets nieuws terwijl er nog een
 * aanvraag loopt, dan breken we de oude af: de server stopt dan ook vóór de
 * dure Claude-aanroepen. Elke run weet zo of hij nog de actuele is.
 */
let activeRun = null;

function beginRun() {
  activeRun?.controller.abort();
  activeRun = { controller: new AbortController() };
  return activeRun;
}

function isCurrent(run) {
  return activeRun === run;
}

function endRun(run) {
  if (activeRun === run) activeRun = null;
}

// --- Kleine DOM-helpers --------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function card(title, subtitle) {
  const wrapper = el('section', 'card');
  const head = el('div', 'card-head');
  const left = el('div', 'min-w-0');
  left.append(el('h3', 'card-title', title));
  if (subtitle) left.append(el('p', 'text-xs text-pm-muted mt-0.5', subtitle));
  head.append(left);
  wrapper.append(head);
  return { wrapper, head };
}

const CLIPBOARD_ICON =
  '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12"/><path d="M5 15H3V3h12v2"/></svg>';

/**
 * Kopieerknop met directe terugkoppeling: het icoon maakt plaats voor "gekopieerd"
 * en er verschijnt kort een tooltip boven de knop.
 */
function copyButton(getText, label = 'kopieer', className = 'btn btn-quiet btn-xs relative') {
  const button = el('button', className);
  button.type = 'button';
  button.innerHTML = CLIPBOARD_ICON;
  const text = el('span', null, label);
  button.append(text);

  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      showTooltip(button, 'Gekopieerd naar klembord');
      button.classList.add('is-done');
      text.textContent = 'gekopieerd';
      setTimeout(() => {
        button.classList.remove('is-done');
        text.textContent = label;
      }, 1800);
    } catch {
      showTooltip(button, 'Kopiëren geblokkeerd door de browser');
    }
  });

  return button;
}

function showTooltip(anchor, message) {
  anchor.querySelector('.tooltip')?.remove();
  const tip = el('span', 'tooltip', message);
  tip.setAttribute('role', 'status');
  anchor.append(tip);
  setTimeout(() => tip.remove(), 1800);
}

function emptyNote(message) {
  return el('p', 'notice text-pm-muted', message);
}

/** Inklapbaar blok voor wat niet het hoofdverhaal is, zoals het spoor van een herfocus. In de pdf gaat het open. */
function details(summaryText, children) {
  const wrapper = el('details', 'more');
  wrapper.append(el('summary', null, summaryText));
  const body = el('div', 'more-body');
  children.forEach((child) => body.append(child));
  wrapper.append(body);
  return wrapper;
}

function sectionLabel(text) {
  return el('p', 'eyebrow', text);
}

function fmt(value) {
  return typeof value === 'number' ? value.toLocaleString('nl-NL') : '—';
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function intentFlags(intents) {
  if (!intents) return '—';
  const active = Object.entries(intents).filter(([, on]) => on).map(([name]) => name);
  return active.length ? active.join(', ') : 'geen';
}

function featureLabel(type) {
  return FEATURE_LABELS[type] || String(type).replace(/_/g, ' ');
}

/** "3/7": hoeveel van de vergeleken concurrenten iets doen. Altijd een telling, nooit een schatting. */
function share(count, report) {
  return `${count}/${report.coverage.competitorsCompared}`;
}

// --- Praten met de server --------------------------------------------------------

const ABORTED = 'aborted';

function requestError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * POST met echte voortgang. De server stuurt, omdat we erom vragen, één regel
 * JSON per fase en het rapport als laatste regel (lib/progress.js). Een fout vóór
 * de eerste fase (wachtwoord, ontbrekende invoer) komt als gewoon JSON-antwoord.
 */
async function postStream(path, data, { onProgress, signal } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, application/json' };
  if (appPassword) headers['X-App-Password'] = appPassword;

  let response;
  try {
    response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(data), signal });
  } catch (error) {
    if (error.name === 'AbortError') throw requestError('Afgebroken.', ABORTED);
    throw requestError('Geen verbinding met de server. Controleer je internetverbinding.', 'offline');
  }

  if (!/ndjson/i.test(response.headers.get('content-type') || '')) {
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw requestError(`De server gaf een onverwacht antwoord (HTTP ${response.status}).`, 'bad_response');
    }
    if (!response.ok) throw requestError(payload.error || `Aanvraag mislukt (HTTP ${response.status}).`, payload.code || 'analysis_failed');
    return payload;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === 'progress') onProgress?.(message);
        else if (message.type === 'result') return message.data;
        else if (message.type === 'error') throw requestError(message.error || 'Aanvraag mislukt.', message.code || 'analysis_failed');
      }
    }
  } catch (error) {
    if (error.name === 'AbortError' || signal?.aborted) throw requestError('Afgebroken.', ABORTED);
    // Een foutregel van de server heeft al een code en een Nederlandse tekst.
    if (error.code) throw error;
    // De rest is de verbinding die wegviel: time-out van de functie, of wifi.
    throw requestError('De verbinding met de server viel weg voordat de analyse klaar was. Probeer het opnieuw.', 'stream_cut');
  }
  throw requestError('De verbinding met de server viel weg voordat de analyse klaar was. Probeer het opnieuw.', 'stream_cut');
}

// --- Echte voortgang in beeld --------------------------------------------------------------

/** De fasen die de server meldt, met een vaste titel. De server vult de details in. */
const ANALYZE_PLAN = [
  { id: 'bronnen', title: 'Pagina en Google-top 10 ophalen' },
  { id: 'lezen', title: 'Concurrenten lezen en Search Console raadplegen' },
  { id: 'intent', title: 'Intent check door Claude' },
  { id: 'aanbevelingen', title: 'Aanbevelingen schrijven', note: 'alleen bij een match' },
];

const REFOCUS_PLAN = [
  { id: 'pagina', title: 'Pagina ophalen' },
  { id: 'bronnen', title: 'Zoekwoorden verzamelen' },
  { id: 'verrijken', title: 'Zoekvolumes aanvullen', optional: true },
  { id: 'kiezen', title: 'Claude kiest een passend zoekwoord' },
  { id: 'controle', title: 'Voorstellen checken op zoekvolume', optional: true },
];

/** De status van een fase in woorden: kleur, vinkje en doorhaling bereiken een screenreader niet. */
const PANEL_STATE_TEXT = { todo: ', nog niet gestart', active: ', bezig', done: ', afgerond', skipped: ', overgeslagen' };

const SPINNER_SVG = '<svg class="h-4 w-4 animate-spin pstep-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path></svg>';
const CHECK_SVG = '<svg class="h-4 w-4 pstep-check" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z" clip-rule="evenodd"/></svg>';

/**
 * Een kaart met de fasen van de aanvraag. Elke fase toont wat de server er
 * werkelijk over meldt, en hoe lang hij duurde: geen geschatte percentages.
 */
function createProgressPanel(plan, { title, subtitle }) {
  const { wrapper } = card(title, subtitle);
  wrapper.classList.add('progress-panel');
  const body = el('div', 'px-5 py-3');
  const badgeRow = el('div', 'mb-2 hidden');
  const list = el('ol', 'list-none');
  list.setAttribute('aria-live', 'polite');
  body.append(badgeRow, list);
  body.append(el('p', 'mt-2 text-xs leading-5 text-pm-muted', 'Dit is de echte voortgang van de server, fase voor fase. Een analyse met aanbevelingen duurt meestal één tot twee minuten.'));
  wrapper.append(body);

  const rows = new Map();
  const startedAt = new Map();

  const rowFor = (step) => {
    if (rows.has(step.id)) return rows.get(step.id);
    const item = el('li', 'pstep');
    item.dataset.state = 'todo';
    const icon = el('span', 'pstep-icon');
    icon.append(el('span', 'pstep-dot'));
    const heading = el('span', 'pstep-title', step.title);
    const status = el('span', 'sr-only', PANEL_STATE_TEXT.todo);
    heading.append(status);
    const time = el('span', 'pstep-time');
    // De tijd tikt elke halve seconde: die hoort niet in de live-regio.
    time.setAttribute('aria-hidden', 'true');
    const message = el('span', 'pstep-message', step.note ? `(${step.note})` : '');
    item.append(icon, heading, time, message);
    const entry = { item, icon, heading, status, time, message };
    rows.set(step.id, entry);
    // Optionele fasen komen op hun vaste plek in de lijst, pas als de server ze meldt.
    const order = plan.findIndex((candidate) => candidate.id === step.id);
    const next = [...rows.entries()]
      .filter(([id]) => plan.findIndex((candidate) => candidate.id === id) > order)
      .map(([, value]) => value.item)
      .find((node) => node.isConnected);
    if (next && order >= 0) list.insertBefore(item, next);
    else list.append(item);
    return entry;
  };

  plan.filter((step) => !step.optional).forEach(rowFor);

  const setState = (id, state, text) => {
    const step = plan.find((candidate) => candidate.id === id) || { id, title: text || id };
    const entry = rowFor(step);
    entry.item.dataset.state = state;
    entry.status.textContent = PANEL_STATE_TEXT[state] || '';
    if (state === 'active') entry.item.setAttribute('aria-current', 'step');
    else entry.item.removeAttribute('aria-current');
    entry.icon.innerHTML = state === 'active' ? SPINNER_SVG : state === 'done' ? CHECK_SVG : '<span class="pstep-dot"></span>';
    if (text) entry.message.textContent = text;
    if (state === 'active') startedAt.set(id, Date.now());
    if (state === 'done' && startedAt.has(id)) entry.time.textContent = formatSeconds(Date.now() - startedAt.get(id));
  };

  const tick = setInterval(() => {
    for (const [id, entry] of rows) {
      if (entry.item.dataset.state === 'active' && startedAt.has(id)) entry.time.textContent = formatSeconds(Date.now() - startedAt.get(id));
    }
  }, 500);

  return {
    node: wrapper,
    /** Eén regel van de server verwerken. */
    update(message) {
      setState(message.step, message.state, message.message);
      if (message.data?.source) {
        badgeRow.replaceChildren(sourceBadge(message.data, { detail: true }));
        badgeRow.classList.remove('hidden');
        setSourceBadge(message.data);
      }
      // Geen match: de laatste fase is dan niet nodig.
      if (message.step === 'intent' && message.state === 'done' && /geen match/i.test(message.message || '') && rows.has('aanbevelingen')) {
        const entry = rows.get('aanbevelingen');
        entry.item.dataset.state = 'skipped';
        entry.status.textContent = PANEL_STATE_TEXT.skipped;
        entry.message.textContent = 'niet nodig: eerst een beter zoekwoord';
      }
    },
    /** Zolang de server nog niets meldde, staat de eerste fase al op bezig. */
    start() {
      setState(plan[0].id, 'active');
    },
    stop() {
      clearInterval(tick);
    },
  };
}

function formatSeconds(ms) {
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0).replace('.', ',')} s` : formatDuration(ms);
}

let activePanel = null;

function startPanel(plan, options) {
  activePanel?.stop();
  activePanel = createProgressPanel(plan, options);
  activePanel.start();
  return activePanel;
}

// --- Welke data is gebruikt? -------------------------------------------------------------------

/** Korte redenen voor de badge in de kaartkop, waar weinig ruimte is. */
const GSC_REASONS_SHORT = {
  geen_toegang: 'geen GSC-toegang',
  niet_ingesteld: 'GSC niet gekoppeld',
  leeg: 'geen GSC-vertoningen',
};

const GSC_REASONS = {
  geen_toegang: 'geen GSC-toegang voor dit domein',
  niet_ingesteld: 'Search Console niet gekoppeld',
  leeg: 'geen vertoningen in Search Console',
  sleutel_ongeldig: 'de Google-sleutel werd geweigerd',
  api_uit: 'de Search Console API staat uit',
  limiet: 'Search Console gaf een limiet',
  timeout: 'Search Console reageerde niet op tijd',
  fout: 'Search Console gaf een fout',
};

/**
 * Wat de marketeer moet weten over de bron: diepe, gemeten data van een klant,
 * of de globale schatting. Gebaseerd op de vlaggen van de server
 * (source, gsc_error, gsc.status).
 */
function sourceBadgeInfo(info) {
  if (!info?.source) return null;
  // Oude opgeslagen herfocussen: 'gsc' was een eigen export, 'ahrefs' de schatting.
  const source = { gsc: 'gsc_upload', ahrefs: 'ahrefs_only' }[info.source] || info.source;
  switch (source) {
    case 'hybrid_gsc_ahrefs':
    case 'gsc_only':
      return { icon: '⚡', text: 'diepe GSC-data ingeladen (Pure Minds-klant)', short: 'diepe GSC-data', tone: 'pill-good' };
    case 'gsc_upload':
      return { icon: '📄', text: 'eigen Search Console-export ingeladen', short: 'eigen GSC-export', tone: 'pill-good' };
    case 'serp_only':
      return { icon: '🌐', text: 'alleen de Google-top 10 (geen Ahrefs, geen Search Console)', short: 'alleen Google-top 10', tone: 'pill-mid' };
    default: {
      const reason = GSC_REASONS[info.gsc?.status] || 'Search Console niet gebruikt';
      const short = GSC_REASONS_SHORT[info.gsc?.status] || (info.gsc_error ? 'GSC-fout' : 'zonder GSC');
      return { icon: '🌐', text: `globale data gebruikt (${reason})`, short: `globale data · ${short}`, tone: info.gsc_error ? 'pill-mid' : 'pill' };
    }
  }
}

function sourceBadge(info, { detail = false, compact = false } = {}) {
  const badge = sourceBadgeInfo(info);
  const wrap = el('span', 'inline-flex flex-col gap-1 max-w-full');
  if (!badge) return wrap;
  const pill = el('span', `pill source-pill ${badge.tone}`);
  pill.append(el('span', 'source-icon', badge.icon), el('span', null, compact ? badge.short : badge.text));
  pill.firstChild.setAttribute('aria-hidden', 'true');
  wrap.append(pill);
  // Compact of niet: de volledige uitleg staat altijd in de tooltip.
  pill.title = [badge.text, info.gsc?.message].filter(Boolean).join('. ');
  if (info.gsc?.message) {
    if (detail) wrap.append(el('span', 'text-xs leading-5 text-pm-muted', info.gsc.message));
  }
  return wrap;
}

/** De badge in de kaartkop: altijd zichtbaar welke data het huidige rapport draagt. */
function setSourceBadge(info) {
  const badge = sourceBadgeInfo(info);
  sourceBadgeSlot.classList.toggle('hidden', !badge);
  sourceBadgeSlot.replaceChildren(badge ? sourceBadge(info, { compact: true }) : '');
}

// --- Regio kiezen ----------------------------------------------------------------------------

function selectedRegion() {
  return REGION_INFO[regionRadios.find((radio) => radio.checked)?.value] || REGION_INFO.nl;
}

/** Eén regio voor het formulier en de zoekwoordbalk, zodat ze nooit iets anders zeggen. */
function setSelectedRegion(id) {
  const region = REGION_INFO[id] || REGION_INFO.nl;
  regionRadios.forEach((radio) => { radio.checked = radio.value === region.id; });
  recheckRegion.value = region.id;
  storageSet(STORAGE.region, region.id);
  return region;
}

// --- Altijd een ander zoekwoord kunnen proberen ------------------------------------------------

/** De pagina waarvoor de zoekwoordbalk werkt: die van het laatste rapport of van de lopende analyse. */
let recheckUrl = '';

function showRecheck(url, keyword, region) {
  recheckUrl = url;
  recheckForm.classList.remove('hidden');
  // Niet overschrijven terwijl de marketeer zelf aan het typen is.
  if (keyword && document.activeElement !== recheckKeyword) recheckKeyword.value = keyword;
  // De regio volgt het rapport dat in beeld is, in de balk én in het formulier.
  if (region) setSelectedRegion(region.id);
  const hint = `Voor ${url}. Een ander zoekwoord proberen kan altijd, ook tijdens een analyse: die wordt dan afgebroken.`;
  recheckHint.textContent = hint;
  recheckHint.title = hint;
}

function hideRecheck() {
  clearRecheckError();
  recheckUrl = '';
  recheckForm.classList.add('hidden');
}

recheckForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const keyword = recheckKeyword.value.trim();
  if (!keyword || !recheckUrl) {
    recheckKeyword.setAttribute('aria-invalid', 'true');
    recheckError.textContent = 'Typ eerst een zoekwoord.';
    recheckKeyword.focus();
    return;
  }
  clearRecheckError();
  const region = setSelectedRegion(recheckRegion.value);
  lastRefocus = null;
  storageRemove(STORAGE.refocus);
  runAnalysis({ url: recheckUrl, keyword, region, origin: { source: 'handmatig', round: 0 } });
});

recheckRegion.addEventListener('change', () => setSelectedRegion(recheckRegion.value));

function clearRecheckError() {
  recheckKeyword.removeAttribute('aria-invalid');
  recheckError.textContent = '';
}

recheckKeyword.addEventListener('input', clearRecheckError);

// --- De flow ---------------------------------------------------------------------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (isLoading) return;

  const url = urlField.value.trim();
  const keyword = keywordField.value.trim();
  if (!url || !keyword) {
    renderError({ error: 'Vul zowel de doel-URL als het focus zoekwoord in.', code: 'missing_input' });
    return;
  }

  // Een nieuwe handmatige analyse begint een nieuwe flow: een vorige herfocus hoort er niet bij.
  lastRefocus = null;
  storageRemove(STORAGE.refocus);
  runAnalysis({ url, keyword, region: selectedRegion(), origin: { source: 'handmatig', round: 0 } });
});

/**
 * Stap 1 en 2 (en bij een match 3A): één aanroep van /api/analyze.
 *
 * `keepOutput`: na een herfocus blijft de kaart met het gekozen zoekwoord in
 * beeld, met de voortgang erboven. Zo lees je de onderbouwing terwijl de
 * tweede analyse loopt, in plaats van dat hij meteen verdwijnt.
 */
async function runAnalysis({ url, keyword, origin, region = selectedRegion() }, { keepOutput = false } = {}) {
  const run = beginRun();
  retryAfterPassword = null;

  setLoading(true, origin.round > 0 ? `analyse met "${keyword}"` : 'bezig met analyseren');
  setSteps([
    { state: 'active', text: origin.round > 0 ? 'intent check (nieuw zoekwoord)' : 'intent check' },
    { state: origin.round > 0 ? 'done' : 'todo', text: 'focus zoekwoord' },
    { state: 'todo', text: 'aanbevelingen' },
  ]);
  setSourceBadge(null);
  showRecheck(url, keyword, region);

  const panel = startPanel(ANALYZE_PLAN, {
    title: `Bezig met "${keyword}"`,
    subtitle: `Google ${region.label} · ${url}`,
  });
  if (keepOutput) {
    // Voortgang bovenaan, de gekozen zoekwoordkaart eronder: zo zie je allebei.
    actions.replaceChildren();
    output.prepend(panel.node);
  } else {
    showSkeleton(panel);
  }
  resultScroll.scrollTop = 0;
  if (!isDesktop()) resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const report = await postStream('/api/analyze', { url, keyword, origin, region: region.id }, {
      signal: run.controller.signal,
      onProgress: (message) => { if (isCurrent(run)) panel.update(message); },
    });
    if (!isCurrent(run)) return;
    lastReport = report;
    storageSet(STORAGE.report, JSON.stringify(report));

    // De velden volgen pas na een geslaagde analyse het nieuwe zoekwoord. Mislukt
    // de heranalyse, dan staat de invoer nog op wat de marketeer zelf koos.
    urlField.value = url;
    keywordField.value = keyword;
    setSelectedRegion(report.region || region.id);
    updateFieldState();
    storageSet(STORAGE.draft, JSON.stringify(FIELDS.map((field) => field.value)));

    renderReport(report);
    if (report.stage === 'compleet') setStatus('done', 'klaar');
    else setStatus('warn', 'geen match');
  } catch (error) {
    if (error.code === ABORTED || !isCurrent(run)) return;
    if (error.code === 'auth_required') {
      if (lastReport) renderReport(lastReport);
      else showEmpty();
      askForPassword(error.message, () => runAnalysis({ url, keyword, origin, region }));
    } else {
      renderError(error);
    }
  } finally {
    if (isCurrent(run)) {
      endRun(run);
      panel.stop();
      setLoading(false);
    }
  }
}

/** Stap 3B: een beter zoekwoord zoeken bij de pagina, daarna automatisch opnieuw analyseren. */
async function runRefocus({ source, gscText }) {
  const report = lastReport;
  if (!report || report.stage !== 'intent' || isLoading) return;
  const run = beginRun();
  const region = regionOf(report);
  retryAfterPassword = null;
  if (source === 'gsc' && gscText) rememberGsc(gscText);

  setLoading(true, 'beter zoekwoord zoeken');
  const panel = startPanel(REFOCUS_PLAN, {
    title: 'Bezig met een beter zoekwoord zoeken',
    subtitle: source === 'gsc' ? 'Uit je Search Console-export' : `Search Console en Ahrefs · Google ${region.label}`,
  });
  renderReport(report, { refocusBusy: true, panel });
  setSteps([
    { state: 'done', text: 'intent check: geen match' },
    { state: 'active', text: 'focus zoekwoord zoeken' },
    { state: 'todo', text: 'aanbevelingen' },
  ]);
  scrollToRefocus();

  let result;
  try {
    result = await postStream('/api/refocus', {
      url: report.page.url,
      keyword: report.keyword,
      intent: report.intent,
      source,
      gsc: gscText || '',
      round: report.origin.round,
      region: region.id,
    }, {
      signal: run.controller.signal,
      onProgress: (message) => { if (isCurrent(run)) panel.update(message); },
    });
  } catch (error) {
    if (error.code === ABORTED || !isCurrent(run)) return;
    endRun(run);
    panel.stop();
    setLoading(false);
    if (error.code === 'auth_required') {
      renderReport(report);
      askForPassword(error.message, () => runRefocus({ source, gscText }));
      return;
    }
    renderReport(report, { refocusError: error });
    scrollToRefocus();
    return;
  }
  if (!isCurrent(run)) return;
  endRun(run);
  panel.stop();
  setLoading(false);

  lastRefocus = result;
  storageSet(STORAGE.refocus, JSON.stringify(result));

  if (!result.choice) {
    renderReport(report);
    scrollToRefocus();
    return;
  }

  // Alleen de kaart met de keuze blijft staan; de intent check van het afgekeurde
  // zoekwoord hoeft niet meer boven de nieuwe analyse te hangen.
  output.className = 'report';
  output.dataset.stage = report.stage;
  output.replaceChildren(refocusCard(report, { autoStart: true }));
  // Het volledige rapport staat niet meer in beeld: niets om als pdf te bewaren.
  clearPrintContext();
  await runAnalysis(
    {
      url: report.page.url,
      keyword: result.choice.keyword,
      region,
      origin: {
        source: result.choice.source,
        previousKeyword: report.keyword,
        round: report.origin.round + 1,
        why: result.choice.why,
      },
    },
    { keepOutput: true }
  );
}

function scrollToRefocus() {
  document.getElementById('refocus-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function rememberGsc(text) {
  lastGscText = text;
  if (text.length <= MAX_STORED_GSC_CHARS) storageSet(STORAGE.gsc, text);
  else storageRemove(STORAGE.gsc);
}

/** De herfocus die bij dit rapport hoort: die waarin dit zoekwoord gekozen werd. */
function refocusFor(report) {
  if (!lastRefocus?.choice) return null;
  return lastRefocus.choice.keyword.toLowerCase() === report.keyword.toLowerCase() ? lastRefocus : null;
}

/** Knop waarmee de marketeer zelf een alternatief kiest. */
function analyseWithButton(keyword, source, why, report) {
  const button = el('button', 'btn btn-outline btn-xs btn-wrap');
  button.type = 'button';
  button.textContent = `analyseer met "${keyword}"`;
  // Tijdens een analyse uit: een tweede klik zou toch genegeerd worden.
  button.dataset.busyDisable = '';
  button.disabled = isLoading;
  button.addEventListener('click', () => {
    runAnalysis({
      url: report.page.url,
      keyword,
      region: regionOf(report),
      origin: {
        source,
        previousKeyword: lastRefocus?.rejectedKeyword || report.keyword,
        // Een zelf gekozen alternatief telt als ronde, maar nooit verder dan de limiet.
        round: Math.min(report.origin.round + 1, report.maxRounds),
        why: why || '',
      },
    });
  });
  return button;
}

// --- Het rapport renderen ---------------------------------------------------------

function renderReport(report, options = {}) {
  output.className = 'report';
  output.dataset.stage = report.stage;
  output.replaceChildren(...reportCards(report, options));
  actions.replaceChildren(
    copyButton(() => toMarkdown(report), 'kopieer markdown', 'btn btn-quiet btn-sm relative'),
    pdfButton(report)
  );
  setPrintContext(report);
  setSourceBadge(report);
  if (report.page?.url) showRecheck(report.page.url, report.keyword, regionOf(report));

  // Tijdens de herfocus loopt er nog een aanvraag: voortgangsbalk en stappen
  // blijven dan zoals runRefocus ze zette.
  if (options.refocusBusy) return;
  progressBar.classList.add('hidden');

  if (report.stage === 'compleet') {
    setSteps([
      { state: 'done', text: 'intent check: match' },
      { state: 'done', text: report.origin.source === 'handmatig' ? 'focus zoekwoord: behouden' : 'focus zoekwoord: nieuw' },
      { state: 'done', text: 'aanbevelingen' },
    ]);
  } else {
    setSteps([
      { state: 'done', text: 'intent check: geen match' },
      { state: 'active', text: 'focus zoekwoord' },
      { state: 'todo', text: 'aanbevelingen' },
    ]);
  }
}

/**
 * Kwamen er geen zoekwoordcijfers binnen, dan zeggen we dat, en niet dat Ahrefs
 * het zoekwoord niet kent. Is het zoekwoord ook het topzoekwoord van een
 * concurrent, dan staat het volume wél in de SERP-data; dat noemen we erbij.
 */
function missingVolumeText(report) {
  const base = report.keywordInfoError
    ? `niet opgehaald: ${report.keywordInfoError}`
    : 'geen zoekwoordcijfers ontvangen van Ahrefs';
  const wanted = sameKeyword(report.keyword);
  const fromSerp = (report.measured?.topKeywords || []).find((entry) => sameKeyword(entry.keyword) === wanted && typeof entry.volume === 'number');
  return fromSerp ? `${base}; als topzoekwoord in de SERP: ${fmt(fromSerp.volume)} per maand` : base;
}

function sameKeyword(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Korte bronlabels per zoekwoordrij: meting (Search Console) of schatting (Ahrefs). */
const ORIGIN_LABELS = {
  gsc: { text: 'Search Console', short: 'GSC', pill: 'pill-good' },
  upload: { text: 'Search Console', short: 'GSC', pill: 'pill-good' },
  'gsc+ahrefs': { text: 'Search Console + Ahrefs', short: 'GSC + Ahrefs', pill: 'pill-good' },
  ahrefs: { text: 'Ahrefs (schatting)', short: 'Ahrefs', pill: 'pill-mid' },
};

/**
 * "Positie" betekent per bron iets anders: gemiddeld over 90 dagen in Search
 * Console, de beste positie in Nederland bij Ahrefs. Een Ahrefs-positie krijgt
 * daarom een ~ en het woord Ahrefs erbij.
 */
function positionLabel(position, origin, { short = false } = {}) {
  if (position === null || position === undefined) return null;
  const value = String(position).replace('.', ',');
  if (origin === 'ahrefs') return short ? `~${value}` : `~${value} (Ahrefs)`;
  return `gem. ${value}`;
}

/**
 * De bron van een herfocuslijst als geheel: 'ahrefs' (schatting) of 'gsc' (meting).
 * Kent zowel de nieuwe waarden van de server (ahrefs_only, hybrid_gsc_ahrefs,
 * gsc_only, gsc_upload) als de oude (ahrefs, gsc) uit een opgeslagen rapport.
 */
function listSourceOf(result) {
  return result?.source === 'ahrefs' || result?.source === 'ahrefs_only' ? 'ahrefs' : 'gsc';
}

/** Alternatieven en voorstellen uit een eerdere herfocus, zonder het zoekwoord dat nu net faalde. */
function previousRoundOptions(report) {
  if (!lastRefocus || lastRefocus.rejectedKeyword === report.keyword) return [];
  const current = report.keyword.toLowerCase();
  const listSource = listSourceOf(lastRefocus);
  const options = [
    ...(lastRefocus.alternatives || []).map((item) => ({ ...item, source: item.source || listSource })),
    ...(lastRefocus.proposals || []).filter((item) => item.verified).map((item) => ({ ...item, source: 'ai' })),
  ];
  return options.filter((item) => item.keyword.toLowerCase() !== current);
}

function refocusForm(report) {
  const box = el('div', 'rsub');

  let gscText = lastGscText;

  const drop = el('label', 'dropzone');
  const input = el('input', 'sr-only');
  input.type = 'file';
  input.accept = '.csv,.tsv,.txt,.json';
  input.setAttribute('aria-label', 'Search Console-export kiezen');
  const dropText = el('span', 'block text-sm font-semibold', 'kies een bestand of sleep het hierheen');
  const dropHint = el('span', 'mt-1 block text-xs text-pm-muted', 'CSV, TSV of JSON uit Search Console, maximaal 1 MB');
  drop.append(input, dropText, dropHint);

  const textarea = el('textarea', 'input text-xs');
  textarea.rows = 3;
  textarea.placeholder = 'Of plak hier de tabel uit Search Console (zoekopdracht, klikken, vertoningen, CTR, positie)';
  textarea.setAttribute('aria-label', 'Search Console-export plakken');

  const error = el('p', 'hidden text-sm font-semibold text-pm-magenta');
  error.setAttribute('role', 'alert');

  const submit = el('button', 'btn btn-primary btn-sm');
  submit.type = 'button';
  submit.textContent = 'zoek beter zoekwoord in search console';

  const viaAhrefs = el('button', 'btn btn-outline btn-sm');
  viaAhrefs.type = 'button';
  viaAhrefs.textContent = 'haal zoekwoorden op';

  const update = () => {
    submit.disabled = !gscText.trim();
  };

  const readFile = async (file) => {
    error.classList.add('hidden');
    if (file.size > MAX_GSC_BYTES) {
      error.textContent = 'Dit bestand is groter dan 1 MB. Exporteer alleen het tabblad Zoekopdrachten.';
      error.classList.remove('hidden');
      return;
    }
    gscText = await file.text();
    textarea.value = gscText;
    dropText.textContent = `${file.name} ingeladen`;
    drop.classList.add('is-filled');
    update();
  };

  input.addEventListener('change', () => {
    if (input.files && input.files[0]) readFile(input.files[0]);
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    const file = event.dataTransfer?.files?.[0];
    if (file) readFile(file);
  });
  textarea.addEventListener('input', () => {
    gscText = textarea.value;
    update();
  });

  submit.addEventListener('click', () => runRefocus({ source: 'gsc', gscText }));
  viaAhrefs.addEventListener('click', () => runRefocus({ source: 'ahrefs' }));

  // Tweede ronde: de export van deze pagina staat al klaar, opnieuw inladen hoeft niet.
  if (gscText) {
    textarea.value = gscText;
    dropText.textContent = 'de vorige export staat klaar';
    drop.classList.add('is-filled');
  }
  update();

  // Twee wegen naast elkaar, elk met zijn soort data: meting of schatting.
  const panelHead = (title, kind, text) => {
    const head = el('div', 'rsub-head');
    head.append(el('h4', 'rsub-title', title), prov(kind, text));
    return head;
  };
  const gscPanel = el('div', 'refocus-panel');
  gscPanel.append(
    panelHead('Search Console-export', 'meting', 'meting'),
    el('p', 'compare-text', 'Exporteer in Search Console het prestatierapport van deze pagina (Prestaties, filter op de exacte URL, Exporteren). Laad het bestand met zoekopdrachten hier in, of plak de tabel. De tool zoekt daarin een zoekwoord dat wél bij de pagina past.'),
    drop,
    textarea,
    submit
  );
  const ahrefsPanel = el('div', 'refocus-panel');
  ahrefsPanel.append(
    panelHead('Automatisch ophalen', null, 'meting of schatting'),
    el('p', 'compare-text', 'Geen export bij de hand? De tool haalt de zoekwoorden van deze pagina zelf op: uit Search Console als de tool toegang heeft tot dit domein (meting), anders de zoekwoorden waarop Ahrefs deze URL ziet ranken (schatting, zonder klikken en vertoningen). Het resultaat zegt welke bron het werd.'),
    viaAhrefs
  );
  const panels = el('div', 'refocus-panels');
  panels.append(gscPanel, ahrefsPanel);
  box.append(panels, error);
  return box;
}

/**
 * @param options.autoStart  de heranalyse met de keuze loopt nu
 * @param options.done       terugblik op een afgeronde herfocus: geen startknoppen
 */
function refocusResult(result, report, options = {}) {
  const box = el('div', 'rsub');
  const listSource = listSourceOf(result);

  // In het rapport (en dus de pdf) de bron in woorden, zonder de emoji van de badge.
  const source = clientSource(result);
  if (source) {
    const line = el('p', 'source-line');
    line.append(prov(source.kind, source.text));
    box.append(line);
  }
  if (result.note) box.append(el('p', 'note', result.note));
  if (result.pageSummary) {
    const summary = el('p', 'compare-text');
    summary.append(el('strong', null, 'Wat de pagina is: '), document.createTextNode(result.pageSummary));
    box.append(summary);
  }

  if (result.choice) {
    const { choice } = result;
    const card = el('div', 'verdict verdict-yes choice');
    card.append(el('p', 'eyebrow', 'Nieuw focus zoekwoord'), el('p', 'keyword-hero', choice.keyword));
    const facts = candidateFacts(choice, choice.source, report);
    if (facts) card.append(facts);
    const origin = el('p', 'source-line');
    origin.append(prov(SOURCE_KIND[choice.source], SOURCE_LABELS[choice.source] || choice.source));
    card.append(origin);
    if (choice.why) {
      const why = el('p', 'compare-text', `${choice.why} `);
      why.append(prov('claude', PROV_TEXT.claude));
      card.append(why);
    }
    if (options.autoStart) {
      card.append(el('p', 'note screen-only', 'De analyse met dit zoekwoord loopt nu; de voortgang staat hierboven.'));
    } else if (!options.done) {
      // Na een refresh of een mislukte heranalyse loopt er niets: dan starten we op verzoek.
      const next = el('div', 'screen-only flex flex-wrap items-center gap-2 text-xs text-pm-muted');
      next.append(
        document.createTextNode('De analyse met dit zoekwoord is nog niet gestart.'),
        analyseWithButton(choice.keyword, choice.source, choice.why, report)
      );
      card.append(next);
    }
    box.append(card);
  } else {
    box.append(
      el(
        'p',
        'notice notice-warn text-sm leading-6',
        result.proposals.length
          ? 'In de lijst staat geen zoekwoord dat bij de pagina past. Claude stelde zelf zoekwoorden voor, maar Ahrefs kent daar geen zoekvolume voor. Kies er toch een, of vul zelf een zoekwoord in.'
          : 'In de lijst staat geen zoekwoord dat bij de pagina past en er kwam geen bruikbaar voorstel. Vul zelf een ander zoekwoord in.'
      )
    );
  }

  if (result.rejected) box.append(el('p', 'compare-text text-pm-muted', result.rejected));

  const withButtons = !options.done;
  if (result.alternatives.length) {
    box.append(candidateList('Alternatieven uit de lijst', result.alternatives, listSource, report, { withButtons }));
  }
  if (result.proposals.length) {
    box.append(candidateList('Voorstellen van Claude (zoekvolume gecheckt bij Ahrefs)', result.proposals, 'ai', report, { withButtons }));
  }

  if (result.rows.length) {
    const table = el('table', 'data-table is-fixed');
    table.append(el('caption', 'sr-only', 'Zoekwoorden uit de lijst'));
    const head = el('thead');
    const headRow = el('tr');
    // Kolommen per breedte van het rapport, niet van het scherm: zo staan ze ook in de pdf.
    [['Zoekwoord', ''], ['Bron', 'cq-m w-src'], ['Klikken', 'cq-l num w-clicks'], [['Vert.', 'Vertoningen'], 'num w-imp is-short'], ['Positie', 'num w-rank'], ['Volume', 'cq-l num w-vol']]
      .forEach(([label, className]) => {
        const cell = el('th', className || null);
        cell.scope = 'col';
        if (Array.isArray(label)) cell.append(el('span', 'cq-until-m', label[0]), el('span', 'cq-from-m', label[1]));
        else cell.textContent = label;
        headRow.append(cell);
      });
    head.append(headRow);
    const rows = el('tbody');
    result.rows.forEach((row) => {
      const tr = el('tr');
      tr.append(
        queryCell(row),
        originCell(row.origin),
        el('td', 'cq-l num', fmt(row.clicks)),
        el('td', 'num', fmt(row.impressions)),
        el('td', 'num', positionLabel(row.position, row.origin, { short: true }) || '—'),
        el('td', 'cq-l num', fmt(row.volume))
      );
      rows.append(tr);
    });
    table.append(head, rows);
    const wrap = el('div', 'table-wrap');
    wrap.append(table);
    const legend = el('p', 'note', tableLegend(result));
    const topNote = result.rowCount > result.rows.length ? ` (top ${result.rows.length})` : '';
    box.append(details(`Bekijk de ${result.rowCount} zoekwoorden uit de lijst${topNote}`, [wrap, legend]));
  }

  if (!options.done && !options.autoStart) {
    const again = el('button', 'btn btn-quiet btn-xs screen-only');
    again.type = 'button';
    again.textContent = 'opnieuw met een andere export';
    again.addEventListener('click', () => {
      lastRefocus = null;
      storageRemove(STORAGE.refocus);
      renderReport(report);
    });
    box.append(again);
  }

  return box;
}

/**
 * De uitleg onder de zoekwoordtabel, opgebouwd uit wat er werkelijk gemeten is:
 * een eigen export heeft een onbekende periode en onbekende landen, en een lijst
 * zonder landfilter telt alle landen samen. Elk deel staat er alleen als de
 * tabel zo'n rij of kolom echt bevat.
 */
function tableLegend(result) {
  const region = regionOf(result);
  const source = { gsc: 'gsc_upload', ahrefs: 'ahrefs_only' }[result.source] || result.source;
  const rows = result.rows || [];
  // Rijen uit een oud rapport hebben geen origin; die komen uit Search Console.
  const measured = rows.filter((row) => row.origin !== 'ahrefs');
  const parts = [];
  if (source === 'gsc_upload') {
    parts.push('GSC = je eigen Search Console-export (periode en landen van de export).');
  } else if (result.gsc?.startDate && measured.length) {
    const where = result.gsc.country ? `alleen ${region.label}` : 'alle landen samen';
    parts.push(`GSC = Search Console, gemeten van ${result.gsc.startDate} t/m ${result.gsc.endDate}, ${where}.`);
  }
  if (rows.some((row) => row.origin === 'ahrefs' || row.origin === 'gsc+ahrefs' || row.volume != null)) {
    parts.push(`Ahrefs = schatting voor ${region.label}; het volume komt altijd van Ahrefs.`);
  }
  const positions = [];
  if (measured.some((row) => row.position != null)) positions.push('gem. = gemiddelde in Search Console');
  if (rows.some((row) => row.origin === 'ahrefs' && row.position != null)) positions.push(`~ = beste positie in ${region.label} volgens Ahrefs`);
  if (positions.length) parts.push(`Positie: ${positions.join(', ')}.`);
  return parts.join(' ');
}

/** Op een telefoon staat de bron onder het zoekwoord: een eigen kolom past daar niet. */
function queryCell(row) {
  const cell = el('td');
  cell.append(el('span', 'cell-main', row.query));
  const label = ORIGIN_LABELS[row.origin];
  if (label) {
    const line = el('span', 'cell-sub cq-until-m');
    line.append(el('span', `pill ${label.pill}`, label.short));
    cell.append(line);
  }
  return cell;
}

function originCell(origin) {
  const cell = el('td', 'cq-m');
  const label = ORIGIN_LABELS[origin];
  cell.append(label ? el('span', `pill ${label.pill}`, label.short) : document.createTextNode('—'));
  return cell;
}

/**
 * De cijfers bij een kandidaat, elk met zijn bron: volume is een schatting van
 * Ahrefs, vertoningen en gemiddelde positie een meting in Search Console, een
 * positie met ~ de schatting van Ahrefs.
 */
function candidateFacts(item, source, report) {
  const facts = el('p', 'cand-facts');
  if (item.fit) facts.append(statusTag(item.fit === 'goed' ? 'good' : 'mid', `past ${item.fit}`));
  if (typeof item.volume === 'number') {
    facts.append(el('span', null, `${fmt(item.volume)}/mnd`), prov('schatting', PROV_TEXT.ahrefs(regionOf(report))));
  } else if (source === 'ai') {
    facts.append(el('span', 'pill pill-bad', 'geen volume bekend'));
  }
  const origin = item.row?.origin || (source === 'ahrefs' ? 'ahrefs' : source === 'gsc' ? 'gsc' : null);
  const seen = [
    item.row?.impressions != null ? `${fmt(item.row.impressions)} vertoningen` : null,
    positionLabel(item.row?.position, origin),
  ].filter(Boolean);
  if (seen.length) facts.append(el('span', null, seen.join(' · ')));
  if (ORIGIN_LABELS[origin]) facts.append(prov(origin === 'ahrefs' ? 'schatting' : 'meting', ORIGIN_LABELS[origin].text));
  else if (source === 'ai') facts.append(prov('claude', item.verified ? 'AI-voorstel, zoekvolume geverifieerd bij Ahrefs' : 'AI-voorstel'));
  return facts.childNodes.length ? facts : null;
}

function candidateList(title, items, source, report, { withButtons = true } = {}) {
  const block = el('div');
  block.append(el('p', 'eyebrow', title));
  const list = el('ul', 'cand-list');
  items.forEach((item) => {
    const itemSource = item.source || source;
    const li = el('li');
    const text = el('div', 'min-w-0');
    text.append(el('p', 'cand-kw', item.keyword));
    const facts = candidateFacts(item, itemSource, report);
    if (facts) text.append(facts);
    if (item.why) text.append(el('p', 'cand-why', item.why));
    li.append(text);
    // De server geeft per zoekwoord de bron mee (Search Console of Ahrefs); anders die van de lijst.
    if (withButtons) {
      const action = el('div', 'screen-only');
      action.append(analyseWithButton(item.keyword, itemSource, item.why, report));
      li.append(action);
    }
    list.append(li);
  });
  block.append(list);
  return block;
}

/** "zoekwoord (volume · vertoningen)": elk cijfer met zijn bron, in de kaart én in de export. */
function mappingLabel(item) {
  const facts = [
    typeof item.volume === 'number' ? `${fmt(item.volume)} per maand, Ahrefs` : null,
    typeof item.impressions === 'number' ? `${fmt(item.impressions)} vertoningen, Search Console` : null,
  ].filter(Boolean);
  return facts.length ? `${item.keyword} (${facts.join(' · ')})` : item.keyword;
}

function mappingMarkdown(report) {
  const { mapping } = report;
  const line = (items) => (items.length ? items.map(mappingLabel).join(', ') : 'geen');
  return [
    '## Aanbevolen keyword mapping',
    '',
    `- Primary: ${mapping.primary}`,
    `- Secondary: ${line(mapping.secondary)}`,
    `- Supporting: ${line(mapping.supporting)}`,
    `- Varianten: ${line(mapping.variants)}`,
    `- Merktermen: ${line(mapping.brand)}`,
  ].join('\n');
}

function topicMarkdown(topic) {
  const lines = [`## ${topic.heading}`];
  if (topic.subheadings.length) lines.push('', ...topic.subheadings.map((sub) => `### ${sub}`));
  lines.push('', `> ${topic.why}`);
  if (topic.advice) lines.push('>', `> ${topic.advice}`);
  return lines.join('\n');
}

function questionSource(item) {
  if (item.source === 'Mensen vragen ook') return 'Google: Mensen vragen ook';
  return `kop bij #${item.position} ${domainFromUrl(item.from)}`;
}

// --- Markdown-export -----------------------------------------------------------

/**
 * Het hele rapport als markdown, in dezelfde volgorde en met dezelfde woorden als
 * het scherm en de pdf: zo lopen de drie nooit uit elkaar.
 */
function toMarkdown(report) {
  const { intent, measured, keywordInfo, page, serp, origin, gsc } = report;
  const region = regionOf(report);
  const kept = origin.source === 'handmatig';
  const source = clientSource(report);
  const focusGsc = gsc?.status === 'ok' ? gsc.insight?.focusKeyword : null;
  const positions = (list) => list.map((position) => `#${position}`).join(', ');

  const lines = [
    `# Focus keyword-rapport: ${report.keyword}`,
    '',
    `**Pagina:** ${page.url}`,
    `**Focus zoekwoord:** ${report.keyword}${kept ? '' : ` (nieuw, ${originLabel(report)}; vervangt "${origin.previousKeyword}")`}`,
    `**Positie in Google:** ${serp.targetPosition ? `#${serp.targetPosition}` : 'buiten de top 10'} (${serp.provider})`,
    `**Geanalyseerd op:** ${formatDate(report.generatedAt, { time: true })}`,
    `**Regio:** Google ${region.label}, teksten in het ${region.language}`,
    ...(source ? [`**Databron:** ${source.text}`] : []),
    ...(focusGsc ? [`**Search Console (dit zoekwoord):** ${fmt(focusGsc.impressions)} vertoningen, ${fmt(focusGsc.clicks)} klikken, gem. positie ${decimal(focusGsc.position)} (${gscWhen(gsc, report)})`] : []),
    '',
    '## Beoordeling huidige focus keyword',
    '',
    `**${intent.match ? 'Geschikt als primary keyword.' : 'Niet geschikt als primary keyword.'}** Zekerheid: ${intent.confidence}.${intent.mismatch ? ` Soort mismatch: ${intent.mismatch.label}.` : ''}`,
    '',
    `- Jouw pagina: ${intent.page.pageType} (${intent.page.intentType}). ${intent.page.summary}`,
    `- De top 10: ${intent.serp.dominantPageType} (${intent.serp.intentType}). ${intent.serp.summary}${intent.serp.positions.length ? ` Dominante groep: ${positions(intent.serp.positions)}.` : ''}`,
    ...intent.reasons.map((reason) => `- ${reason.text}${reason.positions.length ? ` (${positions(reason.positions)})` : ''}`),
  ];

  if (intent.mismatch) {
    if (intent.mismatch.explanation) lines.push('', intent.mismatch.explanation);
    if (intent.mismatch.direction) lines.push('', `Richting voor een beter zoekwoord: ${intent.mismatch.direction}`);
  }

  lines.push('', '**Gemeten:**', '');
  if (measured.pageTypes.length) {
    lines.push(`- Paginatypes in de top 10 (SERP · ${serpSourceName(report)}): ${measured.pageTypes.map((type) => `${type.label} ${type.count}× (${positions(type.positions)})`).join('; ')}`);
  }
  if (keywordInfo) {
    lines.push(`- Zoekvolume (schatting · Ahrefs ${region.short}): ${fmt(keywordInfo.volume)} per maand, moeilijkheid ${fmt(keywordInfo.difficulty)}${keywordInfo.parentTopic ? `, parent topic "${keywordInfo.parentTopic}" (${fmt(keywordInfo.parentVolume)})` : ''}`);
    lines.push(`- Intentievlaggen Ahrefs: ${intentFlags(keywordInfo.intents)}`);
  } else {
    lines.push(`- Zoekvolume: ${missingVolumeText(report)}`);
  }
  lines.push(`- Jouw pagina in de top 10: ${measured.ownPosition ? `ja, positie ${measured.ownPosition}` : 'nee'}`);
  if (measured.topKeywords.length) {
    lines.push(`- Topzoekwoorden van de concurrenten: ${measured.topKeywords.slice(0, 5).map((entry) => `${entry.keyword} (${entry.count}×)`).join(', ')}`);
  }
  const totals = gsc?.status === 'ok' ? gsc.insight?.totals : null;
  if (totals) {
    lines.push(`- Search Console, ${totals.scope === 'pagina' ? 'hele pagina' : 'getoonde zoekopdrachten'} (meting): ${fmt(totals.impressions)} vertoningen, ${fmt(totals.clicks)} klikken${typeof totals.position === 'number' ? `, gem. positie ${decimal(totals.position)}` : ''}`);
  }

  if (report.stage !== 'compleet') {
    const refocus = lastRefocus && lastRefocus.rejectedKeyword === report.keyword ? lastRefocus : null;
    lines.push('', '## Focus keyword: een beter zoekwoord zoeken', '');
    if (refocus?.choice) {
      lines.push(`Nieuw focus keyword: **${refocus.choice.keyword}** (${SOURCE_LABELS[refocus.choice.source] || refocus.choice.source}). ${refocus.choice.why}`);
    } else if (refocus) {
      lines.push(refocus.rejected || 'Er is in de lijst geen passend zoekwoord gevonden.');
      refocus.proposals.forEach((item) => lines.push(`- Voorstel: ${item.keyword}${typeof item.volume === 'number' ? ` (${fmt(item.volume)} per maand)` : ' (geen volume bekend)'} — ${item.why}`));
    } else {
      lines.push('Laad een Search Console-export van deze pagina in om een beter passend zoekwoord te vinden, of schat de rankende zoekwoorden via Ahrefs.');
    }
    markdownSources(lines, report, 'Het oordeel over de zoekintentie is een interpretatie van Claude op basis van de gemeten data in dit rapport.');
    return lines.join('\n');
  }

  lines.push('', `## Focus keyword: ${report.keyword} (${kept ? 'behouden als Primary' : 'nieuw'})`, '');
  if (kept) {
    lines.push('Het opgegeven zoekwoord past bij de pagina en bij de Google-top 10. Het blijft het primary keyword.');
  } else {
    lines.push(`Vervangt "${origin.previousKeyword}". ${originLabel(report)}.${origin.why ? ` ${origin.why}` : ''}`);
    // Dezelfde bewijslast als op het scherm: waarom de rest van de lijst afviel, en wat de alternatieven waren.
    const refocus = refocusFor(report);
    if (refocus) {
      if (refocus.rejected) lines.push('', refocus.rejected);
      const alternatives = [...(refocus.alternatives || []), ...(refocus.proposals || []).filter((item) => item.verified)]
        .filter((item) => item.keyword.toLowerCase() !== report.keyword.toLowerCase());
      if (alternatives.length) {
        lines.push('', 'Alternatieven:');
        alternatives.forEach((item) => {
          const facts = [
            typeof item.volume === 'number' ? `${fmt(item.volume)} per maand` : null,
            item.row?.impressions != null ? `${fmt(item.row.impressions)} vertoningen` : null,
          ].filter(Boolean).join(', ');
          lines.push(`- ${item.keyword}${facts ? ` (${facts})` : ''}${item.why ? ` — ${item.why}` : ''}`);
        });
      }
    }
  }

  lines.push('', mappingMarkdown(report), '', '## Focus keyword optimalisatie', '');
  Object.entries(report.placement).forEach(([key, item]) => {
    const status = PLACEMENT_STATUS[item.status] || PLACEMENT_STATUS.ontbreekt;
    lines.push(`### ${PLACEMENT_LABELS[key]}`, '');
    lines.push(`${item.status === 'letterlijk' ? 'Al correct' : 'Niet correct'}: ${status.text}.${item.text ? ` Nu: "${truncate(item.text, 240)}"` : ' Nu leeg.'}`);
    if (item.rewrite) lines.push('', `Nieuwe versie: "${item.rewrite}"`);
    lines.push('');
  });
  lines.push('De rest van de pagina mag variëren tussen het focus zoekwoord, de secondary en de varianten.', '');

  const { coverage } = report;
  lines.push(
    '## Aanbevelingen voor de pagina',
    '',
    `- Onderwerpdekking: **${coverage.score ?? '—'}%** (${coverage.topicsWithHeading} met eigen kop, ${coverage.topicsInTextOnly} alleen in de tekst, ${coverage.topicsMissing} ontbreekt; gemeten bij ${coverage.competitorsCompared} concurrenten)`,
    `- Woorden: **${page.wordCount}** op je pagina${coverage.benchmarkWordCount ? `, mediaan top 10: ${coverage.benchmarkWordCount}${coverage.wordCountRange ? ` (spreiding ${coverage.wordCountRange[0]}–${coverage.wordCountRange[1]})` : ''}` : ''}`,
    `- Semantische termen aanwezig: **${coverage.termsPresent} van ${coverage.termsTotal}**`,
    ''
  );
  const topicLines = (topic, index, gap) => {
    lines.push(`### ${index}. ${topic.heading} (${topic.level})`, '');
    lines.push(`SERP-evidence: ${topic.why ? `${topic.why} ` : ''}${topic.sources.map((item) => `#${item.position} ${item.domain}: "${item.heading}"`).join('; ')} (${share(topic.coveredBy, report)} concurrenten)`);
    lines.push(`Gap: ${gap}`);
    if (topic.advice) lines.push(`Aanbeveling: ${topic.advice}`);
    if (topic.subheadings.length) lines.push(`H3-suggesties: ${topic.subheadings.join('; ')}`);
    lines.push('');
  };
  let counter = 1;
  if (report.missingTopics.length === 0 && report.partialTopics.length === 0) {
    lines.push('Geen ontbrekende onderwerpen gevonden.', '');
  }
  report.missingTopics.forEach((topic) => topicLines(topic, counter++, 'ontbreekt op de pagina: geen kop en niet in de tekst'));
  report.partialTopics.forEach((topic) => topicLines(topic, counter++, 'staat in de tekst, maar zonder eigen kop'));
  if (report.coveredTopics.length) {
    lines.push(`Al goed behandeld: ${report.coveredTopics.map((topic) => topic.heading).join('; ')}.`, '');
  }

  lines.push('### Semantische termen', '');
  if (report.missingTerms.length === 0) {
    lines.push('Alle gevonden termen staan al op de pagina.', '');
  } else {
    report.missingTerms.forEach((term) =>
      lines.push(`- **${term.term}** (${share(term.usedBy, report)} concurrenten) — ${term.context}`));
    lines.push('');
  }

  lines.push(report.serp.peopleAlsoAsk > 0 ? '### Mensen vragen ook' : '### Vragen uit de top 10 (vraagkoppen van concurrenten)', '');
  report.questions.forEach((item) => {
    const mark = item.status === 'kop' ? '✓ al beantwoord' : item.status === 'tekst' ? '~ staat in de tekst' : '✗ ontbreekt';
    lines.push(`- **${item.question}** (${mark}; ${questionSource(item)})${item.angle ? ` — ${item.angle}` : ''}`);
  });
  if (!report.questions.length) lines.push('Geen vragen gevonden.');

  lines.push('', '## Niet doen', '');
  if (report.avoid.length) {
    report.avoid.forEach((item) => lines.push(`- ${item.text} (gezien bij ${item.sources.map((ref) => `#${ref.position} ${ref.domain}`).join(', ')})`));
  } else {
    lines.push('Geen specifieke valkuilen gezien bij de concurrenten.');
  }

  lines.push('', '## Samenvatting', '', report.summary || '—');
  markdownSources(lines, report, report.disclaimer);
  return lines.join('\n');
}

/** De bijlage: met welke pagina's vergeleken is en welke data het rapport draagt. */
function markdownSources(lines, report, method) {
  const { serp, gsc } = report;
  const region = regionOf(report);
  lines.push(
    '',
    '## Bronnen en methode',
    '',
    `Vergeleken met (${serp.provider}):`,
    '',
    ...serp.results.map((result) =>
      `${result.position}. ${result.url} — ${result.status}${result.pageTypeLabel ? `, ${result.pageTypeLabel}` : ''}${result.wordCount != null ? `, ${result.wordCount} woorden` : ''}${result.reason ? ` (${result.reason})` : ''}`),
    '',
    `- Regio: Google ${region.label}, teksten in het ${region.language}; uitleg in het Nederlands`,
    `- Search Console: ${gsc?.status === 'ok' ? `gekoppeld, ${gscWhen(gsc, report)}` : gsc ? GSC_REASONS[gsc.status] || 'niet gebruikt' : 'niet gebruikt in dit rapport'}`,
    ...(report.quality ? [`- Gecontroleerd: ${report.quality.droppedTopics ?? 0} onderwerpen en ${report.quality.droppedMapping ?? 0} mapping-zoekwoorden weggelaten omdat het bewijs ontbrak`] : []),
    ...(report.factCheck ? [`- Cijfercontrole: ${factCheckText(report.factCheck)}`] : []),
    '',
    '---',
    '',
    method || ''
  );
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// --- Staten --------------------------------------------------------------------

function showEmpty() {
  output.className = '';
  delete output.dataset.stage;
  clearPrintContext();
  output.innerHTML = EMPTY_STATE;
  actions.replaceChildren();
  progressBar.classList.add('hidden');
  setStatus(null);
  setSourceBadge(null);
  hideRecheck();
  setSteps([
    { state: 'todo', text: 'intent check' },
    { state: 'todo', text: 'focus zoekwoord' },
    { state: 'todo', text: 'aanbevelingen' },
  ]);
}

function skeletonNode() {
  return document.getElementById('loading-state').content.cloneNode(true);
}

function showSkeleton(panel) {
  output.className = 'space-y-4';
  delete output.dataset.stage;
  clearPrintContext();
  output.replaceChildren(...(panel ? [panel.node] : []), skeletonNode());
  actions.replaceChildren();
  progressBar.classList.remove('hidden');
  progressBar.setAttribute('data-indeterminate', '');
}

/** Foutmeldingen met een uitleg die past bij wat er misging. */
const ERROR_HINTS = {
  invalid_url: 'Gebruik de volledige URL van één pagina, bijvoorbeeld www.klant.nl/diensten.',
  blocked_host: 'Alleen openbaar bereikbare pagina\'s kunnen geanalyseerd worden.',
  http_error: 'Test de URL in een privévenster. Blokkeert de server bots, dan kan de tool er niet bij.',
  fetch_failed: 'Controleer de schrijfwijze van het domein. Bestaat de site wel en is hij bereikbaar?',
  no_serp_key: 'Zet de genoemde variabele in Vercel onder Settings → Environment Variables (of lokaal in .env.local) en rol opnieuw uit.',
  no_ahrefs_key: 'Zet AHREFS_API_KEY in Vercel onder Settings → Environment Variables (of lokaal in .env.local).',
  ahrefs_auth: 'Controleer of de Ahrefs-sleutel klopt, nog geldig is en of er nog API-units over zijn.',
  ahrefs_quota: 'Ahrefs geeft een limiet aan. Wacht even, of controleer het aantal units in Ahrefs.',
  ahrefs_timeout: 'Ahrefs reageerde niet op tijd. Probeer het zo opnieuw.',
  ahrefs_failed: 'Ahrefs is mogelijk tijdelijk niet bereikbaar. Probeer het zo opnieuw.',
  ahrefs_no_keywords: 'Ahrefs ziet deze URL nergens ranken. Laad een Search Console-export in.',
  serp_auth: 'Controleer of de Serper-sleutel klopt en nog actief is op serper.dev.',
  serp_quota: 'Vul het tegoed aan op serper.dev of wacht tot de limiet vrijkomt.',
  serp_timeout: 'De SERP-bron reageerde niet op tijd. Probeer het zo opnieuw.',
  serp_failed: 'De SERP-bron is mogelijk tijdelijk niet bereikbaar. Probeer het zo opnieuw.',
  serp_empty: 'Controleer de spelling van het zoekwoord, of kies een zoekwoord met meer zoekvolume.',
  too_few_competitors: 'De meeste topresultaten blokkeren bots of zijn geen artikelpagina. Kies een ander zoekwoord of probeer het later opnieuw.',
  truncated: 'Het antwoord werd te lang. Probeer het opnieuw; blijft dit gebeuren, meld het dan.',
  timeout: 'De server reageerde te traag. Probeer het zo opnieuw, of kies een snellere pagina.',
  not_html: 'Geef een gewone webpagina op, geen PDF of afbeelding.',
  empty_page: 'Deze pagina bouwt zijn tekst waarschijnlijk met JavaScript op, of er staat een cookiemuur voor.',
  rate_limited: 'Er zijn veel analyses achter elkaar gedraaid. Wacht een paar minuten.',
  no_api_key: 'Zet ANTHROPIC_API_KEY in Vercel onder Settings → Environment Variables.',
  gsc_empty: 'Kies een bestand of plak de tabel uit Search Console.',
  gsc_too_large: 'Exporteer alleen het tabblad Zoekopdrachten van één pagina.',
  gsc_no_queries: 'Controleer of de eerste rij koppen bevat zoals "Meest gebruikte zoekopdrachten", "Klikken" en "Vertoningen".',
  gsc_bad_json: 'Het JSON-bestand is niet geldig. Exporteer als CSV of plak de tabel.',
  offline: 'Controleer je internetverbinding.',
  stream_cut: 'Een analyse mag maximaal vijf minuten duren. Probeer het opnieuw, of kies een snellere pagina.',
};

function errorBox(error) {
  const box = el('div', 'notice notice-error');
  box.setAttribute('role', 'alert');
  box.append(el('p', 'notice-title', error.message || error.error || 'Onbekende fout.'));
  const hint = ERROR_HINTS[error.code];
  if (hint) box.append(el('p', 'mt-1 text-sm leading-6 text-pm-muted', hint));
  return box;
}

function renderError(error) {
  output.className = '';
  delete output.dataset.stage;
  clearPrintContext();
  const box = errorBox(error);
  box.classList.add('mx-auto', 'max-w-2xl');

  // Mislukt een analyse terwijl er al een rapport was (bijvoorbeeld de heranalyse
  // na een herfocus), dan ben je dat rapport niet kwijt.
  const previous = lastReport;
  if (previous) {
    const back = el('button', 'btn btn-outline btn-sm mt-3');
    back.type = 'button';
    back.textContent = 'terug naar het vorige resultaat';
    back.addEventListener('click', () => {
      renderReport(previous);
      setStatus('saved', 'vorige analyse');
    });
    box.append(back);
  }
  output.replaceChildren(box);

  actions.replaceChildren();
  progressBar.classList.add('hidden');
  setStatus('error', 'mislukt');
  setSteps([
    { state: 'todo', text: 'intent check' },
    { state: 'todo', text: 'focus zoekwoord' },
    { state: 'todo', text: 'aanbevelingen' },
  ]);
}

function isDesktop() {
  return window.matchMedia('(min-width: 1024px)').matches;
}

// --- UI-helpers ----------------------------------------------------------------

function setLoading(loading, label = 'bezig met analyseren') {
  isLoading = loading;
  submitBtn.disabled = loading;
  resetBtn.disabled = loading;
  submitSpinner.classList.toggle('hidden', !loading);
  submitArrow.classList.toggle('hidden', loading);
  output.querySelectorAll('[data-busy-disable]').forEach((button) => { button.disabled = loading; });

  clearInterval(timer);
  if (!loading) {
    submitLabel.textContent = 'analyseer pagina';
    progressBar.classList.add('hidden');
    return;
  }

  // Eerlijke voortgang: we weten niet hoe ver de server is, dus tonen we de
  // verstreken tijd naast een onbepaalde balk in plaats van een nepbalkje.
  progressBar.classList.remove('hidden');
  progressBar.setAttribute('data-indeterminate', '');
  const startedAt = Date.now();
  const tick = () => {
    const elapsed = formatDuration(Date.now() - startedAt);
    submitLabel.textContent = `${label}… ${elapsed}`;
    setStatus('busy', elapsed);
  };
  tick();
  timer = setInterval(tick, 1000);
}

const STATUS_TONES = {
  busy: 'bg-pm-tint text-pm-blue',
  done: 'bg-[#e3f4ee] text-[#00704f]',
  warn: 'bg-[#fdf2de] text-[#8f5600]',
  error: 'bg-[#fbe8ee] text-[#9e1744]',
  saved: 'bg-[#eef2f5] text-pm-muted',
};

function setStatus(kind, text) {
  // De verstreken tijd verandert elke seconde; die voorlezen maakt een screenreader onbruikbaar.
  statusBadge.setAttribute('aria-live', kind === 'busy' ? 'off' : 'polite');
  statusBadge.className = `px-2 py-0.5 text-xs font-semibold tabular-nums ${STATUS_TONES[kind] || ''}`;
  statusBadge.classList.toggle('hidden', !kind);
  statusBadge.textContent = text || '';
}

const STEP_STATE_TEXT = { todo: ', nog niet gestart', active: ', huidige stap', done: ', afgerond' };

/** De status zit ook in verborgen tekst: kleur en vinkje alleen bereiken een screenreader niet. */
function setSteps(steps) {
  stepItems.forEach((item, index) => {
    const step = steps[index];
    if (!step) return;
    item.dataset.state = step.state;
    item.querySelector('.step-text').textContent = step.text;
    item.querySelector('.step-state').textContent = STEP_STATE_TEXT[step.state] || '';
    if (step.state === 'active') item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Vinkje per ingevuld veld, plus een hint of de URL herkend wordt. */
function updateFieldState() {
  FIELDS.forEach((field) => {
    field.closest('.field').classList.toggle('is-filled', field.value.trim().length > 0);
  });

  const value = urlField.value.trim();
  const valid = !value || URL_PATTERN.test(value);
  urlField.setAttribute('aria-invalid', String(!valid));
  if (!value) setUrlHint(URL_HINT, 'field-hint');
  else if (valid) setUrlHint('URL herkend: de tool haalt deze pagina zelf op.', 'field-hint is-ok');
  else setUrlHint('Dit lijkt geen geldige URL.', 'field-hint is-error');
}

/** Alleen bij een echte wissel: de hint is aria-live, en elke toetsaanslag voorlezen stoort. */
function setUrlHint(text, className) {
  if (urlHint.textContent !== text) urlHint.textContent = text;
  if (urlHint.className !== className) urlHint.className = className;
}

form.addEventListener('input', () => {
  updateFieldState();
  storageSet(STORAGE.draft, JSON.stringify(FIELDS.map((field) => field.value)));
  setSelectedRegion(selectedRegion().id);
});

resetBtn.addEventListener('click', (event) => {
  if (lastReport && !confirm('Invoer én resultaat wissen?')) {
    event.preventDefault();
    return;
  }
  lastReport = null;
  lastRefocus = null;
  storageRemove(STORAGE.draft);
  storageRemove(STORAGE.report);
  storageRemove(STORAGE.refocus);
  storageRemove(STORAGE.gsc);
  lastGscText = '';
  showEmpty();
  // Het native reset-event leegt de velden pas na deze handler; daarna ook de regio gelijktrekken.
  setTimeout(() => {
    updateFieldState();
    setSelectedRegion(selectedRegion().id);
  });
});

// --- Wachtwoord (alleen als APP_PASSWORD op de server staat) ---------------------

/**
 * @param retry  wat er na het wachtwoord opnieuw moet: de onderbroken analyse of
 *               herfocus, niet zomaar het formulier (dat zou ronde 0 herstarten).
 */
function askForPassword(message, retry) {
  retryAfterPassword = retry || (() => form.requestSubmit());
  passwordError.textContent = message || '';
  passwordError.classList.toggle('hidden', !message);
  passwordOverlay.classList.remove('hidden');
  passwordOverlay.classList.add('flex');
  // De rest van de pagina is onbereikbaar zolang het wachtwoordscherm openstaat.
  document.querySelectorAll('body > header, body > main').forEach((node) => node.setAttribute('inert', ''));
  passwordInput.focus();
}

passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  appPassword = passwordInput.value;
  storageSet(STORAGE.password, appPassword);
  passwordOverlay.classList.add('hidden');
  passwordOverlay.classList.remove('flex');
  document.querySelectorAll('body > header, body > main').forEach((node) => node.removeAttribute('inert'));
  passwordInput.value = '';
  const retry = retryAfterPassword || (() => form.requestSubmit());
  retryAfterPassword = null;
  retry();
});

// --- Opslag ---------------------------------------------------------------------
// Invoer, laatste rapport en laatste herfocus overleven een refresh: een analyse
// kost een minuut en geld.

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* opslag vol of geblokkeerd */ }
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* geblokkeerd */ }
}

(function restore() {
  try {
    const draft = JSON.parse(storageGet(STORAGE.draft) || '[]');
    FIELDS.forEach((field, i) => { if (typeof draft[i] === 'string') field.value = draft[i]; });
  } catch { /* ongeldige opslag negeren */ }
  setSelectedRegion(storageGet(STORAGE.region) || 'nl');
  updateFieldState();

  try {
    const savedRefocus = JSON.parse(storageGet(STORAGE.refocus) || 'null');
    if (savedRefocus?.rejectedKeyword) lastRefocus = savedRefocus;
  } catch { /* ongeldige opslag negeren */ }

  try {
    const saved = JSON.parse(storageGet(STORAGE.report) || 'null');
    if (saved?.stage && saved?.intent) {
      lastReport = saved;
      renderReport(saved);
      setStatus('saved', 'vorige analyse');
    }
  } catch { /* ongeldige opslag negeren */ }
})();
