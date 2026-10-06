/**
 * Keyword Focus & Intent Check — chat over het rapport
 *
 * Na een analyse stelt de marketeer hier vragen over de keuzes in het rapport, geeft
 * er kritiek op of laat teksten herschrijven (POST /api/chat). De server bewaart niets:
 * bij elke vraag gaan het rapport, de eerdere beurten en de nieuwe vraag mee. Een
 * gesprek hoort bij één rapport; een nieuw rapport begint een nieuw gesprek.
 *
 * Op desktop staat de chat in de linkerkolom, naast het rapport, op de plek van het
 * formulier. Op een telefoon of tablet is hij een scherm over de hele pagina.
 *
 * Antwoorden zijn door een model geschreven en citeren vreemde websites: alles gaat via
 * textContent in de DOM. renderChatText() maakt van een beetje opmaak (alinea's,
 * lijstjes, **vet**) elementen, nooit HTML uit de tekst zelf.
 *
 * Gebruikt de helpers uit app.js (el, copyButton, fmt, storageGet, requestError, ...) en
 * report.js (prov, statusTag). Dit bestand laadt eerder, maar de functies draaien pas
 * als alles er is.
 */

const chatPanel = document.getElementById('chat-panel');
const chatColumn = document.getElementById('input-column');
const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
const chatSendLabel = document.getElementById('chat-send-label');
const chatSpinner = document.getElementById('chat-spinner');
const chatHint = document.getElementById('chat-hint');
const chatCount = document.getElementById('chat-count');
const chatSubject = document.getElementById('chat-subject');
const chatResetBtn = document.getElementById('chat-reset');
const chatCloseBtn = document.getElementById('chat-close');

const CHAT_STORAGE = 'focus-chat';
const CHAT_HINT = chatHint.textContent;

/** Dezelfde grenzen als lib/chat.js. De server is de bron; dit voorkomt een vraag die toch zou mislukken. */
const CHAT_MAX_TURNS = 20;
const CHAT_MAX_CHARS = 4000;
const CHAT_MAX_TEXTS = 8;
const CHAT_MAX_TEXT_CHARS = 6000;
/** Vanaf hier telt de hint mee, zodat de grens geen verrassing is. */
const CHAT_COUNT_FROM = 3500;

/** Op desktop staat de chat naast het rapport; kleiner is hij een scherm over de hele pagina. */
const chatWide = window.matchMedia('(min-width: 1024px)');

/** Op een touchscreen is Enter een nieuwe regel, zoals in elke chat-app; versturen gaat met de knop. */
const chatTouch = window.matchMedia('(pointer: coarse)');

function defaultChatHint() {
  return chatTouch.matches ? 'Tik op verstuur als je vraag klaar is.' : CHAT_HINT;
}

/** Om mee te beginnen; kleine letters, want het zijn knoppen. Een klik stelt de vraag meteen. */
const CHAT_STARTERS = {
  compleet: [
    'waarom deze secondary keywords?',
    'herschrijf de meta description',
    'welke aanbeveling zou jij als eerste oppakken?',
    'wat is het zwakst onderbouwd in dit rapport?',
  ],
  intent: [
    'waarom past deze pagina niet bij het zoekwoord?',
    'wat voor pagina verwacht de zoeker hier?',
    'hoe zeker is dit oordeel?',
    'welk soort zoekwoord zou wél passen?',
  ],
};

/** Hoe de code het focus zoekwoord in een voorgestelde tekst aantrof (phraseCoverage in lib/text.js). */
const CHAT_KEYWORD_STATUS = {
  letterlijk: { tone: 'good', text: 'focus zoekwoord letterlijk' },
  los: { tone: 'mid', text: 'woorden van het zoekwoord los' },
  ontbreekt: { tone: 'bad', text: 'zonder focus zoekwoord' },
};
/** Op deze plekken hoort het zoekwoord (lib/chat.js); bij een kop of alinea is het een keuze. */
const CHAT_KEYWORD_PLACES = new Set(['h1', 'title', 'metaDescription', 'intro']);

const CHAT_ICON = '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16v12H10l-6 4z"/></svg>';

