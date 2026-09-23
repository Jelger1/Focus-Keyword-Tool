/**
 * Keyword Focus & Intent Check — het rapport
 *
 * Zet een antwoord van /api/analyze om in een dashboard van kaarten, in de opbouw
 * van onze focus keyword-documenten:
 *
 *   kop   het oordeel, de kerncijfers met hun bron
 *   1     beoordeling huidige focus keyword
 *   2     focus keyword: behouden of nieuw (bij geen match: een beter zoeken)
 *   3     aanbevolen keyword mapping
 *   4     focus keyword optimalisatie
 *   5     aanbevelingen voor de pagina, met 5.2 termen en 5.3 vragen
 *   6     niet doen
 *   7     samenvatting
 *   B     bronnen en methode
 *
 * Dezelfde kaarten zijn de pdf (print.css). Alles wat een bron draagt blijft daarom
 * zichtbaar; alleen het spoor van een herfocus zit achter een klik. Rapporttekst
 * gaat via textContent in de DOM, innerHTML alleen voor de vaste iconen hieronder.
 *
 * Gebruikt de helpers uit app.js (el, copyButton, fmt, share, ...). Dit bestand laadt
 * eerder, maar de functies draaien pas als app.js er ook is.
 */

const REPORT_ICONS = {
  check: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z" clip-rule="evenodd"/></svg>',
  cross: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5.5 5.5l9 9m0-9-9 9"/></svg>',
  dash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 10h10"/></svg>',
  dot: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4.5" fill="currentColor"/></svg>',
};

const TONE_ICONS = { good: 'check', mid: 'dash', bad: 'cross', muted: 'dash', info: 'dot' };

/** De teksten bij een bron staan op één plek: zo pas je de woorden in één keer aan. */
const PROV_TEXT = {
  gsc: 'meting · Search Console',
  onPage: 'meting · op de pagina',
  competitors: (n) => `meting · ${n} concurrenten`,
  ahrefs: (region) => `schatting · Ahrefs ${region.short}`,
  serp: (report) => `SERP · ${serpSourceName(report)}`,
  claude: 'interpretatie · Claude',
  claudeChecked: 'interpretatie · Claude, posities gecontroleerd',
};

/** Hoe zeker een bron is, per herkomst van een zoekwoord (SOURCE_LABELS in app.js). */
const SOURCE_KIND = { gsc: 'meting', ahrefs: 'schatting', ai: 'claude' };

const PLACEMENT_VERDICT = {
  letterlijk: { tone: 'good', text: 'al correct', reason: '' },
  los: { tone: 'mid', text: 'niet correct', reason: 'woorden los, niet als geheel' },
  ontbreekt: { tone: 'bad', text: 'niet correct', reason: 'zoekwoord ontbreekt' },
};

const SERP_STATUS = {
  vergeleken: { tone: 'good', text: 'vergeleken' },
  mislukt: { tone: 'bad', text: 'mislukt' },
  overgeslagen: { tone: 'muted', text: 'overgeslagen' },
  'eigen domein': { tone: 'muted', text: 'eigen domein' },
  'jouw pagina': { tone: 'info', text: 'jouw pagina' },
};

// --- Bouwstenen ------------------------------------------------------------------------

function reportIcon(name) {
  const holder = document.createElement('span');
  holder.innerHTML = REPORT_ICONS[name];
  return holder.firstChild;
}

/** Een status is altijd icoon plus tekst: kleur alleen zegt een zwart-witprint niets. */
function statusTag(tone, text, { iconOnly = false } = {}) {
  const tag = el('span', 'status');
  tag.dataset.tone = tone;
  tag.append(reportIcon(TONE_ICONS[tone] || 'dash'));
  tag.append(el('span', iconOnly ? 'sr-only' : null, text));
  if (iconOnly) tag.title = text;
  return tag;
}

/**
 * Waar een cijfer of bewering vandaan komt, met een eigen vorm per soort: meting
 * (bolletje), schatting (ring), SERP-momentopname (vierkant), interpretatie (ruit).
 */
function prov(kind, text) {
  const tag = el('span', 'prov', text);
  if (kind) tag.dataset.kind = kind;
  return tag;
}

/** Posities als chips; die van de eigen pagina valt op, want daar kijkt de klant naar. */
function posChips(positions, report) {
  const list = el('span', 'pos-list');
  (positions || []).forEach((position) => {
    const own = position === report.serp?.targetPosition;
    const chip = el('span', `pos${own ? ' is-own' : ''}`, `#${position}`);
    if (own) {
      chip.title = 'jouw pagina';
      chip.append(el('span', 'sr-only', ' (jouw pagina)'));
    }
    list.append(chip);
  });
  return list;
}

/** Een hoofdstukkaart: nummer, titel, ondertitel, bron en acties; daaronder de inhoud. */
function reportSection({ id, num, title, tag, sub, provNode, actions = [], variant = '' }) {
  const wrapper = el('section', `rsec${variant ? ` ${variant}` : ''}`);
  if (id) wrapper.id = id;
  const head = el('div', 'rsec-head');
  const number = el('span', 'rsec-num hex', num || '');
  number.setAttribute('aria-hidden', 'true');
  const titles = el('div', 'rsec-titles');
  const heading = el('h3', 'rsec-title', title);
  if (id) {
    heading.id = `${id}-title`;
    wrapper.setAttribute('aria-labelledby', heading.id);
  }
  if (tag) heading.append(document.createTextNode(' '), el('span', 'rsec-tag', tag));
  titles.append(heading);
  if (sub) titles.append(el('p', 'rsec-sub', sub));
  if (provNode) titles.append(provNode);
  head.append(number, titles);
  if (actions.length) {
    const side = el('div', 'rsec-actions');
    side.append(...actions);
    head.append(side);
  }
  const body = el('div', 'rsec-body');
  wrapper.append(head, body);
  return { wrapper, body };
}

/** Een blok binnen een hoofdstuk met een eigen kop. */
function rsub(title, { extra, num, rule = false } = {}) {
  const wrapper = el('div', `rsub${rule ? ' has-rule' : ''}`);
  const head = el('div', 'rsub-head');
  const heading = el('h4', 'rsub-title');
  if (num) heading.append(el('span', 'subnum', num));
  heading.append(document.createTextNode(title));
  head.append(heading);
  if (extra) head.append(extra);
  wrapper.append(head);
  return wrapper;
}

function kpiTile({ label, value, unit, notes = [], provNode, bar, tone, empty = false, isText = false }) {
  const tile = el('div', `kpi${empty ? ' is-empty' : ''}`);
  if (tone) tile.dataset.tone = tone;
  tile.append(el('p', 'kpi-label', label));
  const valueLine = el('p', `kpi-value${isText ? ' is-text' : ''}`, value);
  if (unit) valueLine.append(el('small', null, unit));
  tile.append(valueLine);
  if (bar !== undefined && bar !== null) {
    const track = el('div', 'kpi-bar');
    track.setAttribute('aria-hidden', 'true');
    const fill = el('span');
    fill.style.width = `${Math.min(Math.max(bar, 0), 100)}%`;
    track.append(fill);
    tile.append(track);
  }
  notes.filter(Boolean).forEach((line) => tile.append(el('p', 'kpi-note', line)));
  if (provNode) tile.append(provNode);
  return tile;
}

