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
const stepButtons = [...document.querySelectorAll('#steps .step')];

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
};

/** Zelfde herkenning als in lib/page.js, zodat de hint klopt met wat de server doet. */
const URL_PATTERN = /^(https?:\/\/\S+|([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?)$/i;

const MAX_GSC_BYTES = 1_000_000;

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

let lastReport = null;
let lastRefocus = null;
let appPassword = storageGet(STORAGE.password) || '';
let isLoading = false;
let timer = null;

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

/** Inklapbaar blok voor alles wat al goed staat: informatief, maar niet het hoofdverhaal. */
function details(summaryText, children) {
  const wrapper = el('details', 'border-t border-pm-line pt-3');
  const summary = el('summary', 'cursor-pointer text-sm font-semibold text-pm-blue hover:underline', summaryText);
  wrapper.append(summary);
  const body = el('div', 'pt-3');
  children.forEach((child) => body.append(child));
  wrapper.append(body);
  return wrapper;
}

function metaRow(list, label, value) {
  const row = el('div', 'min-w-0');
  row.append(el('dt', 'text-xs font-bold uppercase tracking-wide text-pm-muted', label));
  row.append(el('dd', 'text-sm break-anywhere', value));
  list.append(row);
}

function sectionLabel(text) {
  return el('p', 'text-xs font-bold uppercase tracking-wide text-pm-muted', text);
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

function positionPills(positions) {
  const wrap = el('span', 'inline-flex flex-wrap gap-1 align-middle');
  (positions || []).forEach((position) => wrap.append(el('span', 'pill pill-info', `#${position}`)));
  return wrap;
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

async function postJson(path, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (appPassword) headers['X-App-Password'] = appPassword;

  let response;
  try {
    response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(data) });
  } catch {
    throw Object.assign(new Error('Geen verbinding met de server. Controleer je internetverbinding.'), { code: 'offline' });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error(`De server gaf een onverwacht antwoord (HTTP ${response.status}).`), { code: 'bad_response' });
  }

  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `Aanvraag mislukt (HTTP ${response.status}).`), {
      code: payload.code || 'analysis_failed',
    });
  }
  return payload;
}

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
  runAnalysis({ url, keyword, origin: { source: 'handmatig', round: 0 } });
});

/** Stap 1 en 2 (en bij een match 3A): één aanroep van /api/analyze. */
async function runAnalysis({ url, keyword, origin }) {
  if (isLoading) return;

  urlField.value = url;
  keywordField.value = keyword;
  updateFieldState();
  storageSet(STORAGE.draft, JSON.stringify(FIELDS.map((field) => field.value)));

  setLoading(true, origin.round > 0 ? `analyse met "${keyword}"` : 'bezig met analyseren');
  setSteps([
    { state: 'active', text: origin.round > 0 ? 'intent check (nieuw zoekwoord)' : 'intent check' },
    { state: origin.round > 0 ? 'done' : 'todo', text: 'focus zoekwoord' },
    { state: 'todo', text: 'aanbevelingen' },
  ]);
  showSkeleton();
  resultScroll.scrollTop = 0;
  if (!isDesktop()) resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const report = await postJson('/api/analyze', { url, keyword, origin });
    lastReport = report;
    storageSet(STORAGE.report, JSON.stringify(report));
    renderReport(report);
    if (report.stage === 'compleet') setStatus('done', 'Klaar');
    else setStatus('warn', 'Geen match');
  } catch (error) {
    if (error.code === 'auth_required') {
      askForPassword(error.message);
      showEmpty();
    } else {
      renderError(error);
    }
  } finally {
    setLoading(false);
  }
}

/** Stap 3B: een beter zoekwoord zoeken bij de pagina, daarna automatisch opnieuw analyseren. */
async function runRefocus({ source, gscText }) {
  const report = lastReport;
  if (!report || report.stage !== 'intent' || isLoading) return;

  setLoading(true, 'beter zoekwoord zoeken');
  setSteps([
    { state: 'done', text: 'intent check: geen match' },
    { state: 'active', text: 'focus zoekwoord zoeken' },
    { state: 'todo', text: 'aanbevelingen' },
  ]);
  renderReport(report, { refocusBusy: true });

  let result;
  try {
    result = await postJson('/api/refocus', {
      url: report.page.url,
      keyword: report.keyword,
      intent: report.intent,
      source,
      gsc: gscText || '',
      round: report.origin.round,
    });
  } catch (error) {
    setLoading(false);
    if (error.code === 'auth_required') {
      askForPassword(error.message);
      renderReport(report);
      return;
    }
    renderReport(report, { refocusError: error });
    return;
  }
  setLoading(false);

  lastRefocus = result;
  storageSet(STORAGE.refocus, JSON.stringify(result));
  renderReport(report);

  if (result.choice) {
    await runAnalysis({
      url: report.page.url,
      keyword: result.choice.keyword,
      origin: {
        source: result.choice.source,
        previousKeyword: report.keyword,
        round: report.origin.round + 1,
        why: result.choice.why,
      },
    });
  }
}

/** Knop waarmee de marketeer zelf een alternatief kiest. */
function analyseWithButton(keyword, source, why, report) {
  const button = el('button', 'btn btn-outline btn-xs');
  button.type = 'button';
  button.textContent = `analyseer met "${keyword}"`;
  button.addEventListener('click', () => {
    runAnalysis({
      url: report.page.url,
      keyword,
      origin: { source, previousKeyword: lastRefocus?.rejectedKeyword || report.keyword, round: report.origin.round + 1, why: why || '' },
    });
  });
  return button;
}

// --- Het rapport renderen ---------------------------------------------------------