/** Het rapport in beeld, of null: tijdens een fout of na "alles wissen" is er niets om over te praten. */
let chatReport = null;
/** Het gesprek bij dat rapport. Een bericht: { role: 'user'|'assistant', text, teksten?, factCheck?, failed? }. */
let chatState = { id: null, messages: [] };
/** De vraag die loopt: { controller, id, startedAt }. Er loopt er altijd hooguit één. */
let chatRequest = null;
/** Er loopt een analyse: het rapport in beeld wordt zo vervangen. */
let chatPaused = false;
let chatReturnFocus = null;
let chatTypingTimer = null;
/**
 * Het element van elk bericht. Het gesprek wordt soms opnieuw getekend terwijl een vraag
 * loopt (de chat dicht en weer open): het antwoord zoekt zijn vraag dan hier op, niet in
 * een element dat al uit beeld is.
 */
const chatNodes = new WeakMap();

// --- Gesprek en opslag ---------------------------------------------------------------

/** Eén gesprek per rapport: dezelfde pagina en hetzelfde zoekwoord, maar een nieuwe analyse is een nieuw rapport. */
function chatIdFor(report) {
  return [report.page?.url || '', report.keyword || '', report.region || '', report.generatedAt || ''].join('|');
}

function validChatEntry(entry) {
  return (entry?.role === 'user' || entry?.role === 'assistant') && typeof entry.text === 'string';
}

/** Een vraag die nog liep toen de pagina herladen of gesloten werd: zonder antwoord, dus opnieuw te versturen. */
const CHAT_INTERRUPTED = {
  message: 'Het antwoord kwam niet binnen: de pagina werd herladen of gesloten terwijl de vraag liep. Verstuur hem opnieuw.',
  code: 'interrupted',
};

function loadChat(id) {
  try {
    const saved = JSON.parse(storageGet(CHAT_STORAGE) || 'null');
    if (saved?.id === id && Array.isArray(saved.messages)) {
      const messages = saved.messages.filter(validChatEntry);
      // Bij het laden loopt er voor dit gesprek geen vraag (attachChat breekt die eerst
      // af): een vraag zonder antwoord is dus onderweg verloren gegaan.
      messages.forEach((entry, index) => {
        if (entry.role === 'user' && !entry.failed && messages[index + 1]?.role !== 'assistant') entry.failed = { ...CHAT_INTERRUPTED };
      });
      return { id, messages };
    }
  } catch { /* ongeldige opslag negeren */ }
  return { id, messages: [] };
}

/** Het gesprek overleeft een refresh, net als het rapport. Alleen het laatste gesprek. */
function saveChat() {
  if (!chatState.id) return;
  storageSet(CHAT_STORAGE, JSON.stringify({ id: chatState.id, messages: chatState.messages.slice(-(CHAT_MAX_TURNS * 3)) }));
}

/** "alles wissen": ook het gesprek. */
function forgetChat() {
  abortChatRequest();
  chatState = { id: null, messages: [] };
  storageRemove(CHAT_STORAGE);
  renderChatLog();
}

/**
 * De afgeronde beurten voor de server: een vraag met direct daarna zijn antwoord. Een
 * mislukte vraag hoort er niet bij; die staat alleen in beeld, met "opnieuw versturen".
 */
function chatHistory() {
  const turns = [];
  const list = chatState.messages;
  for (let index = 0; index < list.length - 1; index += 1) {
    const question = list[index];
    const answer = list[index + 1];
    if (question.role === 'user' && !question.failed && answer.role === 'assistant') {
      turns.push(
        { role: 'user', text: question.text },
        { role: 'assistant', text: answer.text, teksten: (answer.teksten || []).map(({ plek, tekst }) => ({ plek, tekst })) }
      );
      index += 1;
    }
  }
  return turns;
}

function chatTurnCount() {
  return chatHistory().length / 2;
}

// --- Koppeling met het rapport (vanuit app.js) -----------------------------------------

/** Na elk getoond rapport (renderReport): vanaf nu gaat het gesprek over dit rapport. */
function attachChat(report) {
  const id = chatIdFor(report);
  chatReport = report;
  if (chatState.id !== id) {
    const hadConversation = chatState.messages.length > 0;
    abortChatRequest();
    chatState = loadChat(id);
    renderChatLog({
      notice: hadConversation && !chatState.messages.length
        ? `Nieuw rapport voor ‘${report.keyword}’: het gesprek begint opnieuw.`
        : '',
    });
  }
  updateChatState();
}