/** Sleutel-waardelijst. Een waarde is tekst of een node; de bron staat erachter. */
function factsList(rows) {
  const list = el('dl', 'facts');
  rows.filter(Boolean).forEach(({ label, value, provNode, sub }) => {
    const row = el('div');
    row.append(el('dt', null, label));
    const dd = el('dd');
    dd.append(typeof value === 'string' ? document.createTextNode(value) : value);
    if (provNode) dd.append(provNode);
    if (sub) dd.append(el('span', 'cell-sub', sub));
    row.append(dd);
    list.append(row);
  });
  return list;
}

/** Wat al goed staat: compact en groen, en omdat het niet ingeklapt is ook in de pdf. */
function doneList(items) {
  const list = el('ul', 'done-list');
  items.forEach((text) => {
    const item = el('li');
    item.append(reportIcon('check'), el('span', null, text));
    list.append(item);
  });
  return list;
}

/** Kopieerknop met alleen een icoon, voor elke aanbeveling en vraag: aanwezig, niet luid. */
function iconCopy(getText, label) {
  const button = copyButton(getText, label, 'btn btn-quiet btn-icon relative');
  button.querySelector('span')?.classList.add('sr-only');
  button.title = label;
  return button;
}

/** "22 september 2026" of, met tijd, "22 september 2026 om 17:01". */
function formatDate(value, { time = false } = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  return time ? `${day}, ${date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}` : day;
}

/**
 * "22 juni t/m 20 september 2026" uit de JJJJ-MM-DD van Search Console. Als lokale
 * datum gelezen: new Date('2026-06-22') is UTC en wordt ten westen daarvan de 21e.
 */
function formatPeriod(start, end, { short = false } = {}) {
  const parse = (text) => {
    const [y, m, d] = String(text || '').split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, d) : null;
  };
  const from = parse(start);
  const to = parse(end);
  if (!from || !to) return '';
  const month = short ? 'short' : 'long';
  const sameYear = from.getFullYear() === to.getFullYear();
  const first = from.toLocaleDateString('nl-NL', sameYear ? { day: 'numeric', month } : { day: 'numeric', month, year: 'numeric' });
  return `${first} t/m ${to.toLocaleDateString('nl-NL', { day: 'numeric', month, year: 'numeric' })}`;
}

/** Periode plus landen: een lijst zonder landfilter telt alle landen samen, en dat zeggen we. */
function gscWhen(gsc, report, { short = false } = {}) {
  const period = formatPeriod(gsc?.startDate, gsc?.endDate, { short });
  const where = gsc?.country ? `alleen ${regionOf(report).label}` : 'alle landen samen';
  return period ? `${period}, ${where}` : where;
}

function decimal(value) {
  return String(value).replace('.', ',');
}

function serpSourceName(report) {
  return report.serp?.providerId === 'serper' ? 'Serper' : 'Ahrefs';
}

/**
 * De databron in woorden voor een klant: zonder emoji en zonder "Pure Minds-klant".
 * De badge in de kop van de tool houdt zijn interne tekst.
 */
function clientSource(info) {
  const source = { gsc: 'gsc_upload', ahrefs: 'ahrefs_only' }[info?.source] || info?.source;
  if (!source) return null;
  switch (source) {
    case 'hybrid_gsc_ahrefs':
      return { kind: 'meting', text: 'Search Console van deze pagina (meting), aangevuld met Ahrefs (schatting)' };
    case 'gsc_only':
      return { kind: 'meting', text: 'Search Console van deze pagina (meting); geen Ahrefs-cijfers gebruikt' };
    case 'gsc_upload':
      return { kind: 'meting', text: 'Search Console-export (meting)' };
    case 'serp_only':
      return { kind: null, text: 'alleen de Google-top 10 (geen Ahrefs, geen Search Console)' };
    default:
      return { kind: 'schatting', text: 'zonder Search Console: cijfers zijn schattingen van Ahrefs' };
  }
}

/**
 * Kwam er in dit rapport iets van Ahrefs? Zonder Ahrefs-sleutel komt de SERP van
 * Serper en zijn er geen volumes: dan hoort "schatting (Ahrefs)" niet in de legenda.
 */
function usesAhrefs(report) {
  if (report.keywordInfo || serpSourceName(report) === 'Ahrefs') return true;
  const mapping = report.mapping || {};
  return ['secondary', 'supporting', 'variants', 'brand']
    .some((group) => (mapping[group] || []).some((item) => typeof item.volume === 'number'));
}

function legendLine(report, { label = true } = {}) {
  const legend = el('p', 'prov-legend');
  if (label) legend.append(el('span', 'eyebrow', 'Legenda'));
  legend.append(prov('meting', 'meting (Search Console, koppen en woorden op de pagina’s)'));
  if (usesAhrefs(report)) legend.append(prov('schatting', 'schatting (Ahrefs)'));
  legend.append(
    prov('serp', `SERP-momentopname (${serpSourceName(report)})`),
    prov('claude', 'interpretatie van Claude, gecontroleerd door de tool')
  );
  return legend;
}

/** Onder dit maandvolume telt een AI-voorstel niet als geverifieerd (MIN_PROPOSAL_VOLUME in lib/refocus.js). */
const MIN_VERIFIED_VOLUME = 10;

/**
 * Waar het focus zoekwoord vandaan komt, in woorden. Een zelf gekozen AI-voorstel
 * zonder zoekvolume heet niet "geverifieerd": de analyse haalde voor dit zoekwoord
 * zelf de Ahrefs-cijfers op, dus dat is na te gaan.
 */
function originLabel(report) {
  const { source } = report.origin || {};
  if (source === 'ai' && !((report.keywordInfo?.volume ?? 0) >= MIN_VERIFIED_VOLUME)) {
    return 'AI-voorstel, geen zoekvolume bekend bij Ahrefs';
  }
  return SOURCE_LABELS[source] || source;
}

// --- Het rapport -------------------------------------------------------------------------

/**
 * Alle kaarten van een rapport, in volgorde. `options` zijn die van renderReport: bij
 * geen match bepalen ze wat kaart 2 toont (formulier, bezig, resultaat).
 */
function reportCards(report, options = {}) {
  const cards = [reportHead(report), beoordelingCard(report)];
  if (report.stage === 'compleet') {
    cards.push(
      focusCard(report),
      mappingCard(report),
      placementCard(report),
      aanbevelingenCard(report),
      termenCard(report),
      vragenCard(report),
      nietDoenCard(report),
      samenvattingCard(report)
    );
  } else {
    cards.push(refocusCard(report, options));
  }
  cards.push(bronnenCard(report), reportEnd(report));
  return cards;
}

// --- Kop: het antwoord eerst -------------------------------------------------------------

function reportHead(report) {
  const { serp, origin } = report;
  const region = regionOf(report);
  const head = el('section', 'rsec report-head');
  head.id = 'sec-top';
  head.setAttribute('aria-labelledby', 'report-title');

  // Logo, titel en datum bovenaan de eerste pdf-pagina. Niet lazy: dan mist hij in de pdf.
  const brand = el('div', 'print-brand print-only');
  const logo = el('img', 'print-logo');
  logo.src = 'pureminds-logo.webp';
  logo.alt = 'Pure Minds';
  logo.width = 800;
  logo.height = 295;
  const doc = el('p', 'print-doc');
  doc.append(el('strong', null, 'Focus keyword-rapport'), el('span', null, formatDate(report.generatedAt)));
  brand.append(logo, doc);

  const id = el('div', 'report-id');
  id.append(el('p', 'eyebrow', 'Focus keyword'));
  const title = el('h3', 'report-title', report.keyword);
  title.id = 'report-title';
  id.append(title);
  if (report.page?.url) {
    const link = el('a', 'report-url', report.page.url);
    link.href = report.page.url;
    link.target = '_blank';
    link.rel = 'noopener';
    id.append(link);
  }

  const meta = el('dl', 'report-meta');
  const pair = (label, value) => {
    if (!value) return;
    const row = el('div');
    row.append(el('dt', null, label), el('dd', null, value));
    meta.append(row);
  };
  pair('Geanalyseerd', formatDate(report.generatedAt, { time: true }));
  pair('SERP', serp.provider);
  pair('Regio', `Google ${region.label} · teksten in het ${region.language}`);
  pair('Databron', clientSource(report)?.text);
  if (report.stage === 'compleet' && origin.source !== 'handmatig' && origin.previousKeyword) {
    pair('Vervangt', `‘${origin.previousKeyword}’ · ${originLabel(report)}`);
  }

  head.append(brand, id, meta, verdictHero(report), kpiGrid(report), legendLine(report));
  return head;
}