function renderReport(report, options = {}) {
  const cards = report.stage === 'compleet'
    ? [
        intentCard(report),
        focusCard(report),
        placementCard(report),
        mappingCard(report),
        dekkingCard(report),
        koppenCard(report),
        termenCard(report),
        vragenCard(report),
        summaryCard(report),
        serpCard(report),
      ]
    : [intentCard(report), refocusCard(report, options), serpCard(report)];

  output.replaceChildren(...cards);
  output.className = 'space-y-4';
  actions.replaceChildren(copyButton(() => toMarkdown(report), 'kopieer rapport', 'btn btn-outline btn-sm relative'));
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

/** 1. Intent check: het oordeel, de argumenten en daaronder wat er gemeten is. */
function intentCard(report) {
  const { intent, measured, keywordInfo, serp } = report;
  const { wrapper } = card('Intent check', `Focus zoekwoord: ${report.keyword} · ${serp.provider}`);
  const body = el('div', 'p-5 space-y-4');

  const verdict = el('div', `verdict ${intent.match ? 'verdict-yes' : 'verdict-no'}`);
  const line = el('div', 'flex flex-wrap items-center gap-2');
  line.append(el('span', 'text-base font-bold', intent.match ? 'De pagina past bij dit zoekwoord.' : 'De pagina past niet bij dit zoekwoord.'));
  line.append(el('span', 'pill', `zekerheid: ${intent.confidence}`));
  if (intent.mismatch) line.append(el('span', 'pill pill-bad', intent.mismatch.label));
  verdict.append(line);
  if (intent.mismatch?.explanation) verdict.append(el('p', 'mt-2 text-sm leading-6', intent.mismatch.explanation));
  if (intent.mismatch?.direction) {
    const direction = el('p', 'mt-1 text-sm leading-6');
    direction.append(el('strong', null, 'Richting voor een beter zoekwoord: '), document.createTextNode(intent.mismatch.direction));
    verdict.append(direction);
  }
  body.append(verdict);

  const grid = el('div', 'grid gap-3 sm:grid-cols-2');
  grid.append(
    sideBox('Jouw pagina', intent.page.pageType, intent.page.intentType, intent.page.summary, []),
    sideBox('De top 10', intent.serp.dominantPageType, intent.serp.intentType, intent.serp.summary, intent.serp.positions)
  );
  body.append(grid);

  if (intent.reasons.length) {
    const block = el('div', 'space-y-2');
    block.append(sectionLabel('Argumenten (interpretatie van Claude, posities gecontroleerd)'));
    const list = el('ul', 'space-y-1.5');
    intent.reasons.forEach((reason) => {
      const item = el('li', 'flex gap-2 text-sm leading-6');
      item.append(el('span', 'font-bold text-pm-cyan', '•'));
      const text = el('span', 'min-w-0');
      text.append(document.createTextNode(`${reason.text} `), positionPills(reason.positions));
      item.append(text);
      list.append(item);
    });
    block.append(list);
    body.append(block);
  }

  const measuredBox = el('div', 'border-t border-pm-line pt-4 space-y-3');
  measuredBox.append(sectionLabel('Gemeten'));

  if (measured.pageTypes.length) {
    const list = el('div', 'space-y-2');
    measured.pageTypes.forEach((type) => {
      const row = el('div');
      const head = el('div', 'flex items-baseline justify-between gap-3 text-sm');
      head.append(
        el('span', 'font-semibold', type.label),
        el('span', 'text-xs text-pm-muted tabular-nums', `${type.count}/${measured.total} · posities ${type.positions.join(', ')}`)
      );
      row.append(head);
      const bar = el('div', 'score-bar mt-1');
      const fill = el('span');
      fill.style.width = `${Math.round((type.count / Math.max(measured.total, 1)) * 100)}%`;
      bar.append(fill);
      row.append(bar);
      list.append(row);
    });
    measuredBox.append(el('p', 'text-sm font-semibold', 'Paginatypes in de top 10 (Ahrefs)'), list);
  } else {
    measuredBox.append(el('p', 'text-sm text-pm-muted', 'Paginatypes zijn bij deze SERP-bron niet beschikbaar.'));
  }

  const facts = el('dl', 'grid gap-x-6 gap-y-2 sm:grid-cols-2 text-sm');
  if (keywordInfo) {
    metaRow(facts, 'Zoekvolume (Ahrefs)', `${fmt(keywordInfo.volume)} per maand`);
    metaRow(facts, 'Moeilijkheid (KD)', fmt(keywordInfo.difficulty));
    metaRow(
      facts,
      'Parent topic',
      keywordInfo.parentTopic ? `${keywordInfo.parentTopic} (${fmt(keywordInfo.parentVolume)} per maand)` : '—'
    );
    metaRow(facts, 'Intentievlaggen (Ahrefs)', intentFlags(keywordInfo.intents));
  } else {
    metaRow(
      facts,
      'Zoekvolume (Ahrefs)',
      report.keywordInfoError ? `niet opgehaald: ${report.keywordInfoError}` : 'Ahrefs kent dit zoekwoord niet'
    );
  }
  metaRow(facts, 'Jouw pagina in de top 10', measured.ownPosition ? `ja, positie ${measured.ownPosition}` : 'nee');
  if (measured.topKeywords.length) {
    metaRow(
      facts,
      'Topzoekwoorden concurrenten',
      measured.topKeywords.slice(0, 4).map((entry) => `${entry.keyword} (${entry.count}×)`).join(', ')
    );
  }
  if (measured.features.length) {
    metaRow(facts, 'SERP-features', measured.features.map((feature) => `${featureLabel(feature.type)} ${feature.count}×`).join(', '));
  }
  measuredBox.append(facts);
  body.append(measuredBox);

  wrapper.append(body);
  return wrapper;
}

function sideBox(title, pageType, intentType, summary, positions) {
  const box = el('div', 'side-box space-y-2');
  box.append(sectionLabel(title));
  const pills = el('div', 'flex flex-wrap gap-1.5');
  if (pageType) pills.append(el('span', 'pill pill-info', pageType));
  if (intentType) pills.append(el('span', 'pill', intentType));
  box.append(pills);
  box.append(el('p', 'text-sm leading-6', summary || '—'));
  if (positions && positions.length) {
    const line = el('p', 'text-xs text-pm-muted');
    line.append(document.createTextNode('Dominante groep: '), positionPills(positions));
    box.append(line);
  }
  return box;
}

/** 2 (geen match). Een beter zoekwoord zoeken: het formulier, de bezig-staat of het resultaat. */
function refocusCard(report, options = {}) {
  const roundLabel = `Ronde ${report.origin.round + 1} van ${report.maxRounds}`;
  const { wrapper } = card('Beter zoekwoord zoeken', roundLabel);
  const body = el('div', 'p-5 space-y-4');

  if (report.origin.previousKeyword) {
    body.append(
      emptyNote(`Ook "${report.keyword}" past niet bij de pagina (gekozen na "${report.origin.previousKeyword}").`)
    );
  }

  const result = lastRefocus && lastRefocus.rejectedKeyword === report.keyword ? lastRefocus : null;

  if (options.refocusBusy) {
    body.append(el('p', 'notice text-sm', 'Bezig met zoeken naar een passend zoekwoord. Dit duurt ongeveer een halve minuut.'));
    body.append(el('div', 'shimmer h-4 w-2/3'), el('div', 'shimmer h-4 w-1/2'));
  } else if (result) {
    body.append(refocusResult(result, report));
  } else if (report.nextStep === 'refocus') {
    if (options.refocusError) body.append(errorBox(options.refocusError));
    body.append(refocusForm(report));
  } else {
    body.append(
      el(
        'p',
        'notice notice-warn text-sm leading-6',
        `Na ${report.maxRounds} rondes is er nog geen zoekwoord gevonden dat bij de pagina past. Kies zelf een alternatief hieronder, vul een ander zoekwoord in, of pas de pagina aan zodat hij bij het zoekwoord past.`
      )
    );
  }

  const earlier = previousRoundOptions(report);
  if (earlier.length && !options.refocusBusy && !result) {
    const block = el('div', 'space-y-2 border-t border-pm-line pt-4');
    block.append(sectionLabel('Alternatieven uit de vorige ronde'));
    const list = el('div', 'flex flex-wrap gap-2');
    earlier.forEach((item) => list.append(analyseWithButton(item.keyword, item.source, item.why, report)));
    block.append(list);
    body.append(block);
  }

  wrapper.append(body);
  return wrapper;
}

/** Alternatieven en voorstellen uit een eerdere herfocus, zonder het zoekwoord dat nu net faalde. */
function previousRoundOptions(report) {
  if (!lastRefocus || lastRefocus.rejectedKeyword === report.keyword) return [];
  const current = report.keyword.toLowerCase();
  const listSource = lastRefocus.source === 'ahrefs' ? 'ahrefs' : 'gsc';
  const options = [
    ...(lastRefocus.alternatives || []).map((item) => ({ ...item, source: listSource })),
    ...(lastRefocus.proposals || []).filter((item) => item.verified).map((item) => ({ ...item, source: 'ai' })),
  ];
  return options.filter((item) => item.keyword.toLowerCase() !== current);
}

function refocusForm(report) {
  const box = el('div', 'space-y-4');
  box.append(
    el(
      'p',
      'text-sm leading-6',
      'Exporteer in Search Console het prestatierapport van deze pagina (Prestaties, filter op de exacte URL, Exporteren). Laad het bestand met zoekopdrachten hier in, of plak de tabel. De tool zoekt daarin een zoekwoord dat wél bij de pagina past.'
    )
  );

  let gscText = '';

  const drop = el('label', 'dropzone');
  const input = el('input', 'sr-only');
  input.type = 'file';
  input.accept = '.csv,.tsv,.txt,.json';
  const dropText = el('span', 'block text-sm font-semibold', 'kies een bestand of sleep het hierheen');
  const dropHint = el('span', 'mt-1 block text-xs text-pm-muted', 'CSV, TSV of JSON uit Search Console, maximaal 1 MB');
  drop.append(input, dropText, dropHint);

  const textarea = el('textarea', 'input min-h-[7rem] text-xs');
  textarea.placeholder = 'Of plak hier de tabel uit Search Console (zoekopdracht, klikken, vertoningen, CTR, positie)';
  textarea.setAttribute('aria-label', 'Search Console-export plakken');

  const error = el('p', 'hidden text-sm font-semibold text-pm-magenta');

  const submit = el('button', 'btn btn-primary btn-sm');
  submit.type = 'button';
  submit.textContent = 'zoek beter zoekwoord in search console';

  const viaAhrefs = el('button', 'btn btn-outline btn-sm');
  viaAhrefs.type = 'button';
  viaAhrefs.textContent = 'geen export? schat via ahrefs';

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
  update();

  const buttons = el('div', 'flex flex-wrap items-center gap-2');
  buttons.append(submit, viaAhrefs);

  box.append(
    drop,
    textarea,
    error,
    buttons,
    el(
      'p',
      'text-xs leading-5 text-pm-muted',
      'De Ahrefs-optie gebruikt de zoekwoorden waarop Ahrefs deze URL ziet ranken. Dat is een schatting uit de index van Ahrefs, geen meting van Google; klikken en vertoningen ontbreken dan.'
    )
  );
  return box;
}

function refocusResult(result, report) {
  const box = el('div', 'space-y-4');
  const listSource = result.source === 'ahrefs' ? 'ahrefs' : 'gsc';

  box.append(el('p', 'notice text-xs leading-5 text-pm-muted', result.note));
  if (result.pageSummary) {
    const summary = el('p', 'text-sm leading-6');
    summary.append(el('strong', null, 'Wat de pagina is: '), document.createTextNode(result.pageSummary));
    box.append(summary);
  }

  if (result.choice) {
    const choice = el('div', 'verdict verdict-yes space-y-2');
    choice.append(sectionLabel('Nieuw focus zoekwoord'));
    choice.append(el('p', 'keyword-hero', result.choice.keyword));
    const pills = el('div', 'flex flex-wrap gap-1.5');
    pills.append(el('span', 'pill pill-good', SOURCE_LABELS[result.choice.source] || result.choice.source));
    if (typeof result.choice.volume === 'number') pills.append(el('span', 'pill', `${fmt(result.choice.volume)} zoekopdrachten per maand`));
    if (result.choice.row?.impressions != null) pills.append(el('span', 'pill', `${fmt(result.choice.row.impressions)} vertoningen`));
    if (result.choice.row?.position != null) pills.append(el('span', 'pill', `positie ${String(result.choice.row.position).replace('.', ',')}`));
    choice.append(pills);
    if (result.choice.why) choice.append(el('p', 'text-sm leading-6', result.choice.why));
    const next = el('p', 'text-xs text-pm-muted');
    next.append(document.createTextNode('De analyse met dit zoekwoord start automatisch. Niet gestart? '));
    next.append(analyseWithButton(result.choice.keyword, result.choice.source, result.choice.why, report));
    choice.append(next);
    box.append(choice);
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

  if (result.rejected) box.append(el('p', 'text-sm leading-6 text-pm-muted', result.rejected));

  if (result.alternatives.length) {
    box.append(candidateList('Alternatieven uit de lijst', result.alternatives, listSource, report));
  }
  if (result.proposals.length) {
    box.append(candidateList('Voorstellen van Claude (zoekvolume gecheckt bij Ahrefs)', result.proposals, 'ai', report));
  }

  if (result.rows.length) {
    const table = el('table', 'data-table');
    const head = el('thead');
    const headRow = el('tr');
    ['Zoekwoord', 'Klikken', 'Vertoningen', 'Positie', 'Volume'].forEach((label) => headRow.append(el('th', null, label)));
    head.append(headRow);
    const rows = el('tbody');
    result.rows.forEach((row) => {
      const tr = el('tr');
      tr.append(
        el('td', 'break-anywhere', row.query),
        el('td', 'tabular-nums', fmt(row.clicks)),
        el('td', 'tabular-nums', fmt(row.impressions)),
        el('td', 'tabular-nums', row.position != null ? String(row.position).replace('.', ',') : '—'),
        el('td', 'tabular-nums', fmt(row.volume))
      );
      rows.append(tr);
    });
    table.append(head, rows);
    const wrap = el('div', 'table-wrap');
    wrap.append(table);
    box.append(details(`Bekijk de ${result.rowCount} zoekwoorden uit de lijst (top ${result.rows.length})`, [wrap]));
  }

  const again = el('button', 'btn btn-quiet btn-xs');
  again.type = 'button';
  again.textContent = 'opnieuw met een andere export';
  again.addEventListener('click', () => {
    lastRefocus = null;
    storageRemove(STORAGE.refocus);
    renderReport(report);
  });
  box.append(again);

  return box;
}

function candidateList(title, items, source, report) {
  const block = el('div', 'space-y-2');
  block.append(sectionLabel(title));
  const list = el('ul', 'space-y-2');
  items.forEach((item) => {
    const li = el('li', 'border border-pm-line p-3 space-y-1.5');
    const top = el('div', 'flex flex-wrap items-center justify-between gap-2');
    const left = el('div', 'flex flex-wrap items-center gap-1.5');
    left.append(el('span', 'text-sm font-bold', item.keyword));
    if (item.fit) left.append(el('span', `pill ${item.fit === 'goed' ? 'pill-good' : 'pill-mid'}`, `past ${item.fit}`));
    if (typeof item.volume === 'number') left.append(el('span', 'pill', `${fmt(item.volume)} per maand`));
    else if (source === 'ai') left.append(el('span', 'pill pill-bad', 'geen volume bekend'));
    if (item.row?.impressions != null) left.append(el('span', 'pill', `${fmt(item.row.impressions)} vertoningen`));
    if (item.row?.position != null) left.append(el('span', 'pill', `positie ${String(item.row.position).replace('.', ',')}`));
    top.append(left, analyseWithButton(item.keyword, source, item.why, report));
    li.append(top);
    if (item.why) li.append(el('p', 'text-xs leading-5 text-pm-muted', item.why));
    list.append(li);
  });
  block.append(list);
  return block;
}

/** 2 (match). Het focus zoekwoord: behouden of nieuw, met de alternatieven van de herfocus. */
function focusCard(report) {
  const { origin, keywordInfo } = report;
  const kept = origin.source === 'handmatig';
  const { wrapper } = card(
    'Focus zoekwoord',
    kept ? 'Behouden: het opgegeven zoekwoord past bij de pagina' : 'Nieuw: gekozen na een herfocus'
  );
  const body = el('div', 'p-5 space-y-3');

  body.append(el('p', 'keyword-hero', report.keyword));
  const pills = el('div', 'flex flex-wrap gap-1.5');
  pills.append(el('span', `pill ${kept ? 'pill-good' : 'pill-info'}`, kept ? 'behouden als primary' : `nieuw: ${SOURCE_LABELS[origin.source] || origin.source}`));
  if (keywordInfo) {
    pills.append(el('span', 'pill', `${fmt(keywordInfo.volume)} zoekopdrachten per maand`));
    pills.append(el('span', 'pill', `KD ${fmt(keywordInfo.difficulty)}`));
  }
  if (report.serp.targetPosition) pills.append(el('span', 'pill pill-good', `jouw pagina staat op #${report.serp.targetPosition}`));
  body.append(pills);

  if (!kept) {
    const replaced = el('p', 'text-sm leading-6');
    replaced.append(el('strong', null, 'Vervangt: '), document.createTextNode(origin.previousKeyword || '—'));
    body.append(replaced);
    if (origin.why) body.append(el('p', 'text-sm leading-6 text-pm-muted', origin.why));

    const refocus = lastRefocus && lastRefocus.choice && lastRefocus.choice.keyword.toLowerCase() === report.keyword.toLowerCase() ? lastRefocus : null;
    if (refocus) {
      const listSource = refocus.source === 'ahrefs' ? 'ahrefs' : 'gsc';
      const options = [
        ...(refocus.alternatives || []).map((item) => ({ ...item, source: listSource })),
        ...(refocus.proposals || []).filter((item) => item.verified).map((item) => ({ ...item, source: 'ai' })),
      ].filter((item) => item.keyword.toLowerCase() !== report.keyword.toLowerCase());
      if (options.length) {
        const block = el('div', 'space-y-2 border-t border-pm-line pt-3');
        block.append(sectionLabel('Liever een alternatief?'));
        const list = el('div', 'flex flex-wrap gap-2');
        options.forEach((item) => list.append(analyseWithButton(item.keyword, item.source, item.why, report)));
        block.append(list);
        body.append(block);
      }
    }
  }

  wrapper.append(body);
  return wrapper;
}

/** 3. Focus keyword optimalisatie: gemeten plekken, met een nieuwe versie waar het zoekwoord ontbreekt. */
function placementCard(report) {
  const { wrapper } = card('Focus keyword optimalisatie', 'Gemeten: staat het zoekwoord in H1, meta title, meta description en de eerste alinea?');
  const body = el('div', 'p-5 space-y-3');

  Object.entries(report.placement).forEach(([key, item]) => {
    const status = PLACEMENT_STATUS[item.status] || PLACEMENT_STATUS.ontbreekt;
    const row = el('div', 'border border-pm-line p-4 space-y-2');
    const top = el('div', 'flex flex-wrap items-center justify-between gap-2');
    const left = el('div', 'flex flex-wrap items-center gap-2');
    left.append(el('span', 'text-sm font-bold', PLACEMENT_LABELS[key]), el('span', `pill ${status.pill}`, status.text));
    top.append(left);
    if (item.rewrite) top.append(copyButton(() => item.rewrite));
    row.append(top);

    const current = el('p', 'text-xs leading-5 text-pm-muted break-anywhere');
    current.append(el('strong', null, 'Nu: '), document.createTextNode(item.text ? truncate(item.text, 240) : '(leeg)'));
    row.append(current);

    if (item.rewrite) {
      const rewrite = el('p', 'text-sm leading-6 break-anywhere');
      rewrite.append(el('strong', null, 'Nieuwe versie: '), document.createTextNode(item.rewrite));
      row.append(rewrite);
    }
    body.append(row);
  });

  body.append(
    el('p', 'text-xs leading-5 text-pm-muted', 'De rest van de pagina mag variëren tussen het focus zoekwoord, de secondary en de varianten; herhaal het exacte zoekwoord niet onnodig.')
  );
  wrapper.append(body);
  return wrapper;
}

/** 4. Keyword mapping: primary, secondary, supporting, varianten en merktermen, met zoekvolume. */
function mappingCard(report) {
  const { mapping, keywordInfo } = report;
  const { wrapper } = card('Aanbevolen keyword mapping', 'Gekozen uit zoekwoordideeën van Ahrefs en de topzoekwoorden van de concurrenten');
  const body = el('div', 'p-5 space-y-3');

  const groups = [
    ['Primary', [{ keyword: mapping.primary, volume: keywordInfo?.volume ?? null, why: '' }], 'pill-good'],
    ['Secondary', mapping.secondary, 'pill-info'],
    ['Supporting', mapping.supporting, ''],
    ['Varianten', mapping.variants, ''],
    ['Merktermen', mapping.brand, ''],
  ];

  groups.forEach(([label, items, pillClass]) => {
    const row = el('div', 'grid gap-1 sm:grid-cols-[8rem_1fr] items-start');
    row.append(el('div', 'text-xs font-bold uppercase tracking-wide text-pm-muted pt-1', label));
    const list = el('div', 'flex flex-wrap gap-1.5');
    if (!items.length) {
      list.append(el('span', 'text-sm text-pm-muted', 'geen'));
    } else {
      items.forEach((item) => {
        const pill = el('span', `pill ${pillClass}`, typeof item.volume === 'number' ? `${item.keyword} (${fmt(item.volume)})` : item.keyword);
        if (item.why) pill.title = item.why;
        list.append(pill);
      });
    }
    row.append(list);
    body.append(row);
  });

  body.append(el('p', 'text-xs leading-5 text-pm-muted', 'Tussen haakjes het zoekvolume per maand volgens Ahrefs. Beweeg over een zoekwoord voor de reden.'));

  const head = wrapper.querySelector('.card-head');
  head.append(copyButton(() => mappingMarkdown(report), 'kopieer mapping'));
  wrapper.append(body);
  return wrapper;
}

function mappingMarkdown(report) {
  const { mapping } = report;
  const line = (items) => (items.length ? items.map((item) => (typeof item.volume === 'number' ? `${item.keyword} (${item.volume})` : item.keyword)).join(', ') : 'geen');
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

/** 5. Dekkingsgraad: de harde cijfers plus de kanttekening erbij. */
function dekkingCard(report) {
  const { coverage, page, serp } = report;
  const { wrapper } = card(
    'Dekkingsgraad',
    `Vergeleken met ${coverage.competitorsCompared} pagina's uit de Google-top 10`
  );
  const body = el('div', 'p-5 space-y-4');

  const tiles = el('div', 'grid gap-3 sm:grid-cols-3');
  tiles.append(
    scoreTile('Onderwerpdekking', coverage.score ?? '—', coverage.score === null ? '' : '%', coverage.score, scoreTone(coverage.score)),
    scoreTile(
      'Woorden',
      page.wordCount.toLocaleString('nl-NL'),
      coverage.benchmarkWordCount ? `mediaan ${coverage.benchmarkWordCount.toLocaleString('nl-NL')}` : '',
      coverage.wordCountRatio,
      scoreTone(coverage.wordCountRatio)
    ),
    scoreTile(
      'Semantische termen',
      `${coverage.termsPresent}/${coverage.termsTotal}`,
      'aanwezig',
      coverage.termsTotal ? Math.round((coverage.termsPresent / coverage.termsTotal) * 100) : 0,
      scoreTone(coverage.termsTotal ? (coverage.termsPresent / coverage.termsTotal) * 100 : 0)
    )
  );
  body.append(tiles);

  const split = el('div', 'flex flex-wrap gap-2');
  split.append(
    el(
      'span',
      `pill ${serp.targetPosition ? 'pill-good' : ''}`,
      serp.targetPosition ? `jouw pagina staat op #${serp.targetPosition}` : 'jouw pagina staat niet in de top 10'
    ),
    el('span', 'pill pill-good', `${coverage.topicsWithHeading} met eigen kop`),
    el('span', 'pill pill-mid', `${coverage.topicsInTextOnly} alleen in de tekst`),
    el('span', 'pill pill-bad', `${coverage.topicsMissing} ontbreekt`)
  );
  body.append(split);

  const meta = el('dl', 'grid gap-x-6 gap-y-2 sm:grid-cols-2 border-t border-pm-line pt-4 text-sm');
  metaRow(meta, 'Pagina', page.url);
  metaRow(meta, 'H1', page.h1 || '(geen H1 gevonden)');
  metaRow(meta, 'Titel', page.title || '(geen titel)');
  metaRow(
    meta,
    'Woorden top 10',
    coverage.wordCountRange
      ? `${coverage.wordCountRange[0].toLocaleString('nl-NL')} – ${coverage.wordCountRange[1].toLocaleString('nl-NL')}`
      : '—'
  );
  body.append(meta);

  body.append(el('p', 'text-xs leading-5 text-pm-muted border-t border-pm-line pt-3', report.disclaimer));

  wrapper.append(body);
  return wrapper;
}

function scoreTile(label, value, suffix, barPercentage, tone) {
  const tile = el('div', 'score-tile');
  tile.style.borderLeftColor = tone.solid;
  tile.append(el('div', 'score-label', label));

  const valueRow = el('div', 'score-value', value);
  if (suffix) valueRow.append(el('small', null, ` ${suffix}`));
  tile.append(valueRow);

  const bar = el('div', 'score-bar');
  const fill = el('span');
  fill.style.width = `${Math.min(Math.max(barPercentage || 0, 0), 100)}%`;
  fill.style.background = tone.solid;
  bar.append(fill);
  tile.append(bar);
  return tile;
}

const TONES = {
  good: { solid: '#009670', pill: 'pill-good' },
  mid: { solid: '#e0951f', pill: 'pill-mid' },
  bad: { solid: '#b61b50', pill: 'pill-bad' },
};

function scoreTone(percentage) {
  if (percentage === null || percentage === undefined) return TONES.mid;
  if (percentage >= 75) return TONES.good;
  if (percentage >= 45) return TONES.mid;
  return TONES.bad;
}

/** 6. Ontbrekende koppen, gesorteerd op hoeveel concurrenten het onderwerp behandelen. */
function koppenCard(report) {
  const { wrapper } = card(
    'Aanbevelingen voor de pagina',
    'Onderwerpen die minstens twee concurrenten behandelen, met hun letterlijke koppen als SERP-bewijs'
  );
  const body = el('div', 'p-5 space-y-3');

  if (report.missingTopics.length === 0) {
    body.append(emptyNote('Geen ontbrekende onderwerpen gevonden. De pagina dekt alles wat meerdere concurrenten behandelen.'));
  } else {
    report.missingTopics.forEach((topic) => body.append(topicRow(topic, report)));
  }

  if (report.partialTopics.length) {
    body.append(
      details(
        `${report.partialTopics.length} onderwerpen staan wel in de tekst, maar zonder eigen kop`,
        report.partialTopics.map((topic) => topicRow(topic, report, true))
      )
    );
  }

  if (report.coveredTopics.length) {
    const list = el('ul', 'space-y-1.5 pt-1');
    report.coveredTopics.forEach((topic) => {
      const item = el('li', 'flex gap-2 text-sm');
      item.append(
        el('span', 'text-pm-green font-bold', '✓'),
        el('span', null, `${topic.heading} (${share(topic.coveredBy, report)})`)
      );
      list.append(item);
    });
    body.append(details(`${report.coveredTopics.length} onderwerpen heb je al goed staan`, [list]));
  }

  wrapper.append(body);
  return wrapper;
}

function topicRow(topic, report, inTextOnly = false) {
  const row = el('div', 'border border-pm-line p-4');

  const top = el('div', 'flex items-start justify-between gap-3');
  const left = el('div', 'min-w-0 space-y-1');
  const labels = el('div', 'flex flex-wrap items-center gap-2');
  labels.append(el('span', 'pill pill-info', topic.level));
  labels.append(el('span', 'pill', `${share(topic.coveredBy, report)} concurrenten`));
  if (inTextOnly) labels.append(el('span', 'pill pill-mid', 'staat er al, zonder kop'));
  left.append(labels);
  left.append(el('p', 'text-sm font-bold leading-snug break-anywhere', topic.heading));
  top.append(left);
  top.append(copyButton(() => topicMarkdown(topic)));
  row.append(top);

  row.append(el('p', 'mt-2 text-sm leading-6 text-pm-muted', topic.why));
  if (topic.advice) {
    const advice = el('p', 'mt-1 text-sm leading-6');
    advice.append(el('strong', null, 'Aanbeveling: '), document.createTextNode(topic.advice));
    row.append(advice);
  }

  if (topic.subheadings.length) {
    const subs = el('ul', 'mt-2 flex flex-wrap gap-1.5');
    topic.subheadings.forEach((sub) => subs.append(el('li', 'pill', `H3 · ${sub}`)));
    row.append(subs);
  }

  // De bewijslast: welke kop bij welke concurrent. Zo kan een SEO-specialist zelf
  // beoordelen of de groepering klopt.
  const sources = el('ul', 'mt-3 space-y-1 border-t border-dashed border-pm-line pt-2');
  topic.sources.forEach((source) => {
    const item = el('li', 'flex gap-2 text-xs leading-5');
    item.append(el('span', 'font-bold tabular-nums text-pm-blue', `#${source.position}`));
    const text = el('span', 'min-w-0 break-anywhere');
    text.append(el('span', 'text-pm-muted', `${source.domain}: `), el('span', null, `"${source.heading}"`));
    item.append(text);
    sources.append(item);
  });
  row.append(sources);

  return row;
}

function topicMarkdown(topic) {
  const lines = [`## ${topic.heading}`];
  if (topic.subheadings.length) lines.push('', ...topic.subheadings.map((sub) => `### ${sub}`));
  lines.push('', `> ${topic.why}`);
  if (topic.advice) lines.push('>', `> ${topic.advice}`);
  return lines.join('\n');
}

/** 7. Semantische termen: geteld bij de concurrenten, ontbrekend op de doelpagina. */
function termenCard(report) {
  const total = report.coverage.competitorsCompared;
  const { wrapper } = card(
    'Semantische termen',
    'Termen die meerdere concurrenten gebruiken en die niet op je pagina staan'
  );
  const body = el('div', 'p-5 space-y-3');

  if (report.missingTerms.length === 0) {
    body.append(emptyNote('Alle gevonden termen staan al op de pagina.'));
  } else {
    const groups = [
      { label: 'Bij de meeste concurrenten', tone: ' pill-bad', match: (term) => term.usedBy / total >= 0.5 },
      { label: 'Bij een deel van de concurrenten', tone: ' pill-mid', match: (term) => term.usedBy / total < 0.5 },
    ];

    groups.forEach(({ label, tone, match }) => {
      const group = report.missingTerms.filter(match);
      if (!group.length) return;

      const block = el('div');
      const heading = el('div', 'flex items-center justify-between gap-3 mb-2');
      heading.append(sectionLabel(label));
      heading.append(copyButton(() => group.map((term) => term.term).join('\n'), 'kopieer groep'));
      block.append(heading);

      const list = el('ul', 'space-y-1.5');
      group.forEach((term) => {
        const item = el('li', 'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm');
        item.append(el('span', `pill${tone}`, term.term));
        item.append(el('span', 'text-xs font-semibold tabular-nums', share(term.usedBy, report)));
        item.append(el('span', 'text-pm-muted text-xs leading-5', term.context));
        list.append(item);
      });
      block.append(list);
      body.append(block);
    });
  }

  if (report.presentTerms.length) {
    const list = el('ul', 'flex flex-wrap gap-1.5 pt-1');
    report.presentTerms.forEach((term) =>
      list.append(el('li', 'pill pill-good', `✓ ${term.term} (${share(term.usedBy, report)})`)));
    body.append(details(`${report.presentTerms.length} termen staan er al`, [list]));
  }

  wrapper.append(body);
  return wrapper;
}

function questionSource(item) {
  if (item.source === 'Mensen vragen ook') return 'Google: Mensen vragen ook';
  return `kop bij #${item.position} ${domainFromUrl(item.from)}`;
}

/** 8. Mensen vragen ook: uit Google zelf (via Ahrefs) en uit vraagkoppen van concurrenten. */
function vragenCard(report) {
  const fromGoogle = report.serp.peopleAlsoAsk > 0;
  const { wrapper } = card(
    fromGoogle ? 'Mensen vragen ook' : 'Vragen uit de top 10',
    fromGoogle ? 'Echte vragen uit Google en uit de koppen van concurrenten' : 'Vraagkoppen die concurrenten gebruiken'
  );
  const body = el('div', 'p-5 space-y-3');

  if (!fromGoogle) {
    body.append(
      el(
        'p',
        'notice text-xs leading-5 text-pm-muted',
        'Google toont voor dit zoekwoord geen "Mensen vragen ook"-blok. Deze vragen komen daarom alleen uit de koppen van concurrenten.'
      )
    );
  }

  const open = report.questions.filter((item) => item.status !== 'kop');
  const answered = report.questions.filter((item) => item.status === 'kop');

  if (report.questions.length === 0) {
    body.append(emptyNote('Er zijn geen vragen gevonden: geen "Mensen vragen ook"-blok en geen vraagkoppen bij concurrenten.'));
  } else if (open.length === 0) {
    body.append(emptyNote('De pagina beantwoordt alle gevonden vragen al met een eigen kop.'));
  }

  open.forEach((item) => {
    const row = el('div', 'border border-pm-line p-4');
    const top = el('div', 'flex items-start justify-between gap-3');
    const left = el('div', 'min-w-0 space-y-1');
    const labels = el('div', 'flex flex-wrap items-center gap-2');
    labels.append(
      el(
        'span',
        `pill ${item.status === 'tekst' ? 'pill-mid' : 'pill-bad'}`,
        item.status === 'tekst' ? 'staat er, maar niet als vraag' : 'ontbreekt'
      ),
      el('span', 'pill', questionSource(item))
    );
    left.append(labels);
    left.append(el('p', 'text-sm font-bold leading-snug break-anywhere', item.question));
    top.append(left);
    top.append(copyButton(() => `### ${item.question}\n\n${item.angle}`));
    row.append(top);
    if (item.angle) row.append(el('p', 'mt-2 text-sm leading-6 text-pm-muted', item.angle));
    body.append(row);
  });

  if (answered.length) {
    const list = el('ul', 'space-y-1.5 pt-1');
    answered.forEach((item) => {
      const li = el('li', 'flex gap-2 text-sm');
      li.append(
        el('span', 'text-pm-green font-bold', '✓'),
        el('span', null, `${item.question} (${questionSource(item)})`)
      );
      list.append(li);
    });
    body.append(details(`${answered.length} vragen beantwoordt de pagina al`, [list]));
  }

  wrapper.append(body);
  return wrapper;
}

/** 9. Samenvatting en "niet doen": de conclusie van Claude, met de concurrenten als bron. */
function summaryCard(report) {
  const { wrapper } = card('Samenvatting', 'Interpretatie van Claude op basis van de gemeten data hierboven');
  const body = el('div', 'p-5 space-y-4');

  body.append(el('p', 'text-sm leading-6', report.summary || 'Geen samenvatting beschikbaar.'));

  if (report.avoid.length) {
    const block = el('div', 'space-y-2 border-t border-pm-line pt-4');
    block.append(sectionLabel('Niet doen'));
    const list = el('ul', 'space-y-1.5');
    report.avoid.forEach((item) => {
      const li = el('li', 'flex gap-2 text-sm leading-6');
      li.append(el('span', 'font-bold text-pm-magenta', '✕'));
      const text = el('span', 'min-w-0');
      text.append(document.createTextNode(`${item.text} `));
      item.sources.forEach((source) => text.append(el('span', 'pill', `#${source.position} ${source.domain}`), ' '));
      li.append(text);
      list.append(li);
    });
    block.append(list);
    body.append(block);
  }

  wrapper.append(body);
  return wrapper;
}

/** 10. De bronnen: met welke pagina's is er precies vergeleken, en welke vielen af? */
const RESULT_STATUS = {
  vergeleken: 'pill-good',
  'jouw pagina': 'pill-info',
  'eigen domein': '',
  overgeslagen: '',
  mislukt: 'pill-bad',
};

function serpCard(report) {
  const { serp } = report;
  const { wrapper } = card(
    'De Google-top 10',
    `${serp.provider} · opgehaald ${new Date(report.generatedAt).toLocaleString('nl-NL')}`
  );

  const hasTypes = serp.results.some((result) => result.pageTypeLabel || result.topKeyword);
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'data-table');
  const head = el('thead');
  const headRow = el('tr');
  const columns = hasTypes
    ? ['#', 'Pagina', 'Paginatype', 'Topzoekwoord', 'Woorden', 'Status']
    : ['#', 'Pagina', 'Woorden', 'Koppen', 'Status'];
  columns.forEach((label) => headRow.append(el('th', null, label)));
  head.append(headRow);

  const bodyRows = el('tbody');
  serp.results.forEach((result) => {
    const row = el('tr');
    row.append(el('td', 'tabular-nums font-bold', result.position));

    const page = el('td', 'min-w-[14rem]');
    const link = el('a', 'font-semibold text-pm-blue hover:underline break-anywhere', result.title || result.domain);
    link.href = result.url;
    link.target = '_blank';
    link.rel = 'noopener';
    page.append(link, el('div', 'text-xs text-pm-muted break-anywhere', result.domain));
    row.append(page);

    if (hasTypes) {
      row.append(el('td', 'text-xs', result.pageTypeLabel || '—'));
      const top = el('td', 'text-xs break-anywhere');
      top.textContent = result.topKeyword ? `${result.topKeyword}${typeof result.topKeywordVolume === 'number' ? ` (${fmt(result.topKeywordVolume)})` : ''}` : '—';
      row.append(top);
      row.append(el('td', 'tabular-nums', result.wordCount != null ? result.wordCount.toLocaleString('nl-NL') : '—'));
    } else {
      row.append(el('td', 'tabular-nums', result.wordCount != null ? result.wordCount.toLocaleString('nl-NL') : '—'));
      row.append(el('td', 'tabular-nums', result.headingCount ?? '—'));
    }

    const status = el('td');
    status.append(el('span', `pill ${RESULT_STATUS[result.status] ?? ''}`, result.status));
    if (result.reason) status.append(el('div', 'mt-1 text-xs text-pm-muted', result.reason));
    row.append(status);

    bodyRows.append(row);
  });

  table.append(head, bodyRows);
  wrap.append(table);
  wrapper.append(wrap);
  return wrapper;
}

// --- Markdown-export -----------------------------------------------------------

function toMarkdown(report) {
  const { intent, measured, keywordInfo, page, serp, origin } = report;
  const lines = [
    `# Focus keyword check: ${page.url}`,
    '',
    `**Focus zoekwoord:** ${report.keyword}${origin.source !== 'handmatig' ? ` (${SOURCE_LABELS[origin.source] || origin.source}, vervangt "${origin.previousKeyword}")` : ''}`,
    `**Positie in Google:** ${serp.targetPosition ? `#${serp.targetPosition}` : 'niet in de top 10'}`,
    `**Geanalyseerd op:** ${new Date(report.generatedAt).toLocaleString('nl-NL')} (${serp.provider})`,
    '',
    `## Beoordeling focus keyword: ${report.keyword}`,
    '',
    `**${intent.match ? 'Geschikt als primary keyword.' : 'Niet geschikt als primary keyword.'}** Zekerheid: ${intent.confidence}.${intent.mismatch ? ` Soort mismatch: ${intent.mismatch.label}.` : ''}`,
    '',
    `- Jouw pagina: ${intent.page.pageType} (${intent.page.intentType}). ${intent.page.summary}`,
    `- De top 10: ${intent.serp.dominantPageType} (${intent.serp.intentType}). ${intent.serp.summary}${intent.serp.positions.length ? ` Dominante groep: ${intent.serp.positions.map((position) => `#${position}`).join(', ')}.` : ''}`,
    ...intent.reasons.map((reason) => `- ${reason.text}${reason.positions.length ? ` (${reason.positions.map((position) => `#${position}`).join(', ')})` : ''}`),
  ];

  if (intent.mismatch) {
    if (intent.mismatch.explanation) lines.push('', intent.mismatch.explanation);
    if (intent.mismatch.direction) lines.push('', `Richting voor een beter zoekwoord: ${intent.mismatch.direction}`);
  }

  lines.push('', '**Gemeten:**', '');
  if (measured.pageTypes.length) {
    lines.push(`- Paginatypes in de top 10: ${measured.pageTypes.map((type) => `${type.label} ${type.count}× (${type.positions.map((position) => `#${position}`).join(', ')})`).join('; ')}`);
  }
  if (keywordInfo) {
    lines.push(`- Zoekvolume: ${fmt(keywordInfo.volume)} per maand, moeilijkheid ${fmt(keywordInfo.difficulty)}${keywordInfo.parentTopic ? `, parent topic "${keywordInfo.parentTopic}" (${fmt(keywordInfo.parentVolume)})` : ''}`);
    lines.push(`- Intentievlaggen Ahrefs: ${intentFlags(keywordInfo.intents)}`);
  } else {
    lines.push(`- Zoekvolume: ${report.keywordInfoError ? `niet opgehaald (${report.keywordInfoError})` : 'Ahrefs kent dit zoekwoord niet'}`);
  }
  lines.push(`- Jouw pagina in de top 10: ${measured.ownPosition ? `ja, positie ${measured.ownPosition}` : 'nee'}`);
  if (measured.topKeywords.length) {
    lines.push(`- Topzoekwoorden van de concurrenten: ${measured.topKeywords.slice(0, 5).map((entry) => `${entry.keyword} (${entry.count}×)`).join(', ')}`);
  }

  if (report.stage !== 'compleet') {
    const refocus = lastRefocus && lastRefocus.rejectedKeyword === report.keyword ? lastRefocus : null;
    lines.push('', '## Volgende stap', '');
    if (refocus?.choice) {
      lines.push(`Nieuw focus zoekwoord: **${refocus.choice.keyword}** (${SOURCE_LABELS[refocus.choice.source] || refocus.choice.source}). ${refocus.choice.why}`);
    } else if (refocus) {
      lines.push(refocus.rejected || 'Er is in de lijst geen passend zoekwoord gevonden.');
      refocus.proposals.forEach((item) => lines.push(`- Voorstel: ${item.keyword}${typeof item.volume === 'number' ? ` (${fmt(item.volume)} per maand)` : ' (geen volume bekend)'} — ${item.why}`));
    } else {
      lines.push('Laad een Search Console-export van deze pagina in om een beter passend zoekwoord te vinden, of schat de rankende zoekwoorden via Ahrefs.');
    }
    lines.push('', '---', '', `Bron van de SERP: ${serp.provider}. Het oordeel over de zoekintentie is een interpretatie van Claude op basis van de gemeten data hierboven.`);
    return lines.join('\n');
  }

  if (origin.source !== 'handmatig') {
    lines.push(
      '',
      `## Focus keyword: ${report.keyword} (nieuw)`,
      '',
      `Vervangt "${origin.previousKeyword}". ${SOURCE_LABELS[origin.source] || origin.source}.${origin.why ? ` ${origin.why}` : ''}`
    );
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

  lines.push('## Aanbevelingen voor de pagina', '');
  const topicLines = (topic, index, gap) => {
    lines.push(`### ${index}. ${topic.heading} (${topic.level})`, '');
    lines.push(`SERP-evidence: ${topic.sources.map((source) => `#${source.position} ${source.domain}: "${source.heading}"`).join('; ')} (${share(topic.coveredBy, report)} concurrenten)`);
    lines.push(`Gap: ${gap}`);
    lines.push(`Aanbeveling: ${topic.advice || topic.why}`);
    if (topic.subheadings.length) lines.push(`H3-suggesties: ${topic.subheadings.join('; ')}`);
    lines.push('');
  };
  let counter = 1;
  if (report.missingTopics.length === 0 && report.partialTopics.length === 0) {
    lines.push('Geen ontbrekende onderwerpen gevonden.', '');
  }
  report.missingTopics.forEach((topic) => topicLines(topic, counter++, 'ontbreekt op de pagina'));
  report.partialTopics.forEach((topic) => topicLines(topic, counter++, 'staat in de tekst, maar zonder eigen kop'));
  if (report.coveredTopics.length) {
    lines.push(`Al goed behandeld: ${report.coveredTopics.map((topic) => topic.heading).join('; ')}.`, '');
  }

  lines.push('## Niet doen', '');
  if (report.avoid.length) {
    report.avoid.forEach((item) => lines.push(`- ${item.text} (${item.sources.map((source) => `#${source.position} ${source.domain}`).join(', ')})`));
  } else {
    lines.push('Geen specifieke valkuilen gezien bij de concurrenten.');
  }
  lines.push('');

  lines.push('## Ontbrekende semantische termen', '');
  if (report.missingTerms.length === 0) {
    lines.push('Geen.', '');
  } else {
    report.missingTerms.forEach((term) =>
      lines.push(`- **${term.term}** (${share(term.usedBy, report)} concurrenten) — ${term.context}`));
    lines.push('');
  }

  lines.push(report.serp.peopleAlsoAsk > 0 ? '## Mensen vragen ook' : '## Vragen uit de top 10 (vraagkoppen van concurrenten)', '');
  report.questions.forEach((item) => {
    const mark = item.status === 'kop' ? '✓ al beantwoord' : item.status === 'tekst' ? '~ staat in de tekst' : '✗ ontbreekt';
    lines.push(`- **${item.question}** (${mark}; ${questionSource(item)})${item.angle ? ` — ${item.angle}` : ''}`);
  });
  if (!report.questions.length) lines.push('Geen vragen gevonden.');

  const { coverage } = report;
  lines.push(
    '',
    '## Dekkingsgraad',
    '',
    `- Onderwerpdekking: **${coverage.score ?? '—'}%** (${coverage.topicsWithHeading} met eigen kop, ${coverage.topicsInTextOnly} alleen in de tekst, ${coverage.topicsMissing} ontbreekt)`,
    `- Woorden: **${page.wordCount}**${coverage.benchmarkWordCount ? `, mediaan top 10: ${coverage.benchmarkWordCount} (spreiding ${coverage.wordCountRange[0]}–${coverage.wordCountRange[1]})` : ''}`,
    `- Semantische termen aanwezig: **${coverage.termsPresent} van ${coverage.termsTotal}**`,
    '',
    '## Vergeleken met',
    '',
    ...serp.results.map((result) =>
      `${result.position}. ${result.url} — ${result.status}${result.pageTypeLabel ? `, ${result.pageTypeLabel}` : ''}${result.wordCount != null ? `, ${result.wordCount} woorden` : ''}${result.reason ? ` (${result.reason})` : ''}`),
    '',
    '## Samenvatting',
    '',
    report.summary || '—',
    '',
    '---',
    '',
    report.disclaimer
  );
  return lines.join('\n');
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// --- Staten --------------------------------------------------------------------

function showEmpty() {
  output.className = '';
  output.innerHTML = EMPTY_STATE;
  actions.replaceChildren();
  progressBar.classList.add('hidden');
  setStatus(null);
  setSteps([
    { state: 'todo', text: 'intent check' },
    { state: 'todo', text: 'focus zoekwoord' },
    { state: 'todo', text: 'aanbevelingen' },
  ]);
}

function showSkeleton() {
  output.className = '';
  output.replaceChildren(document.getElementById('loading-state').content.cloneNode(true));
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
  no_serp_key: 'Zet AHREFS_API_KEY in Vercel onder Settings → Environment Variables (of lokaal in .env.local).',
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
};

function errorBox(error) {
  const box = el('div', 'notice notice-error');
  box.append(el('p', 'notice-title', error.message || error.error || 'Onbekende fout.'));
  const hint = ERROR_HINTS[error.code];
  if (hint) box.append(el('p', 'mt-1 text-sm leading-6 text-pm-muted', hint));
  return box;
}

function renderError(error) {
  output.className = '';
  const box = errorBox(error);
  box.classList.add('mx-auto', 'max-w-2xl');
  output.replaceChildren(box);

  actions.replaceChildren();
  progressBar.classList.add('hidden');
  setStatus('error', 'Mislukt');
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
  statusBadge.className = `px-2 py-0.5 text-xs font-semibold tabular-nums ${STATUS_TONES[kind] || ''}`;
  statusBadge.classList.toggle('hidden', !kind);
  statusBadge.textContent = text || '';
}

function setSteps(steps) {
  stepButtons.forEach((button, index) => {
    const step = steps[index];
    if (!step) return;
    button.dataset.state = step.state;
    button.querySelector('.step-text').textContent = step.text;
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
  if (!value) {
    urlHint.textContent = URL_HINT;
    urlHint.className = 'field-hint';
  } else if (URL_PATTERN.test(value)) {
    urlHint.textContent = 'URL herkend: de tool haalt deze pagina zelf op.';
    urlHint.className = 'field-hint is-ok';
  } else {
    urlHint.textContent = 'Dit lijkt geen geldige URL.';
    urlHint.className = 'field-hint is-error';
  }
}

form.addEventListener('input', () => {
  updateFieldState();
  storageSet(STORAGE.draft, JSON.stringify(FIELDS.map((field) => field.value)));
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
  showEmpty();
  setTimeout(updateFieldState); // het native reset-event leegt de velden pas na deze handler
});

// --- Wachtwoord (alleen als APP_PASSWORD op de server staat) ---------------------

function askForPassword(message) {
  passwordError.textContent = message || '';
  passwordError.classList.toggle('hidden', !message);
  passwordOverlay.classList.remove('hidden');
  passwordOverlay.classList.add('flex');
  passwordInput.focus();
}

passwordForm.addEventListener('submit', (event) => {
  event.preventDefault();
  appPassword = passwordInput.value;
  storageSet(STORAGE.password, appPassword);
  passwordOverlay.classList.add('hidden');
  passwordOverlay.classList.remove('flex');
  passwordInput.value = '';
  form.requestSubmit();
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
      setStatus('saved', 'Vorige analyse');
    }
  } catch { /* ongeldige opslag negeren */ }
})();