/**
 * Er staat geen rapport (meer) in beeld: een fout, een nieuwe analyse die begint, of
 * alles gewist. Het gesprek blijft bewaard: komt hetzelfde rapport terug ("terug naar
 * het vorige resultaat"), dan gaat het gewoon verder.
 */
function detachChat({ close = false } = {}) {
  chatReport = null;
  if (close) closeChat();
  updateChatState();
}

/** Tijdens een analyse of herfocus (setLoading): het rapport in beeld wordt zo vervangen. */
function pauseChat(paused) {
  chatPaused = Boolean(paused);
  updateChatState();
}

// --- Openen en sluiten ---------------------------------------------------------------

function openChat() {
  if (!chatReport) return;
  if (chatPanel.hidden) {
    chatReturnFocus = document.activeElement;
    chatPanel.hidden = false;
    chatColumn.classList.add('is-chat');
    renderChatLog();
  }
  setChatSheet();
  updateChatState();
  // De focus hoort in de chat, ook als er niet getypt kan worden (er loopt een analyse).
  (chatInput.disabled ? chatCloseBtn : chatInput).focus({ preventScroll: true });
}

/**
 * Na een startvraag of "opnieuw versturen" is de knop weg, en daarmee de focus. Op een
 * toetsenbord terug naar het invoerveld; op een touchscreen naar het gesprek, zodat het
 * toetsenbord niet over het antwoord schuift.
 */
function keepChatFocus() {
  if (chatPanel.hidden || chatPanel.contains(document.activeElement)) return;
  (chatTouch.matches || chatInput.disabled ? chatLog : chatInput).focus({ preventScroll: true });
}

function closeChat() {
  if (chatPanel.hidden) return;
  chatPanel.hidden = true;
  chatColumn.classList.remove('is-chat');
  setChatSheet();
  updateChatState();
  // Terug naar waar de marketeer was; was dat niets (Safari geeft een aangeklikte knop
  // geen focus) of is het weg (het rapport is opnieuw getekend), dan naar de chatknop.
  const usable = chatReturnFocus && chatReturnFocus !== document.body && document.contains(chatReturnFocus) && !chatPanel.contains(chatReturnFocus);
  const target = usable ? chatReturnFocus : document.querySelector('[data-chat-open]');
  target?.focus?.({ preventScroll: true });
  chatReturnFocus = null;
}

/**
 * Op een telefoon of tablet ligt de chat als scherm over de pagina: de rest is dan niet
 * te bedienen en scrolt niet mee. Op desktop staat hij gewoon naast het rapport.
 */
function setChatSheet() {
  const sheet = !chatPanel.hidden && !chatWide.matches;
  document.documentElement.classList.toggle('chat-sheet-open', sheet);
  if (sheet) {
    chatPanel.setAttribute('role', 'dialog');
    chatPanel.setAttribute('aria-modal', 'true');
  } else {
    chatPanel.removeAttribute('role');
    chatPanel.removeAttribute('aria-modal');
  }
  const outside = [
    document.querySelector('body > .topbar'),
    document.querySelector('body > header'),
    document.getElementById('analyze-form'),
    document.getElementById('result-card')?.parentElement,
  ];
  outside.forEach((node) => node?.toggleAttribute('inert', sheet));
}

chatWide.addEventListener('change', setChatSheet);
chatCloseBtn.addEventListener('click', closeChat);
// Op het hele document: ook als de focus net nergens is (een verdwenen knop), sluit
// Escape het scherm. Niet als het wachtwoordscherm erboven ligt.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !document.documentElement.classList.contains('chat-sheet-open')) return;
  if (!passwordOverlay.classList.contains('hidden')) return;
  event.preventDefault();
  closeChat();
});