function verdictHero(report) {
  const { intent } = report;
  const yes = Boolean(intent.match);
  const box = el('div', `verdict ${yes ? 'verdict-yes' : 'verdict-no'} verdict-hero`);
  const mark = el('span', 'verdict-mark hex');
  mark.setAttribute('aria-hidden', 'true');
  mark.append(reportIcon(yes ? 'check' : 'cross'));
  box.append(mark, el('p', 'verdict-title', yes ? 'De pagina past bij dit zoekwoord.' : 'De pagina past niet bij dit zoekwoord.'));

  const meta = el('p', 'verdict-meta');
  meta.append(el('span', null, yes ? 'Geschikt als primary keyword' : 'Niet geschikt als primary keyword'));
  const certainty = el('span', 'certainty');
  certainty.dataset.level = intent.confidence;
  const bar = el('span', 'certainty-bar');
  bar.setAttribute('aria-hidden', 'true');
  bar.append(el('i'), el('i'), el('i'));
  certainty.append(bar, document.createTextNode(`zekerheid: ${intent.confidence}`));
  meta.append(certainty);
  if (intent.mismatch?.label) meta.append(el('span', 'pill pill-bad', intent.mismatch.label));
  box.append(meta);

  if (intent.mismatch?.explanation) box.append(el('p', 'verdict-text', intent.mismatch.explanation));
  if (intent.mismatch?.direction) {
    const direction = el('p', 'verdict-direction');
    direction.append(el('strong', null, 'Richting voor een beter zoekwoord: '), document.createTextNode(intent.mismatch.direction));
    box.append(direction);
  }
  box.append(el('p', 'verdict-note', 'Interpretatie van Claude op basis van de gemeten SERP; de tool controleerde elke genoemde positie. Geen garantie op posities.'));

  // De vervolgstap staat onder de beoordeling; deze knop brengt je er direct.
  if (report.stage !== 'compleet') {
    const line = el('p', 'screen-only');
    const refocus = report.nextStep === 'refocus';
    const jump = el('button', `btn ${refocus ? 'btn-primary' : 'btn-outline'} btn-sm`);
    jump.type = 'button';
    jump.textContent = refocus ? 'zoek een beter zoekwoord' : 'bekijk je opties';
    jump.addEventListener('click', scrollToRefocus);
    line.append(jump);
    box.append(line);
  }
  return box;
}

/** De kerncijfers. Elke tegel heeft precies één bron; ontbreekt een cijfer, dan staat er waarom. */
function kpiGrid(report) {
  const { keywordInfo, serp, gsc, coverage } = report;
  const region = regionOf(report);
  const tiles = [];

  const serpNote = serp.updatedAt ? `stand ${formatDate(serp.updatedAt)}` : serp.provider;
  tiles.push(serp.targetPosition
    ? kpiTile({ label: 'Positie in Google', value: `#${serp.targetPosition}`, notes: [serpNote], provNode: prov('serp', PROV_TEXT.serp(report)) })
    // Buiten de top 10 is ook een waarneming, geen ontbrekend cijfer.
    : kpiTile({ label: 'Positie in Google', value: 'buiten top 10', isText: true, notes: [serpNote], provNode: prov('serp', PROV_TEXT.serp(report)) }));

  tiles.push(keywordInfo
    ? kpiTile({
        label: 'Zoekvolume',
        value: fmt(keywordInfo.volume),
        unit: '/mnd',
        notes: [`moeilijkheid (KD) ${fmt(keywordInfo.difficulty)}`],
        provNode: prov('schatting', PROV_TEXT.ahrefs(region)),
      })
    : kpiTile({ label: 'Zoekvolume', value: '—', notes: [missingVolumeText(report)], provNode: prov('schatting', PROV_TEXT.ahrefs(region)), empty: true }));

  const focus = gsc?.insight?.focusKeyword;
  if (gsc?.status === 'ok' && focus) {
    tiles.push(kpiTile({
      label: 'Search Console',
      value: fmt(focus.impressions),
      unit: 'vertoningen',
      notes: [`${fmt(focus.clicks)} klikken · gem. positie ${decimal(focus.position)}`, gscWhen(gsc, report, { short: true })],
      provNode: prov('meting', PROV_TEXT.gsc),
    }));
  } else {
    const reason = gsc?.status === 'ok'
      ? 'zoekwoord niet in de Search Console-data van deze pagina'
      : gsc ? GSC_REASONS[gsc.status] || 'Search Console niet gebruikt' : 'niet gebruikt in dit rapport';
    tiles.push(kpiTile({ label: 'Search Console', value: '—', notes: [reason], provNode: prov('meting', PROV_TEXT.gsc), empty: true }));
  }

  if (report.stage === 'compleet' && coverage) {
    const score = coverage.score;
    const hasScore = score !== null && score !== undefined;
    tiles.push(kpiTile({
      label: 'Onderwerpdekking',
      value: hasScore ? `${score}%` : '—',
      bar: hasScore ? score : null,
      tone: hasScore ? (score >= 75 ? 'good' : score >= 45 ? 'mid' : 'bad') : undefined,
      notes: [`${coverage.topicsWithHeading} met eigen kop · ${coverage.topicsInTextOnly} alleen in de tekst · ${coverage.topicsMissing} ontbreken`],
      provNode: prov('meting', PROV_TEXT.competitors(coverage.competitorsCompared)),
      empty: !hasScore,
    }));
  }

  const grid = el('div', 'kpi-grid');
  grid.dataset.count = String(tiles.length);
  grid.append(...tiles);
  return grid;
}

// --- 1 Beoordeling ---------------------------------------------------------------------------

