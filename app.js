/**
 * SEO Content Gap Analyzer — frontend
 *
 * Praat met /api/analyze en zet de JSON om in vier kaarten. Alle tekst uit het
 * rapport komt via textContent in de DOM, nooit via innerHTML: de inhoud is deels
 * door een model geschreven en deels van een vreemde website afkomstig.
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

const passwordOverlay = document.getElementById('password-overlay');
const passwordForm = document.getElementById('password-form');
const passwordInput = document.getElementById('password-input');
const passwordError = document.getElementById('password-error');

const FIELDS = [urlField, keywordField];
const URL_HINT = urlHint.textContent;
const EMPTY_STATE = output.innerHTML; // de lege staat staat in index.html en komt hier terug

const STORAGE = {
  password: 'seo-gap-password',
  draft: 'seo-gap-draft',
  report: 'seo-gap-report',
};

/** Zelfde herkenning als in api/analyze.js, zodat de hint klopt met wat de server doet. */
const URL_PATTERN = /^(https?:\/\/\S+|([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?([/?#]\S*)?)$/i;

let lastReport = null;
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

// --- Formulier -----------------------------------------------------------------

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isLoading) return;

  const data = { url: urlField.value.trim(), keyword: keywordField.value.trim() };
  if (!data.url || !data.keyword) {
    renderError({ error: 'Vul zowel de doel-URL als het zoekwoord in.', code: 'missing_input' });
    return;
  }

  setLoading(true);
  showSkeleton();
  resultScroll.scrollTop = 0;
  if (!isDesktop()) resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const report = await requestAnalysis(data);
    lastReport = report;
    storageSet(STORAGE.report, JSON.stringify(report));
    renderReport(report);
    setStatus('done', 'Klaar');
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
});

async function requestAnalysis(data) {
  const headers = { 'Content-Type': 'application/json' };
  if (appPassword) headers['X-App-Password'] = appPassword;

  let response;
  try {
    response = await fetch('/api/analyze', { method: 'POST', headers, body: JSON.stringify(data) });
  } catch {
    throw Object.assign(new Error('Geen verbinding met de server. Controleer je internetverbinding.'), {
      code: 'offline',
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw Object.assign(new Error(`De server gaf een onverwacht antwoord (HTTP ${response.status}).`), {
      code: 'bad_response',
    });
  }

  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `Analyse mislukt (HTTP ${response.status}).`), {
      code: payload.code || 'analysis_failed',
    });
  }

  return payload;
}

// --- Het rapport renderen ------------------------------------------------------

function renderReport(report) {
  output.replaceChildren(
    dekkingCard(report),
    koppenCard(report),
    termenCard(report),
    vragenCard(report)
  );
  output.className = 'space-y-4';

  actions.replaceChildren(
    copyButton(() => toMarkdown(report), 'kopieer samenvatting', 'btn btn-outline btn-sm relative')
  );
}

/** 1. Dekkingsgraad: de harde cijfers plus de kanttekening erbij. */
function dekkingCard(report) {
  const { coverage, page, intent } = report;
  const { wrapper } = card('Dekkingsgraad', `Zoekwoord: ${report.keyword}`);
  const body = el('div', 'p-5 space-y-4');

  const tiles = el('div', 'grid gap-3 sm:grid-cols-3');
  tiles.append(
    scoreTile('Onderwerpdekking', coverage.score, '%', coverage.score, scoreTone(coverage.score)),
    scoreTile(
      'Woorden',
      page.wordCount.toLocaleString('nl-NL'),
      coverage.benchmarkWordCount ? `van ~${coverage.benchmarkWordCount.toLocaleString('nl-NL')}` : '',
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

  const summary = el('p', 'text-sm leading-6');
  summary.append(el('strong', null, 'Zoekintentie: '));
  summary.append(document.createTextNode(intent.summary || '—'));
  body.append(summary);

  const split = el('div', 'flex flex-wrap gap-2');
  split.append(
    el('span', 'pill pill-info', intent.type || 'onbekend'),
    el('span', 'pill pill-good', `${coverage.topicsWithHeading} met eigen kop`),
    el('span', 'pill pill-mid', `${coverage.topicsInTextOnly} alleen in de tekst`),
    el('span', 'pill pill-bad', `${coverage.topicsMissing} ontbreekt`)
  );
  body.append(split);

  const meta = el('dl', 'grid gap-x-6 gap-y-2 sm:grid-cols-2 border-t border-pm-line pt-4 text-sm');
  metaRow(meta, 'Pagina', page.url);
  metaRow(meta, 'H1', page.h1 || '(geen H1 gevonden)');
  metaRow(meta, 'Titel', page.title || '(geen titel)');
  metaRow(meta, 'Koppen', `${page.headings.length} gevonden`);
  body.append(meta);

  body.append(el('p', 'text-xs leading-5 text-pm-muted border-t border-pm-line pt-3', report.disclaimer));

  wrapper.append(body);
  return wrapper;
}

function metaRow(list, label, value) {
  const row = el('div', 'min-w-0');
  row.append(el('dt', 'text-xs font-bold uppercase tracking-wide text-pm-muted', label));
  row.append(el('dd', 'text-sm break-anywhere', value));
  list.append(row);
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

/** 2. Ontbrekende koppen, gesorteerd op hoe vaak de topresultaten ze behandelen. */
function koppenCard(report) {
  const { wrapper } = card('Ontbrekende koppen', 'Wat de topresultaten behandelen en jouw pagina niet');
  const body = el('div', 'p-5 space-y-3');

  const missing = [...report.missingTopics].sort(
    (a, b) => prevalenceWeight(b.prevalence) - prevalenceWeight(a.prevalence)
  );

  if (missing.length === 0) {
    body.append(emptyNote('Geen ontbrekende onderwerpen gevonden. De pagina dekt alles wat de topresultaten behandelen.'));
  } else {
    missing.forEach((topic) => body.append(topicRow(topic)));
  }

  if (report.partialTopics.length) {
    body.append(
      details(
        `${report.partialTopics.length} onderwerpen staan wel in de tekst, maar zonder eigen kop`,
        report.partialTopics.map((topic) => topicRow(topic, true))
      )
    );
  }

  if (report.coveredTopics.length) {
    const list = el('ul', 'space-y-1.5 pt-1');
    report.coveredTopics.forEach((topic) => {
      const item = el('li', 'flex gap-2 text-sm');
      item.append(el('span', 'text-pm-green font-bold', '✓'), el('span', null, topic.heading));
      list.append(item);
    });
    body.append(details(`${report.coveredTopics.length} onderwerpen heb je al goed staan`, [list]));
  }

  wrapper.append(body);
  return wrapper;
}

function prevalenceWeight(prevalence) {
  return { 'vrijwel alle': 3, meerdere: 2, enkele: 1 }[prevalence] || 0;
}

function topicRow(topic, inTextOnly = false) {
  const row = el('div', 'border border-pm-line p-4');

  const top = el('div', 'flex items-start justify-between gap-3');
  const left = el('div', 'min-w-0 space-y-1');
  const labels = el('div', 'flex flex-wrap items-center gap-2');
  labels.append(el('span', 'pill pill-info', topic.level));
  labels.append(el('span', 'pill', `${topic.prevalence} topresultaten`));
  if (inTextOnly) labels.append(el('span', 'pill pill-mid', 'staat er al, zonder kop'));
  left.append(labels);
  left.append(el('p', 'text-sm font-bold leading-snug break-anywhere', topic.heading));
  top.append(left);
  top.append(copyButton(() => topicMarkdown(topic)));
  row.append(top);

  row.append(el('p', 'mt-2 text-sm leading-6 text-pm-muted', topic.why));

  if (topic.subheadings.length) {
    const subs = el('ul', 'mt-2 flex flex-wrap gap-1.5');
    topic.subheadings.forEach((sub) => subs.append(el('li', 'pill', `H3 · ${sub}`)));
    row.append(subs);
  }

  return row;
}

function topicMarkdown(topic) {
  const lines = [`## ${topic.heading}`];
  if (topic.subheadings.length) lines.push('', ...topic.subheadings.map((sub) => `### ${sub}`));
  lines.push('', `> ${topic.why}`);
  return lines.join('\n');
}

/** 3. Semantische termen: wat concurrenten gebruiken en hier ontbreekt. */
function termenCard(report) {
  const { wrapper } = card('Semantische termen', 'Termen die bij dit onderwerp horen en op je pagina ontbreken');
  const body = el('div', 'p-5 space-y-3');

  if (report.missingTerms.length === 0) {
    body.append(emptyNote('Alle verwachte termen staan al op de pagina.'));
  } else {
    const ORDER = { hoog: 0, middel: 1, laag: 2 };
    const sorted = [...report.missingTerms].sort((a, b) => ORDER[a.importance] - ORDER[b.importance]);

    ['hoog', 'middel', 'laag'].forEach((importance) => {
      const group = sorted.filter((term) => term.importance === importance);
      if (!group.length) return;

      const block = el('div');
      const heading = el('div', 'flex items-center justify-between gap-3 mb-2');
      heading.append(el('p', 'text-xs font-bold uppercase tracking-wide text-pm-muted', `Belang: ${importance}`));
      heading.append(copyButton(() => group.map((term) => term.term).join('\n'), 'kopieer groep'));
      block.append(heading);

      const list = el('ul', 'space-y-1.5');
      group.forEach((term) => {
        const item = el('li', 'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm');
        // Groen blijft gereserveerd voor "staat er al"; een term van laag belang
        // die ontbreekt krijgt dus grijs, niet groen.
        const tone = importance === 'hoog' ? ' pill-bad' : importance === 'middel' ? ' pill-mid' : '';
        item.append(el('span', `pill${tone}`, term.term));
        item.append(el('span', 'text-pm-muted text-xs leading-5', term.context));
        list.append(item);
      });
      block.append(list);
      body.append(block);
    });
  }

  if (report.presentTerms.length) {
    const list = el('ul', 'flex flex-wrap gap-1.5 pt-1');
    report.presentTerms.forEach((term) => list.append(el('li', 'pill pill-good', `✓ ${term.term}`)));
    body.append(details(`${report.presentTerms.length} termen staan er al`, [list]));
  }

  wrapper.append(body);
  return wrapper;
}

/** 4. Mensen vragen ook. */
function vragenCard(report) {
  const { wrapper } = card('Mensen vragen ook', 'Vragen om als FAQ-blok aan de pagina toe te voegen');
  const body = el('div', 'p-5 space-y-3');

  const open = report.questions.filter((item) => item.status !== 'kop');
  const answered = report.questions.filter((item) => item.status === 'kop');

  if (open.length === 0) {
    body.append(emptyNote('De pagina beantwoordt alle verwachte vragen al met een eigen kop.'));
  }

  open.forEach((item) => {
    const row = el('div', 'border border-pm-line p-4');
    const top = el('div', 'flex items-start justify-between gap-3');
    const left = el('div', 'min-w-0 space-y-1');
    left.append(
      el(
        'span',
        `pill ${item.status === 'tekst' ? 'pill-mid' : 'pill-bad'}`,
        item.status === 'tekst' ? 'staat er, maar niet als vraag' : 'ontbreekt'
      )
    );
    left.append(el('p', 'text-sm font-bold leading-snug break-anywhere', item.question));
    top.append(left);
    top.append(copyButton(() => `### ${item.question}\n\n${item.angle}`));
    row.append(top);
    row.append(el('p', 'mt-2 text-sm leading-6 text-pm-muted', item.angle));
    body.append(row);
  });

  if (answered.length) {
    const list = el('ul', 'space-y-1.5 pt-1');
    answered.forEach((item) => {
      const li = el('li', 'flex gap-2 text-sm');
      li.append(el('span', 'text-pm-green font-bold', '✓'), el('span', null, item.question));
      list.append(li);
    });
    body.append(details(`${answered.length} vragen beantwoordt de pagina al`, [list]));
  }

  wrapper.append(body);
  return wrapper;
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

// --- Markdown-export -----------------------------------------------------------

function toMarkdown(report) {
  const { coverage, page } = report;
  const lines = [
    `# Content gap: ${report.keyword}`,
    '',
    `**Pagina:** ${page.url}`,
    `**Geanalyseerd op:** ${new Date(report.generatedAt).toLocaleString('nl-NL')}`,
    '',
    '## Dekkingsgraad',
    '',
    `- Onderwerpdekking: **${coverage.score}%** (${coverage.topicsWithHeading} met eigen kop, ${coverage.topicsInTextOnly} alleen in de tekst, ${coverage.topicsMissing} ontbreekt)`,
    `- Woorden: **${page.wordCount}**${coverage.benchmarkWordCount ? ` tegenover ~${coverage.benchmarkWordCount} bij de topresultaten (${coverage.wordCountRatio}%)` : ''}`,
    `- Semantische termen aanwezig: **${coverage.termsPresent} van ${coverage.termsTotal}**`,
    `- Zoekintentie: ${report.intent.summary} (${report.intent.type})`,
    '',
    '## Ontbrekende koppen',
    '',
  ];

  if (report.missingTopics.length === 0) {
    lines.push('Geen ontbrekende onderwerpen gevonden.', '');
  } else {
    report.missingTopics.forEach((topic) => {
      lines.push(`### ${topic.level}: ${topic.heading}`, '', `${topic.why} (${topic.prevalence} topresultaten)`, '');
      topic.subheadings.forEach((sub) => lines.push(`- H3: ${sub}`));
      if (topic.subheadings.length) lines.push('');
    });
  }

  if (report.partialTopics.length) {
    lines.push('### Wel aanwezig, maar zonder eigen kop', '');
    report.partialTopics.forEach((topic) => lines.push(`- ${topic.heading}`));
    lines.push('');
  }

  lines.push('## Ontbrekende semantische termen', '');
  if (report.missingTerms.length === 0) {
    lines.push('Geen.', '');
  } else {
    report.missingTerms.forEach((term) => lines.push(`- **${term.term}** (${term.importance}) — ${term.context}`));
    lines.push('');
  }

  lines.push('## Mensen vragen ook', '');
  report.questions.forEach((item) => {
    const mark = item.status === 'kop' ? '✓ al beantwoord' : item.status === 'tekst' ? '~ staat in de tekst' : '✗ ontbreekt';
    lines.push(`- **${item.question}** (${mark}) — ${item.angle}`);
  });

  lines.push('', '---', '', report.disclaimer);
  return lines.join('\n');
}

// --- Staten --------------------------------------------------------------------

function showEmpty() {
  output.className = '';
  output.innerHTML = EMPTY_STATE;
  actions.replaceChildren();
  progressBar.classList.add('hidden');
  setStatus(null);
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
  timeout: 'De server reageerde te traag. Probeer het zo opnieuw, of kies een snellere pagina.',
  not_html: 'Geef een gewone webpagina op, geen PDF of afbeelding.',
  empty_page: 'Deze pagina bouwt zijn tekst waarschijnlijk met JavaScript op, of er staat een cookiemuur voor.',
  rate_limited: 'Er zijn veel analyses achter elkaar gedraaid. Wacht een paar minuten.',
  no_api_key: 'Zet ANTHROPIC_API_KEY in Vercel onder Settings → Environment Variables.',
  offline: 'Controleer je internetverbinding.',
};

function renderError(error) {
  output.className = '';
  const box = el('div', 'notice notice-error mx-auto max-w-2xl');
  box.append(el('p', 'notice-title', error.message));
  const hint = ERROR_HINTS[error.code];
  if (hint) box.append(el('p', 'mt-1 text-sm leading-6 text-pm-muted', hint));
  output.replaceChildren(box);

  actions.replaceChildren();
  progressBar.classList.add('hidden');
  setStatus('error', 'Mislukt');
}

function isDesktop() {
  return window.matchMedia('(min-width: 1024px)').matches;
}

// --- UI-helpers ----------------------------------------------------------------

function setLoading(loading) {
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
  const startedAt = Date.now();
  const tick = () => {
    const elapsed = formatDuration(Date.now() - startedAt);
    submitLabel.textContent = `bezig met analyseren… ${elapsed}`;
    setStatus('busy', elapsed);
  };
  tick();
  timer = setInterval(tick, 1000);
}

const STATUS_TONES = {
  busy: 'bg-pm-tint text-pm-blue',
  done: 'bg-[#e3f4ee] text-[#00704f]',
  error: 'bg-[#fbe8ee] text-[#9e1744]',
  saved: 'bg-[#eef2f5] text-pm-muted',
};

function setStatus(kind, text) {
  statusBadge.className = `px-2 py-0.5 text-xs font-semibold tabular-nums ${STATUS_TONES[kind] || ''}`;
  statusBadge.classList.toggle('hidden', !kind);
  statusBadge.textContent = text || '';
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
  storageRemove(STORAGE.draft);
  storageRemove(STORAGE.report);
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
// Invoer en laatste rapport overleven een refresh: een analyse kost een minuut en geld.

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
    const saved = JSON.parse(storageGet(STORAGE.report) || 'null');
    if (saved?.coverage) {
      lastReport = saved;
      renderReport(saved);
      setStatus('saved', 'Vorige analyse');
    }
  } catch { /* ongeldige opslag negeren */ }
})();