/** "nieuw gesprek": ook als er net geen rapport in beeld is, hoort het lege gesprek bij hetzelfde rapport. */
function resetChat() {
  if (chatState.messages.length && !confirm('Dit gesprek wissen en opnieuw beginnen? Het rapport blijft staan.')) return;
  abortChatRequest();
  chatState = { id: chatState.id || (chatReport ? chatIdFor(chatReport) : null), messages: [] };
  saveChat();
  renderChatLog();
  updateChatState();
  (chatInput.disabled ? chatCloseBtn : chatInput).focus({ preventScroll: true });
}

chatResetBtn.addEventListener('click', resetChat);

/** De knop in de kaartkop van het rapport: opent de chat, of zet de cursor erin als hij al open is. */
function chatButton() {
  const button = el('button', 'btn btn-outline btn-sm');
  button.type = 'button';
  button.innerHTML = CHAT_ICON;
  button.append(el('span', null, 'stel een vraag'));
  button.dataset.chatOpen = '';
  button.setAttribute('aria-controls', 'chat-panel');
  button.setAttribute('aria-expanded', String(!chatPanel.hidden));
  button.title = 'Vraag Pure Minds AI naar de keuzes in dit rapport, of laat een tekst herschrijven.';
  button.addEventListener('click', openChat);
  return button;
}

/** Onderaan het rapport: wie het rapport uit heeft, kan meteen doorvragen. Alleen op het scherm. */
function chatEnd() {
  const end = el('section', 'rsec report-end chat-end screen-only');
  end.setAttribute('aria-label', 'Vragen over dit rapport');
  const text = el('div');
  text.append(
    el('p', 'rsub-title', 'Vragen of kritiek?'),
    el('p', 'report-end-hint', 'Vraag Pure Minds AI waarom de tool iets adviseert, geef kritiek, of laat een tekst herschrijven. Het antwoord steunt alleen op dit rapport.')
  );
  end.append(text, chatButton());
  return end;
}

// --- Het gesprek in beeld ------------------------------------------------------------------

function updateChatState() {
  const full = chatTurnCount() >= CHAT_MAX_TURNS;
  const busy = Boolean(chatRequest);
  const available = Boolean(chatReport) && !chatPaused;
  // Typen mag terwijl een antwoord binnenkomt; versturen pas als het er is.
  chatInput.disabled = !available || full;
  chatSend.disabled = !available || full || busy || !chatInput.value.trim();
  chatResetBtn.disabled = !chatState.messages.length && !busy;

  // De hint wordt voorgelezen (aria-live): alleen een andere toestand verandert hem. De
  // teller ernaast loopt mee met elke toets en wordt daarom niet voorgelezen.
  let hint = defaultChatHint();
  let tone = '';
  const length = chatInput.value.length;
  if (chatPaused) hint = 'Er loopt een nieuwe analyse. Zodra het rapport binnen is, kun je erover chatten.';
  else if (!chatReport) hint = 'Er staat geen rapport in beeld. Maak eerst een analyse, of ga terug naar het vorige resultaat.';
  else if (full) [hint, tone] = [`Dit gesprek heeft het maximum van ${CHAT_MAX_TURNS} vragen bereikt. Begin een nieuw gesprek.`, 'is-warn'];
  else if (length >= CHAT_MAX_CHARS) [hint, tone] = [`Je vraag is ${fmt(CHAT_MAX_CHARS)} tekens: langer kan niet.`, 'is-warn'];
  else if (length >= CHAT_COUNT_FROM) hint = `Je vraag nadert de grens van ${fmt(CHAT_MAX_CHARS)} tekens.`;
  if (chatHint.textContent !== hint) chatHint.textContent = hint;
  chatHint.className = `chat-hint${tone ? ` ${tone}` : ''}`;
  chatCount.textContent = available && length >= CHAT_COUNT_FROM ? `${fmt(length)} / ${fmt(CHAT_MAX_CHARS)}` : '';
  chatLog.querySelectorAll('.chat-retry').forEach((button) => { button.disabled = busy || !available; });

  chatSubject.textContent = chatReport
    ? [`‘${chatReport.keyword}’`, domainFromUrl(chatReport.page?.url)].filter(Boolean).join(' · ')
    : 'geen rapport in beeld';
  document.querySelectorAll('[data-chat-open]').forEach((button) => {
    button.setAttribute('aria-expanded', String(!chatPanel.hidden));
  });
}