function beoordelingCard(report) {
  const { intent, measured, keywordInfo, gsc } = report;
  const region = regionOf(report);
  const { wrapper, body } = reportSection({
    id: 'sec-beoordeling',
    num: '1',
    title: 'Beoordeling huidige focus keyword',
    sub: 'Past het doel van je pagina bij wat de zoeker in Google wil?',
  });

  const compare = el('div', 'compare');
  const pane = (label, pageType, intentType, summary, positions) => {
    const box = el('div', 'compare-pane');
    box.append(el('p', 'eyebrow', label));
    if (pageType) box.append(el('p', 'compare-type', pageType));
    if (intentType) box.append(el('span', 'pill', intentType));
    box.append(el('p', 'compare-text', summary || '—'));
    if (positions?.length) {
      const foot = el('p', 'compare-foot');
      foot.append(document.createTextNode('Dominante groep'), posChips(positions, report));
      box.append(foot);
    }
    return box;
  };
  compare.append(
    pane('Jouw pagina', intent.page.pageType, intent.page.intentType, intent.page.summary),
    pane('De top 10', intent.serp.dominantPageType, intent.serp.intentType, intent.serp.summary, intent.serp.positions)
  );
  body.append(compare);

  if (intent.reasons.length) {
    const block = rsub('Argumenten', { extra: prov('claude', PROV_TEXT.claudeChecked) });
    const list = el('ul', 'arg-list');
    intent.reasons.forEach((reason) => {
      const item = el('li', 'arg');
      item.append(document.createTextNode(reason.text), posChips(reason.positions, report));
      list.append(item);
    });
    block.append(list);
    body.append(block);
  }

  const measuredBlock = rsub('Wat er gemeten is');
  if (measured.pageTypes.length) {
    const caption = el('div', 'caption-line');
    caption.append(el('p', 'eyebrow', 'Paginatypes in de top 10'), prov('serp', PROV_TEXT.serp(report)));
    measuredBlock.append(caption);
    const bars = el('ul', 'typebars');
    measured.pageTypes.forEach((type) => {
      const row = el('li', 'tb-row');
      const label = el('span', 'tb-label', type.label);
      if (measured.ownPageType && type.label === measured.ownPageType) label.append(el('small', null, ' · jouw paginatype'));
      const bar = el('span', 'tb-bar');
      bar.setAttribute('aria-hidden', 'true');
      const fill = el('span');
      fill.style.width = `${Math.round((type.count / Math.max(measured.total, 1)) * 100)}%`;
      bar.append(fill);
      row.append(label, bar, el('span', 'tb-count', `${type.count}/${measured.total} · posities ${type.positions.join(', ')}`));
      bars.append(row);
    });
    measuredBlock.append(bars);
  } else {
    measuredBlock.append(el('p', 'note', 'Paginatypes zijn bij deze SERP-bron niet beschikbaar.'));
  }

  const totals = gsc?.status === 'ok' ? gsc.insight?.totals : null;
  const facts = factsList([
    keywordInfo?.parentTopic && {
      label: 'Parent topic',
      value: `${keywordInfo.parentTopic} · ${fmt(keywordInfo.parentVolume)}/mnd`,
      provNode: prov('schatting', PROV_TEXT.ahrefs(region)),
    },
    keywordInfo && { label: 'Intentievlaggen', value: intentFlags(keywordInfo.intents), provNode: prov('schatting', PROV_TEXT.ahrefs(region)) },
    measured.topKeywords.length && {
      label: 'Topzoekwoorden concurrenten',
      value: measured.topKeywords.slice(0, 4).map((entry) => `${entry.keyword} ×${entry.count}`).join(', '),
      provNode: prov('serp', PROV_TEXT.serp(report)),
    },
    measured.features.length && {
      label: 'SERP-features',
      value: measured.features.map((feature) => `${featureLabel(feature.type)} ×${feature.count}`).join(', '),
      provNode: prov('serp', PROV_TEXT.serp(report)),
    },
    totals && {
      label: totals.scope === 'pagina' ? 'Search Console, hele pagina' : 'Search Console, getoonde zoekopdrachten',
      value: [
        `${fmt(totals.impressions)} vertoningen`,
        `${fmt(totals.clicks)} klikken`,
        typeof totals.position === 'number' ? `gem. positie ${decimal(totals.position)}` : '',
      ].filter(Boolean).join(' · '),
      provNode: prov('meting', PROV_TEXT.gsc),
      sub: gscWhen(gsc, report),
    },
  ]);
  if (facts.children.length) measuredBlock.append(facts);
  body.append(measuredBlock);
  return wrapper;
}

// --- 2 Focus keyword --------------------------------------------------------------------------

function focusCard(report) {
  const { origin } = report;
  const kept = origin.source === 'handmatig';
  const { wrapper, body } = reportSection({
    id: 'sec-focus',
    num: '2',
    title: `Focus keyword: ${report.keyword}`,
    tag: kept ? '(behouden als Primary)' : '(nieuw)',
    variant: 'is-compact',
  });

  if (kept) {
    body.append(el('p', 'prose', 'Het opgegeven zoekwoord past bij de pagina en bij de Google-top 10 (zie 1). Het blijft het primary keyword.'));
    return wrapper;
  }

  body.append(el('p', 'prose', `Vervangt ‘${origin.previousKeyword || '—'}’.`));
  const sourceLine = el('p', 'source-line');
  sourceLine.append(prov(SOURCE_KIND[origin.source], originLabel(report)));
  body.append(sourceLine);
  if (origin.why) {
    const why = el('p', 'prose', `${origin.why} `);
    why.append(prov('claude', PROV_TEXT.claude));
    body.append(why);
  }

  const refocus = refocusFor(report);
  if (refocus) {
    const listSource = listSourceOf(refocus);
    const options = [
      ...(refocus.alternatives || []).map((item) => ({ ...item, source: item.source || listSource })),
      ...(refocus.proposals || []).filter((item) => item.verified).map((item) => ({ ...item, source: 'ai' })),
    ].filter((item) => item.keyword.toLowerCase() !== report.keyword.toLowerCase());
    if (options.length) {
      const block = el('div', 'screen-only');
      block.append(el('p', 'eyebrow', 'Liever een alternatief?'));
      const list = el('div', 'rsec-actions');
      list.style.justifyContent = 'flex-start';
      list.style.marginTop = '.5rem';
      options.forEach((item) => list.append(analyseWithButton(item.keyword, item.source, item.why, report)));
      block.append(list);
      body.append(block);
    }
    body.append(details(`Zo is ‘${report.keyword}’ gekozen`, [refocusResult(refocus, report, { done: true })]));
  }
  return wrapper;
}

// --- 3 Keyword mapping ------------------------------------------------------------------------