function setChatBusy(busy) {
  chatSend.setAttribute('aria-busy', String(busy));
  chatSpinner.classList.toggle('hidden', !busy);
  chatSendLabel.textContent = busy ? 'denkt na…' : 'verstuur';
  updateChatState();
}

/** Alles opnieuw tekenen: bij openen, een ander rapport of een nieuw gesprek. Zonder dat een screenreader alles opnieuw voorleest. */
function renderChatLog({ notice = '' } = {}) {
  chatLog.setAttribute('aria-live', 'off');
  chatLog.replaceChildren();
  if (notice) chatLog.append(chatNotice(notice));
  if (!chatState.messages.length) chatLog.append(chatIntro());
  chatState.messages.forEach((entry) => chatLog.append(chatMessageNode(entry)));
  if (chatRequest && chatRequest.id === chatState.id) chatLog.append(chatTypingNode(chatRequest.startedAt));
  requestAnimationFrame(() => {
    chatLog.setAttribute('aria-live', 'polite');
    chatLog.scrollTop = chatLog.scrollHeight;
  });
}

function chatNotice(text) {
  const note = el('p', 'chat-notice', text);
  note.setAttribute('role', 'status');
  return note;
}

function chatIntro() {
  const box = el('div', 'chat-intro');
  box.append(
    el('p', 'chat-intro-title', 'Vraag door op dit rapport.'),
    el('p', 'chat-intro-text', 'Vraag waarom de tool iets adviseert, geef kritiek, of laat een tekst herschrijven. Pure Minds AI kent alleen dit rapport en wat jij hier schrijft. Een zin met een cijfer dat daar niet in staat, haalt de tool uit het antwoord.')
  );
  const starters = el('div', 'chat-starters');
  (CHAT_STARTERS[chatReport?.stage] || CHAT_STARTERS.compleet).forEach((text) => {
    const button = el('button', 'btn btn-quiet btn-xs btn-wrap', text);
    button.type = 'button';
    button.addEventListener('click', () => sendChatMessage(`${text.charAt(0).toUpperCase()}${text.slice(1)}`));
    starters.append(button);
  });
  box.append(starters);
  return box;
}

function chatMessageNode(entry) {
  return entry.role === 'user' ? chatQuestionNode(entry) : chatAnswerNode(entry);
}

function chatQuestionNode(entry) {
  const node = el('div', 'chat-msg');
  node.dataset.role = 'user';
  node.append(el('p', 'chat-who', 'jij'), el('p', 'chat-bubble', entry.text));
  if (entry.failed) {
    node.classList.add('is-failed');
    const error = el('div', 'notice notice-error chat-error');
    error.setAttribute('role', 'alert');
    error.append(el('p', 'notice-title', 'Deze vraag kwam niet aan.'), el('p', 'chat-error-text', entry.failed.message || 'Onbekende fout.'));
    // Is het gesprek te lang, dan helpt opnieuw versturen niet: alleen een nieuw gesprek.
    const tooLong = entry.failed.code === 'chat_too_long';
    const action = el('button', `btn btn-outline btn-xs${tooLong ? '' : ' chat-retry'}`, tooLong ? 'nieuw gesprek' : 'opnieuw versturen');
    action.type = 'button';
    action.disabled = !tooLong && (Boolean(chatRequest) || !chatReport || chatPaused);
    action.addEventListener('click', () => (tooLong ? resetChat() : retryChatMessage(entry)));
    error.append(action);
    node.append(error);
  }
  chatNodes.set(entry, node);
  return node;
}

function chatAnswerNode(entry) {
  const node = el('article', 'chat-msg');
  node.dataset.role = 'assistant';
  node.append(el('p', 'chat-who', 'pure minds ai'));
  if (entry.text) {
    const rich = el('div', 'chat-rich');
    rich.append(renderChatText(entry.text));
    node.append(rich);
  }
  (entry.teksten || []).forEach((item) => node.append(chatSuggestion(item)));

  const foot = el('div', 'chat-foot');
  foot.append(prov('claude', 'interpretatie · Claude, cijfers gecontroleerd'));
  chatCheckNotes(entry).forEach((text) => foot.append(el('span', 'chat-check', text)));
  foot.append(copyButton(() => chatAnswerMarkdown(entry), 'kopieer antwoord'));
  node.append(foot);
  chatNodes.set(entry, node);
  return node;
}

/**
 * Wat de controle uit het antwoord haalde, zoals de bijlage van het rapport dat zegt:
 * zinnen en hele voorgestelde teksten apart, en voorstellen boven de grens als telling.
 */
function chatCheckNotes(entry) {
  const notes = [];
  const check = entry.factCheck;
  if (check?.removed) {
    // Oudere antwoorden in de opslag kennen alleen het totaal: dat waren zinnen.
    const texts = check.teksten || 0;
    const sentences = check.zinnen ?? check.removed - texts;
    const parts = [
      sentences > 0 && `${sentences} ${sentences === 1 ? 'zin' : 'zinnen'}`,
      texts > 0 && `${texts} voorgestelde ${texts === 1 ? 'tekst' : 'teksten'}`,
    ].filter(Boolean);
    const numbers = check.numbers?.length ? ` (${check.numbers.join(', ')})` : '';
    notes.push(`${parts.join(' en ')} weggelaten met een cijfer dat niet in het rapport of het gesprek staat${numbers}`);
  }
  if (entry.skipped > 0) {
    const count = entry.skipped;
    notes.push(`${count} voorgestelde ${count === 1 ? 'tekst' : 'teksten'} niet getoond: meer dan ${CHAT_MAX_TEXTS} in één antwoord, of langer dan ${fmt(CHAT_MAX_TEXT_CHARS)} tekens. Vraag ${count === 1 ? 'hem' : 'ze'} in een volgende vraag.`);
  }
  return notes;
}

/**
 * Een voorgestelde tekst: los te kopiëren, met wat de code eraan mat. De lengte en het
 * zoekwoord komen van de server (measureChatText), niet van Claude.
 */
function chatSuggestion(item) {
  const box = el('div', 'chat-text');
  const head = el('div', 'chat-text-head');
  head.append(el('p', 'chat-text-label', item.label || 'Tekst'), prov('claude', 'voorstel · Claude'), copyButton(() => item.tekst));
  box.append(head, el('p', 'chat-text-body', item.tekst));
  if (item.meting) {
    const meta = el('div', 'chat-text-meta');
    meta.append(prov('meting', `${fmt(item.meting.tekens)} tekens · gemeten door de tool`));
    const status = CHAT_KEYWORD_STATUS[item.meting.zoekwoord];
    if (status) {
      // Een kop of alinea zonder het zoekwoord is geen fout: daar is het een keuze.
      const tone = status.tone === 'bad' && !CHAT_KEYWORD_PLACES.has(item.plek) ? 'muted' : status.tone;
      meta.append(statusTag(tone, status.text));
    }
    box.append(meta);
  }
  if (item.waarom) box.append(el('p', 'chat-text-why', item.waarom));
  return box;
}

function chatTypingNode(startedAt) {
  const node = el('div', 'chat-msg chat-typing');
  node.dataset.role = 'assistant';
  const line = el('p', 'chat-typing-line');
  const dots = el('span', 'chat-dots');
  dots.setAttribute('aria-hidden', 'true');
  dots.append(el('i'), el('i'), el('i'));
  const time = el('span', 'chat-typing-time');
  time.setAttribute('aria-hidden', 'true');
  line.append(dots, el('span', null, 'Pure Minds AI denkt na…'), time);
  node.append(el('p', 'chat-who', 'pure minds ai'), line);
  const tick = () => { time.textContent = formatDuration(Date.now() - startedAt); };
  tick();
  clearInterval(chatTypingTimer);
  chatTypingTimer = setInterval(tick, 1000);
  return node;
}

/** Het antwoord en de voorgestelde teksten als markdown, voor een document of een briefing. */
function chatAnswerMarkdown(entry) {
  const lines = [entry.text];
  (entry.teksten || []).forEach((item) => lines.push('', `**${item.label || 'Tekst'}:** ${item.tekst}`));
  return lines.join('\n').trim();
}

/**
 * Een beetje opmaak uit een antwoord: alinea's, lijstjes met "- " of "1. ", koppen met
 * #, **vet**, *cursief*, `code` en links naar http(s). Elk stuk wordt een element met
 * textContent: staat er HTML in de tekst, dan blijft dat tekst.
 */