function mappingCard(report) {
  const { mapping, keywordInfo, gsc } = report;
  const withGsc = gsc?.status === 'ok';
  const region = regionOf(report);
  const { wrapper, body } = reportSection({
    id: 'sec-mapping',
    num: '3',
    title: 'Aanbevolen keyword mapping',
    sub: withGsc
      ? 'Gekozen uit zoekwoordideeën van Ahrefs, de topzoekwoorden van de concurrenten en de zoekopdrachten van deze pagina in Search Console'
      : 'Gekozen uit zoekwoordideeën van Ahrefs en de topzoekwoorden van de concurrenten',
    actions: [copyButton(() => mappingMarkdown(report), 'kopieer mapping')],
  });

  const table = el('table', 'data-table is-fixed no-zebra map-table');
  table.append(el('caption', 'sr-only', 'Aanbevolen keyword mapping'));
  const head = el('thead');
  const headRow = el('tr');
  const numberHead = (short, long, kind, source, width) => {
    const cell = el('th', `num ${width}`);
    cell.scope = 'col';
    cell.append(el('span', 'cq-until-m', short), el('span', 'cq-from-m', long));
    const sub = el('span', 'th-sub');
    sub.append(prov(kind, source));
    cell.append(sub);
    return cell;
  };
  const keywordHead = el('th', null, 'Zoekwoord');
  keywordHead.scope = 'col';
  headRow.append(keywordHead, numberHead('Vol.', 'Volume', 'schatting', 'Ahrefs', 'w-vol'));
  if (withGsc) headRow.append(numberHead('Vert.', 'Vertoningen', 'meting', 'Search Console', 'w-imp'));
  head.append(headRow);
  table.append(head);
  const columns = withGsc ? 3 : 2;

  const groups = [
    { label: 'Primary', primary: true, items: [{ keyword: mapping.primary, volume: keywordInfo?.volume ?? null, impressions: gsc?.insight?.focusKeyword?.impressions ?? null }] },
    { label: 'Secondary', items: mapping.secondary },
    { label: 'Supporting', items: mapping.supporting },
    { label: 'Varianten', items: mapping.variants },
    { label: 'Merktermen', items: mapping.brand },
  ];
  groups.forEach((group) => {
    const groupBody = el('tbody');
    const groupRow = el('tr', 'group-row');
    const groupCell = el('th', null, group.label);
    groupCell.scope = 'rowgroup';
    groupCell.colSpan = columns;
    if (!group.primary) groupCell.append(el('span', 'group-count', group.items.length));
    groupRow.append(groupCell);
    groupBody.append(groupRow);

    if (!group.items.length) {
      const row = el('tr');
      const cell = el('td', 'cell-empty', 'geen');
      cell.colSpan = columns;
      row.append(cell);
      groupBody.append(row);
    }
    group.items.forEach((item) => {
      const row = el('tr', group.primary ? 'is-primary' : null);
      const cell = el('td');
      cell.append(el('span', 'cell-main', item.keyword));
      // Uitleg en herkomst in één blok: op het scherm onder elkaar, in de pdf achter elkaar.
      if (item.why || item.sources?.length) {
        const sub = el('span', 'cell-sub');
        if (item.why) sub.append(el('span', 'map-why', item.why));
        if (item.sources?.length) sub.append(el('span', 'map-origin', `herkomst: ${item.sources.join(' · ')}`));
        cell.append(sub);
      }
      row.append(cell, el('td', 'num', fmt(item.volume)));
      if (withGsc) row.append(el('td', 'num', fmt(item.impressions)));
      groupBody.append(row);
    });
    table.append(groupBody);
  });

  const wrap = el('div', 'table-wrap');
  wrap.append(table);
  body.append(wrap);
  body.append(el('p', 'note', [
    `Volume: schatting van Ahrefs voor Google ${region.label}, per maand.`,
    withGsc ? `Vertoningen: gemeten in Search Console van deze pagina, ${gscWhen(gsc, report)}.` : '',
    'De indeling per groep is een interpretatie van Claude, alleen uit opgehaalde zoekwoorden.',
  ].filter(Boolean).join(' ')));
  return wrapper;
}

// --- 4 Focus keyword optimalisatie ------------------------------------------------------------

function placementCard(report) {
  const entries = Object.entries(report.placement || {});
  const correct = entries.filter(([, item]) => item.status === 'letterlijk').length;
  const { wrapper, body } = reportSection({
    id: 'sec-optimalisatie',
    num: '4',
    title: 'Focus keyword optimalisatie',
    sub: `Gemeten op de pagina: ${correct} van ${entries.length} plekken bevatten het zoekwoord letterlijk.`,
    provNode: prov('meting', PROV_TEXT.onPage),
  });

  const list = el('ol', 'opt-list');
  entries.forEach(([key, item]) => {
    const verdict = PLACEMENT_VERDICT[item.status] || PLACEMENT_VERDICT.ontbreekt;
    const row = el('li', 'opt-row');
    const name = el('div', 'opt-el');
    name.append(el('h4', 'opt-name', PLACEMENT_LABELS[key]), statusTag(verdict.tone, verdict.text));
    if (verdict.reason) name.append(el('span', 'opt-reason', verdict.reason));

    const content = el('div', 'opt-body');
    content.append(
      el('p', 'opt-label', 'Nu op de pagina'),
      el('p', `opt-now${key === 'intro' ? ' is-clamped' : ''}`, item.text ? `“${truncate(item.text, 240)}”` : '(leeg)')
    );
    if (item.rewrite) {
      const box = el('div', 'opt-new');
      const boxHead = el('div', 'opt-new-head');
      boxHead.append(el('p', 'opt-label', 'Nieuwe versie'), prov('claude', 'voorstel · Claude'), copyButton(() => item.rewrite));
      box.append(boxHead, el('p', 'opt-new-text', `“${item.rewrite}”`));
      content.append(box);
    }
    row.append(name, content);
    list.append(row);
  });
  body.append(list);
  body.append(el('p', 'note', 'De rest van de pagina mag variëren tussen het focus zoekwoord, de secondary en de varianten; herhaal het exacte zoekwoord niet onnodig.'));
  return wrapper;
}

// --- 5 Aanbevelingen ----------------------------------------------------------------------

function aanbevelingenCard(report) {
  const { wrapper, body } = reportSection({
    id: 'sec-aanbevelingen',
    num: '5',
    title: 'Aanbevelingen voor de pagina',
    sub: 'Onderwerpen die minstens twee concurrenten behandelen, met hun letterlijke koppen als SERP-evidence.',
    provNode: prov('claude', 'onderwerpen gegroepeerd door Claude, koppen gecontroleerd'),
  });
  body.append(gapSummary(report));

  const topics = rsub('Onderwerpen en koppen', { num: '5.1', rule: true });
  if (!report.missingTopics.length && !report.partialTopics.length) {
    topics.append(emptyNote('Geen ontbrekende onderwerpen gevonden. De pagina dekt alles wat meerdere concurrenten behandelen.'));
  } else {
    // Dezelfde nummering als de markdown: eerst wat ontbreekt, dan wat een eigen kop mist.
    const list = el('div', 'rec-list');
    let counter = 1;
    report.missingTopics.forEach((topic) => list.append(recItem(topic, counter++, report, false)));
    if (report.partialTopics.length) {
      list.append(el('p', 'eyebrow', 'Staat al in de tekst, maar zonder eigen kop'));
      report.partialTopics.forEach((topic) => list.append(recItem(topic, counter++, report, true)));
    }
    topics.append(list);
  }
  body.append(topics);

  if (report.coveredTopics.length) {
    const done = rsub(`Al goed behandeld (${report.coveredTopics.length})`, { rule: true });
    done.append(doneList(report.coveredTopics.map((topic) => `${topic.heading} · ${share(topic.coveredBy, report)}`)));
    body.append(done);
  }
  return wrapper;
}