function renderChatText(text) {
  const fragment = document.createDocumentFragment();
  let paragraph = null;
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) {
      paragraph = null;
      list = null;
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    const numbered = line.match(/^\d{1,2}[.)]\s+(.*)$/);
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (bullet || numbered) {
      const tag = bullet ? 'UL' : 'OL';
      if (!list || list.tagName !== tag) {
        list = document.createElement(tag);
        fragment.append(list);
      }
      const item = document.createElement('li');
      appendChatInline(item, (bullet || numbered)[1]);
      list.append(item);
      paragraph = null;
      continue;
    }
    list = null;
    if (heading) {
      const head = el('p', 'chat-rich-head');
      appendChatInline(head, heading[1]);
      fragment.append(head);
      paragraph = null;
      continue;
    }
    if (paragraph) paragraph.append(document.createElement('br'));
    else {
      paragraph = document.createElement('p');
      fragment.append(paragraph);
    }
    appendChatInline(paragraph, line);
  }
  return fragment;
}

const CHAT_INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]|\*[^*\s][^*\n]*\*)/g;

function appendChatInline(node, text) {
  let last = 0;
  for (const match of text.matchAll(CHAT_INLINE)) {
    if (match.index > last) node.append(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('**')) node.append(el('strong', null, token.slice(2, -2)));
    else if (token.startsWith('`')) node.append(el('code', 'chat-code', token.slice(1, -1)));
    else if (token.startsWith('http')) node.append(chatLink(token));
    else node.append(el('em', null, token.slice(1, -1)));
    last = match.index + token.length;
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
}

/** Alleen http(s): een javascript:-link in een antwoord wordt gewone tekst. */
function chatLink(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return document.createTextNode(href);
    const link = el('a', 'chat-link', href);
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  } catch {
    return document.createTextNode(href);
  }
}

// --- Een vraag stellen -----------------------------------------------------------------

/**
 * Stuurt een vraag naar /api/chat, met het rapport en de eerdere beurten als context.
 * De vraag staat meteen in beeld; mislukt hij, dan blijft hij staan met de reden en
 * een knop om hem opnieuw te versturen.
 *
 * @returns {boolean} of de vraag verstuurd is (false: leeg, te lang of er loopt al een)
 */
function sendChatMessage(message) {
  const text = String(message ?? '').trim();
  if (!text || !chatReport || chatPaused || chatRequest) return false;
  if (text.length > CHAT_MAX_CHARS || chatTurnCount() >= CHAT_MAX_TURNS) {
    updateChatState();
    return false;
  }

  const report = chatReport;
  const id = chatState.id;
  const history = chatHistory();
  const entry = { role: 'user', text };
  chatState.messages.push(entry);
  saveChat();
  chatLog.querySelector('.chat-intro')?.remove();
  chatLog.append(chatQuestionNode(entry));

  const request = { controller: new AbortController(), id, startedAt: Date.now() };
  chatRequest = request;
  chatLog.append(chatTypingNode(request.startedAt));
  chatLog.scrollTop = chatLog.scrollHeight;
  setChatBusy(true);
  keepChatFocus();

  // Elementen worden pas na het wachten opgezocht: is het gesprek intussen opnieuw
  // getekend (de chat dicht en weer open), dan staan er nieuwe.
  const settle = () => chatLog.querySelectorAll('.chat-typing').forEach((node) => node.remove());

  (async () => {
    try {
      const answer = await postChat({ report, refocus: chatRefocus(report), history, message: text }, request.controller.signal);
      if (chatRequest !== request || chatState.id !== id) return;
      const reply = {
        role: 'assistant',
        text: String(answer.antwoord || ''),
        teksten: Array.isArray(answer.teksten) ? answer.teksten : [],
        factCheck: answer.factCheck || null,
        skipped: Number(answer.overgeslagen) || 0,
      };
      chatState.messages.push(reply);
      saveChat();
      settle();
      chatLog.append(chatAnswerNode(reply));
      // Het begin van het antwoord in beeld, niet het eind: daar staat het antwoord zelf.
      const question = chatNodes.get(entry);
      chatLog.scrollTop = question?.isConnected ? Math.max(0, question.offsetTop - 8) : chatLog.scrollHeight;
    } catch (error) {
      if (error.code === ABORTED || chatRequest !== request || chatState.id !== id) return;
      entry.failed = { message: error.message, code: error.code };
      saveChat();
      settle();
      const current = chatNodes.get(entry);
      if (current?.isConnected) current.replaceWith(chatQuestionNode(entry));
      else renderChatLog();
      chatLog.scrollTop = chatLog.scrollHeight;
      if (error.code === 'auth_required') askForPassword(error.message, () => retryChatMessage(entry));
    } finally {
      if (chatRequest === request) {
        chatRequest = null;
        clearInterval(chatTypingTimer);
        setChatBusy(false);
      }
    }
  })();
  return true;
}