function gapSummary(report) {
  const { coverage, page } = report;
  const box = el('div', 'gap-summary');
  const parts = [
    ['gb-good', coverage.topicsWithHeading, 'met eigen kop'],
    ['gb-mid', coverage.topicsInTextOnly, 'alleen in de tekst'],
    ['gb-bad', coverage.topicsMissing, 'ontbreken'],
  ];
  if (coverage.topicsTotal > 0) {
    const bar = el('div', 'gapbar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${coverage.topicsTotal} onderwerpen: ${parts.map(([, count, text]) => `${count} ${text}`).join(', ')}`);
    parts.forEach(([className, count]) => {
      if (!count) return;
      const piece = el('span', className);
      piece.style.flexGrow = String(count);
      bar.append(piece);
    });
    box.append(bar);
  }
  const legend = el('ul', 'gb-legend');
  parts.forEach(([className, count, text]) => {
    const item = el('li');
    item.append(el('i', className), el('b', null, count), document.createTextNode(` ${text}`));
    legend.append(item);
  });
  box.append(legend);

  const stats = el('dl', 'mini-stats');
  const stat = (label, strong, rest) => {
    const row = el('div');
    row.append(el('dt', null, label));
    const value = el('dd');
    value.append(el('strong', null, strong), document.createTextNode(rest));
    row.append(value);
    stats.append(row);
  };
  const range = coverage.wordCountRange
    ? ` (spreiding ${coverage.wordCountRange[0].toLocaleString('nl-NL')} – ${coverage.wordCountRange[1].toLocaleString('nl-NL')})`
    : '';
  stat(
    'Woorden',
    page.wordCount.toLocaleString('nl-NL'),
    coverage.benchmarkWordCount ? ` op je pagina · mediaan top 10: ${coverage.benchmarkWordCount.toLocaleString('nl-NL')}${range}` : ' op je pagina'
  );
  stat('Semantische termen', `${coverage.termsPresent} van ${coverage.termsTotal}`, ' aanwezig');
  box.append(stats);
  return box;
}

/**
 * Eén aanbeveling in de vorm van het teamdocument. SERP-evidence is waarom het
 * onderwerp in de top terugkomt plus de letterlijke koppen; de gap is wat de code op
 * je eigen pagina mat; de aanbeveling is wat je toevoegt.
 */
function recItem(topic, number, report, inTextOnly) {
  const item = el('article', `rec${inTextOnly ? ' is-partial' : ''}`);
  item.id = `rec-${number}`;

  const head = el('div', 'rec-head');
  const num = el('span', 'rec-num hex', number);
  num.setAttribute('aria-hidden', 'true');
  const titles = el('div', 'min-w-0');
  const kicker = el('p', 'rec-kicker');
  const total = report.coverage.competitorsCompared;
  const usage = el('span', 'usage');
  const usageBar = el('span', 'usage-bar');
  usageBar.setAttribute('aria-hidden', 'true');
  const usageFill = el('span');
  usageFill.style.width = `${Math.round((topic.coveredBy / Math.max(total, 1)) * 100)}%`;
  usageBar.append(usageFill);
  usage.append(usageBar, document.createTextNode(`${share(topic.coveredBy, report)} concurrenten`));
  kicker.append(el('span', 'pill', topic.level), usage);
  const title = el('h5', 'rec-title');
  title.append(el('span', 'sr-only', `Aanbeveling ${number}: `), document.createTextNode(topic.heading));
  titles.append(kicker, title);
  head.append(num, titles, iconCopy(() => topicMarkdown(topic), `kopieer aanbeveling ${number}`));
  item.append(head);

  const rows = el('dl', 'rec-rows');
  const row = (label, nodes) => {
    const wrap = el('div', 'rec-row');
    const dd = el('dd');
    nodes.filter(Boolean).forEach((node) => dd.append(node));
    wrap.append(el('dt', null, label), dd);
    rows.append(wrap);
  };

  const evidence = el('ul', 'evidence');
  topic.sources.forEach((source) => {
    const li = el('li');
    const text = el('span');
    text.append(el('span', 'ev-domain', source.domain), el('span', 'ev-heading', `“${source.heading}”`));
    li.append(posChips([source.position], report), text);
    evidence.append(li);
  });
  row('SERP-evidence', [topic.why ? el('p', null, topic.why) : null, evidence]);
  row('Gap', [inTextOnly
    ? statusTag('mid', 'staat in de tekst, maar zonder eigen kop')
    : statusTag('bad', 'ontbreekt op de pagina: geen kop en niet in de tekst')]);

  const advice = [];
  if (topic.advice) advice.push(el('p', null, topic.advice));
  if (topic.subheadings.length) {
    const subs = el('ul', 'h3-list');
    topic.subheadings.forEach((sub) => {
      const li = el('li');
      li.append(el('span', 'pill', 'H3'), el('span', null, sub));
      subs.append(li);
    });
    advice.push(subs);
  }
  if (advice.length) row('Aanbeveling', advice);
  item.append(rows);
  return item;
}

// --- 5.2 Termen en 5.3 Vragen -------------------------------------------------------------

function termenCard(report) {
  const total = report.coverage.competitorsCompared;
  const { wrapper, body } = reportSection({
    id: 'sec-termen',
    num: '5.2',
    title: 'Semantische termen',
    sub: 'Termen die meerdere concurrenten gebruiken en die niet op je pagina staan.',
    variant: 'is-sub',
  });

  if (!report.missingTerms.length) {
    body.append(emptyNote('Alle gevonden termen staan al op de pagina.'));
  } else {
    const table = el('table', 'data-table is-fixed no-zebra term-table');
    table.append(el('caption', 'sr-only', 'Semantische termen die op je pagina ontbreken'));
    const head = el('thead');
    const headRow = el('tr');
    const termHead = el('th', null, 'Term');
    termHead.scope = 'col';
    const countHead = el('th', 'num w-conc', 'Concurrenten');
    countHead.scope = 'col';
    headRow.append(termHead, countHead);
    head.append(headRow);
    table.append(head);

    const groups = [
      { label: 'Bij de meeste concurrenten', match: (term) => term.usedBy / total >= 0.5 },
      { label: 'Bij een deel van de concurrenten', match: (term) => term.usedBy / total < 0.5 },
    ];
    groups.forEach(({ label, match }) => {
      const group = report.missingTerms.filter(match);
      if (!group.length) return;
      const groupBody = el('tbody');
      const groupRow = el('tr', 'group-row');
      const cell = el('th');
      cell.scope = 'rowgroup';
      cell.colSpan = 2;
      const inner = el('div', 'group-row-inner');
      const name = el('span', null, label);
      name.append(el('span', 'group-count', group.length));
      inner.append(name, copyButton(() => group.map((term) => term.term).join('\n'), 'kopieer termen'));
      cell.append(inner);
      groupRow.append(cell);
      groupBody.append(groupRow);

      group.forEach((term) => {
        const row = el('tr');
        const termCell = el('td');
        termCell.append(el('span', 'cell-main', term.term));
        if (term.context) termCell.append(el('span', 'cell-sub', term.context));
        const count = el('td', 'num');
        const usage = el('span', 'usage');
        const bar = el('span', 'usage-bar');
        bar.setAttribute('aria-hidden', 'true');
        const fill = el('span');
        fill.style.width = `${Math.round((term.usedBy / Math.max(total, 1)) * 100)}%`;
        bar.append(fill);
        usage.append(bar, document.createTextNode(`${term.usedBy}/${total}`));
        count.append(usage);
        row.append(termCell, count);
        groupBody.append(row);
      });
      table.append(groupBody);
    });
    const wrap = el('div', 'table-wrap');
    wrap.append(table);
    body.append(wrap);
    body.append(el('p', 'note', `Telling: gemeten bij ${total} concurrenten. Toelichting per term: interpretatie van Claude.`));
  }

  if (report.presentTerms.length) {
    const done = rsub(`Staat er al (${report.presentTerms.length})`, { rule: true });
    done.append(doneList(report.presentTerms.map((term) => `${term.term} · ${share(term.usedBy, report)}`)));
    body.append(done);
  }
  return wrapper;
}

/** Waar een vraag vandaan komt: Google zelf, of de kop van een concurrent (met positie). */
function questionOrigin(item, report) {
  const line = el('span');
  if (item.source === 'Mensen vragen ook') {
    line.textContent = 'Bron: Google · Mensen vragen ook';
    return line;
  }
  line.append(document.createTextNode('Bron: kop bij '));
  if (item.position) line.append(posChips([item.position], report), document.createTextNode(' '));
  line.append(document.createTextNode(domainFromUrl(item.from)));
  return line;
}

function vragenCard(report) {
  const fromGoogle = report.serp.peopleAlsoAsk > 0;
  const { wrapper, body } = reportSection({
    id: 'sec-vragen',
    num: '5.3',
    title: fromGoogle ? 'Mensen vragen ook' : 'Vragen uit de top 10',
    sub: fromGoogle ? 'Echte vragen uit Google en uit de koppen van concurrenten.' : 'Vraagkoppen die concurrenten gebruiken.',
    provNode: prov('claude', 'invalshoek per vraag: interpretatie · Claude'),
    variant: 'is-sub',
  });

  if (!fromGoogle) {
    body.append(el('p', 'note', 'Google toont voor dit zoekwoord geen "Mensen vragen ook"-blok. Deze vragen komen daarom alleen uit de koppen van concurrenten.'));
  }
  const open = report.questions.filter((item) => item.status !== 'kop');
  const answered = report.questions.filter((item) => item.status === 'kop');
  if (!report.questions.length) {
    body.append(emptyNote('Er zijn geen vragen gevonden: geen "Mensen vragen ook"-blok en geen vraagkoppen bij concurrenten.'));
  } else if (!open.length) {
    body.append(emptyNote('De pagina beantwoordt alle gevonden vragen al met een eigen kop.'));
  }

  if (open.length) {
    // Eerst wat ontbreekt, dan wat er al staat maar niet als vraag.
    const ordered = [...open.filter((item) => item.status !== 'tekst'), ...open.filter((item) => item.status === 'tekst')];
    const list = el('ul', 'q-list');
    ordered.forEach((item) => {
      const li = el('li', 'q-row');
      const content = el('div', 'min-w-0');
      const meta = el('p', 'q-meta');
      meta.append(
        item.status === 'tekst' ? statusTag('mid', 'staat er, maar niet als vraag') : statusTag('bad', 'ontbreekt'),
        questionOrigin(item, report)
      );
      content.append(meta, el('h4', 'q-text', item.question));
      if (item.angle) {
        const angle = el('p', 'q-angle');
        angle.append(el('b', null, 'Invalshoek:'), document.createTextNode(item.angle));
        content.append(angle);
      }
      li.append(content, iconCopy(() => `### ${item.question}\n\n${item.angle}`, 'kopieer vraag en invalshoek'));
      list.append(li);
    });
    body.append(list);
  }

  if (answered.length) {
    const done = rsub(`Al beantwoord (${answered.length})`, { rule: true });
    done.append(doneList(answered.map((item) => `${item.question} · ${questionSource(item)}`)));
    body.append(done);
  }
  return wrapper;
}

// --- 6 Niet doen en 7 Samenvatting -----------------------------------------------------------

function nietDoenCard(report) {
  const { wrapper, body } = reportSection({
    id: 'sec-niet-doen',
    num: '6',
    title: 'Niet doen',
    sub: 'Wat concurrenten doen, maar niet bij deze pagina past.',
    provNode: prov('claude', PROV_TEXT.claude),
  });
  if (!report.avoid.length) {
    body.append(emptyNote('Geen specifieke valkuilen gezien bij de concurrenten.'));
    return wrapper;
  }
  const list = el('ul', 'avoid-list');
  report.avoid.forEach((item) => {
    const li = el('li');
    const iconBox = el('span', 'avoid-icon');
    iconBox.setAttribute('aria-hidden', 'true');
    iconBox.append(reportIcon('cross'));
    const content = el('div', 'min-w-0');
    content.append(el('p', 'avoid-text', item.text));
    const sources = el('p', 'avoid-src');
    sources.append(el('span', null, 'Gezien bij'));
    item.sources.forEach((source) => {
      const ref = el('span');
      ref.append(posChips([source.position], report), document.createTextNode(` ${source.domain}`));
      sources.append(ref);
    });
    content.append(sources);
    li.append(iconBox, content);
    list.append(li);
  });
  body.append(list);
  return wrapper;
}

function samenvattingCard(report) {
  const { wrapper, body } = reportSection({
    id: 'sec-samenvatting',
    num: '7',
    title: 'Samenvatting',
    sub: 'Interpretatie van Claude op basis van de gemeten data in dit rapport.',
    provNode: prov('claude', PROV_TEXT.claude),
  });
  body.append(el('p', 'summary-text', report.summary || 'Geen samenvatting beschikbaar.'));
  return wrapper;
}

// --- Geen match: 2 een beter zoekwoord zoeken ----------------------------------------------

/**
 * Kaart 2 bij geen match: het formulier, de bezig-staat of het resultaat van de
 * herfocus. Houdt id "refocus-card": scrollToRefocus springt ernaartoe.
 */
function refocusCard(report, options = {}) {
  const { wrapper, body } = reportSection({
    id: 'refocus-card',
    num: '2',
    title: 'Focus keyword: een beter zoekwoord zoeken',
    sub: report.nextStep === 'refocus'
      ? `Ronde ${report.origin.round + 1} van ${report.maxRounds}`
      : `Limiet van ${report.maxRounds} rondes bereikt`,
  });
  wrapper.classList.add('scroll-mt-4');

  if (report.origin.previousKeyword) {
    body.append(emptyNote(`Ook "${report.keyword}" past niet bij de pagina (gekozen na "${report.origin.previousKeyword}").`));
  }

  const result = lastRefocus && lastRefocus.rejectedKeyword === report.keyword ? lastRefocus : null;
  const earlier = previousRoundOptions(report);

  if (options.refocusBusy) {
    if (options.panel) body.append(options.panel.node);
    else body.append(el('p', 'notice text-sm', 'Bezig met zoeken naar een passend zoekwoord. Dit duurt ongeveer een halve minuut.'));
  } else if (result) {
    body.append(refocusResult(result, report, { autoStart: options.autoStart }));
  } else if (report.nextStep === 'refocus') {
    if (options.refocusError) body.append(errorBox(options.refocusError));
    const form = refocusForm(report);
    form.classList.add('screen-only');
    body.append(form);
    // In de pdf geen leeg formulier, wel wat de volgende stap is.
    body.append(el('p', 'print-only verdict-note', `Nog geen nieuw focus keyword gekozen. Volgende stap: laad een Search Console-export van deze pagina in de tool, of laat de tool de rankende zoekwoorden via Ahrefs schatten (maximaal ${report.maxRounds} rondes).`));
  } else {
    body.append(el('p', 'notice notice-warn text-sm leading-6', `Na ${report.maxRounds} rondes is er nog geen zoekwoord gevonden dat bij de pagina past. ${
      earlier.length ? 'Kies zelf een alternatief hieronder, vul' : 'Vul'
    } een ander zoekwoord in, of pas de pagina aan zodat hij bij het zoekwoord past.`));
  }

  if (earlier.length && !options.refocusBusy && !result) {
    body.append(candidateList('Alternatieven uit de vorige ronde', earlier, null, report));
    body.append(details(`Bekijk de vorige herfocus (na "${lastRefocus.rejectedKeyword}")`, [refocusResult(lastRefocus, report, { done: true })]));
  }

  body.append(el('p', 'note', 'Mapping, optimalisatie, aanbevelingen, niet doen en samenvatting volgen zodra er een focus keyword is dat bij de pagina past.'));
  return wrapper;
}

// --- B Bronnen en methode -----------------------------------------------------------------

function bronnenCard(report) {
  const { serp, gsc, keywordInfo } = report;
  const region = regionOf(report);
  const { wrapper, body } = reportSection({
    id: 'sec-bronnen',
    num: 'B',
    title: 'Bronnen en methode',
    variant: 'is-appendix',
  });

  const pages = rsub('Vergeleken pagina’s');
  pages.append(el('p', 'note', `${serp.provider} · opgehaald ${formatDate(report.generatedAt, { time: true })}`));
  pages.append(serpTable(report));
  const legend = el('p', 'serp-legend');
  legend.append(
    statusTag('good', 'vergeleken'),
    statusTag('bad', 'mislukt (de reden staat bij de pagina)'),
    statusTag('muted', 'overgeslagen'),
    statusTag('info', 'jouw pagina')
  );
  pages.append(legend);
  body.append(pages);

  const vergeleken = serp.results.filter((result) => result.status === 'vergeleken').length;
  const gscValue = gsc?.status === 'ok'
    ? `gekoppeld · ${gscWhen(gsc, report)}`
    : gsc ? GSC_REASONS[gsc.status] || 'niet gebruikt in dit rapport' : 'niet gebruikt in dit rapport';
  const sources = rsub('Databronnen', { rule: true });
  sources.append(factsList([
    { label: 'SERP', value: serp.provider, provNode: prov('serp', PROV_TEXT.serp(report)) },
    usesAhrefs(report) && { label: 'Zoekvolumes', value: `Ahrefs, schatting voor Google ${region.label}`, provNode: prov('schatting', PROV_TEXT.ahrefs(region)) },
    {
      label: 'Search Console',
      value: gscValue,
      provNode: gsc?.status === 'ok' ? prov('meting', PROV_TEXT.gsc) : null,
      sub: gsc?.status === 'ok' ? gsc.message : '',
    },
    { label: 'Regio', value: `Google ${region.label} · teksten in het ${region.language}; uitleg in het Nederlands` },
    { label: 'Vergeleken', value: `${vergeleken} concurrenten (van ${serp.results.length} resultaten)` },
    report.quality && {
      label: 'Gecontroleerd',
      value: `${report.quality.droppedTopics ?? 0} onderwerpen en ${report.quality.droppedMapping ?? 0} mapping-zoekwoorden weggelaten omdat het bewijs ontbrak`,
    },
    report.factCheck && { label: 'Cijfercontrole', value: factCheckText(report.factCheck) },
  ]));
  body.append(sources);

  const method = rsub('Methode', { rule: true });
  method.append(el('p', 'note', report.disclaimer || 'Het oordeel over de zoekintentie is een interpretatie van Claude op basis van de gemeten data in dit rapport.'));
  method.append(legendLine(report, { label: false }));
  body.append(method);
  return wrapper;
}

/**
 * Wat de feitencontrole deed (lib/facts.js): elk cijfer in de tekst van Claude is
 * vergeleken met de data die Claude kreeg. Ook "niets weggelaten" is informatie.
 */
function factCheckText(factCheck) {
  if (!factCheck.removed) return 'elk cijfer in de tekst van Claude staat in de meegestuurde data van Search Console, Ahrefs of de pagina’s';
  const numbers = factCheck.numbers?.length ? ` (${factCheck.numbers.join(', ')})` : '';
  return `${factCheck.removed} ${factCheck.removed === 1 ? 'zin' : 'zinnen'} van Claude weggelaten met een cijfer dat niet in de meegestuurde data stond${numbers}`;
}

/** De top 10 waarmee vergeleken is. Waar een kolom wegvalt, staat de inhoud onder de titel. */
function serpTable(report) {
  const { serp } = report;
  const hasTypes = serp.results.some((result) => result.pageTypeLabel || result.topKeyword);
  const table = el('table', 'data-table is-fixed serp-table');
  table.append(el('caption', 'sr-only', 'De Google-top 10 waarmee vergeleken is'));
  const head = el('thead');
  const headRow = el('tr');
  const th = (label, className, sub) => {
    const cell = el('th', className || null);
    cell.scope = 'col';
    if (label) cell.append(document.createTextNode(label));
    if (sub) {
      const subLine = el('span', 'th-sub');
      subLine.append(sub);
      cell.append(subLine);
    }
    return cell;
  };
  const statusHead = th('', 'w-icon');
  statusHead.append(el('span', 'sr-only', 'Status'));
  headRow.append(th('#', 'w-pos'), statusHead, th('Pagina'));
  if (hasTypes) {
    headRow.append(
      th('Paginatype', 'cq-l w-type', prov('serp', PROV_TEXT.serp(report))),
      th('Topzoekwoord', 'cq-m w-top', 'volume: schatting'),
      th('Woorden', 'cq-l num w-words', 'meting')
    );
  } else {
    headRow.append(th('Woorden', 'cq-m num w-words', 'meting'), th('Koppen', 'cq-l num w-words', 'meting'));
  }
  head.append(headRow);
  table.append(head);

  const body = el('tbody');
  serp.results.forEach((result) => {
    const own = result.status === 'jouw pagina' || result.position === serp.targetPosition;
    const row = el('tr', own ? 'is-own' : null);
    row.append(el('td', 'num', result.position));
    const status = SERP_STATUS[result.status] || { tone: 'muted', text: result.status };
    const statusCell = el('td');
    statusCell.append(statusTag(status.tone, status.text, { iconOnly: true }));
    row.append(statusCell);

    const page = el('td');
    const link = el('a', 'serp-title', result.title || result.domain);
    link.href = result.url;
    link.target = '_blank';
    link.rel = 'noopener';
    page.append(link, el('span', 'cell-sub', result.domain));
    if (result.reason) page.append(el('span', 'cell-sub', result.reason));
    const words = result.wordCount != null ? `${result.wordCount.toLocaleString('nl-NL')} woorden` : '';
    if (hasTypes) {
      const narrow = [result.pageTypeLabel, words].filter(Boolean).join(' · ');
      if (narrow) page.append(el('span', 'cell-sub cq-until-l', narrow));
      if (result.topKeyword) {
        page.append(el('span', 'cell-sub cq-until-m', `top: ${result.topKeyword}${typeof result.topKeywordVolume === 'number' ? ` (${fmt(result.topKeywordVolume)}/mnd)` : ''}`));
      }
      row.append(page, el('td', 'cq-l', result.pageTypeLabel || '—'));
      const top = el('td', 'cq-m');
      if (result.topKeyword) {
        top.append(el('span', null, result.topKeyword));
        if (typeof result.topKeywordVolume === 'number') top.append(el('span', 'cell-sub is-volume', `${fmt(result.topKeywordVolume)}/mnd`));
      } else {
        top.textContent = '—';
      }
      row.append(top, el('td', 'cq-l num', result.wordCount != null ? result.wordCount.toLocaleString('nl-NL') : '—'));
    } else {
      if (words) page.append(el('span', 'cell-sub cq-until-m', words));
      row.append(
        page,
        el('td', 'cq-m num', result.wordCount != null ? result.wordCount.toLocaleString('nl-NL') : '—'),
        el('td', 'cq-l num', result.headingCount ?? '—')
      );
    }
    body.append(row);
  });
  table.append(body);
  const wrap = el('div', 'table-wrap');
  wrap.append(table);
  return wrap;
}

// --- Het einde: delen ----------------------------------------------------------------------

function reportEnd(report) {
  const end = el('section', 'rsec report-end screen-only');
  end.setAttribute('aria-label', 'Rapport delen');
  const text = el('div');
  text.append(el('p', 'rsub-title', 'Rapport delen'), el('p', 'report-end-hint', 'Je browser opent het afdrukvenster: kies daar ‘Opslaan als PDF’.'));
  const buttons = el('div', 'report-end-actions');
  buttons.append(copyButton(() => toMarkdown(report), 'kopieer markdown', 'btn btn-quiet btn-sm relative'), pdfButton(report));
  end.append(text, buttons);
  return end;
}