/**
 * De herfocus die het rapport in beeld toont (report.js): die hoort bij de context. Bij
 * een match de zoektocht waarin dit zoekwoord gekozen werd, bij geen match de
 * kandidaten na dit afgekeurde zoekwoord.
 */
function chatRefocus(report) {
  if (report.stage === 'compleet') return refocusFor(report);
  return lastRefocus && lastRefocus.rejectedKeyword === report.keyword ? lastRefocus : null;
}

/** "opnieuw versturen": de mislukte vraag verdwijnt en gaat opnieuw de deur uit. */
function retryChatMessage(entry) {
  if (chatRequest || !chatReport || chatPaused) return;
  const index = chatState.messages.indexOf(entry);
  if (index < 0) return;
  chatState.messages.splice(index, 1);
  saveChat();
  // Na het wachtwoordscherm: dat gaf de pagina weer vrij, ook achter een open chatscherm.
  setChatSheet();
  renderChatLog();
  sendChatMessage(entry.text);
}

function abortChatRequest() {
  if (!chatRequest) return;
  chatRequest.controller.abort();
  chatRequest = null;
  clearInterval(chatTypingTimer);
  setChatBusy(false);
}

/** POST /api/chat. Gewoon JSON terug; een fout heeft een code en een Nederlandse tekst. */
async function postChat(data, signal) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (appPassword) headers['X-App-Password'] = appPassword;
  let response;
  try {
    response = await fetch('/api/chat', { method: 'POST', headers, body: JSON.stringify(data), signal });
  } catch (error) {
    if (error.name === 'AbortError') throw requestError('Afgebroken.', ABORTED);
    throw requestError('Geen verbinding met de server. Controleer je internetverbinding.', 'offline');
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    if (signal.aborted) throw requestError('Afgebroken.', ABORTED);
    const message = response.status === 504
      ? 'De server gaf niet op tijd antwoord. Probeer het opnieuw, of stel een kortere vraag.'
      : `De server gaf een onverwacht antwoord (HTTP ${response.status}).`;
    throw requestError(message, 'bad_response');
  }
  if (!response.ok) throw requestError(payload.error || `De vraag is mislukt (HTTP ${response.status}).`, payload.code || 'chat_failed');
  return payload;
}

// --- Het invoerveld ---------------------------------------------------------------------

/** Groeit mee met de vraag, tot een paar regels; pas daarna scrolt het veld zelf. */
const CHAT_INPUT_MAX = 168;

function growChatInput() {
  chatInput.style.height = 'auto';
  const height = chatInput.scrollHeight + 2;
  chatInput.style.height = `${Math.min(height, CHAT_INPUT_MAX)}px`;
  chatInput.style.overflowY = height > CHAT_INPUT_MAX ? 'auto' : 'hidden';
}

chatInput.addEventListener('input', () => {
  growChatInput();
  updateChatState();
});

chatInput.addEventListener('keydown', (event) => {
  // Enter verstuurt, Shift+Enter is een nieuwe regel; tijdens het samenstellen van een
  // teken (IME, dode toetsen) is Enter van het toetsenbord, niet van ons.
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  if (chatTouch.matches) return;
  event.preventDefault();
  chatForm.requestSubmit();
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (sendChatMessage(chatInput.value)) {
    chatInput.value = '';
    growChatInput();
    updateChatState();
  }
});
