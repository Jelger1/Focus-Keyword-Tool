/**
 * Keyword Focus & Intent Check — PDF-export
 *
 * De pdf is het rapport zelf, afgedrukt met print.css en bewaard via "Opslaan als
 * PDF" van de browser. Bewust geen html2pdf of jsPDF: die maken van de tekst een
 * plaatje (gemeten: 0 selecteerbare tekens, 4,35 MB) of vragen om een tweede
 * renderer naast het scherm, waarin meting en schatting uit elkaar gaan lopen. Zo
 * blijft de tekst selecteerbaar, herhalen tabelkoppen zich per pagina en staat in de
 * pdf precies wat de marketeer op het scherm controleerde.
 *
 * Dit bestand regelt het moment van afdrukken: de bestandsnaam (Chrome neemt de
 * documenttitel over), de kantlijnteksten, alle uitklapblokken open, en daarna alles
 * terug. Het werkt ook bij Ctrl+P, want de browser stuurt dan dezelfde events.
 */

const PDF_DOWNLOAD_ICON =
  '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 17v3h16v-3"/></svg>';

/** Onthoudt per browser dat de uitleg over "Opslaan als PDF" al een keer getoond is. */
const PDF_HINT_KEY = 'focus-pdf-hint';

/** Het rapport dat nu in beeld staat: print en pdf gaan daarover, niet over een lopende aanvraag. */
let renderedReport = null;

/** Wat er tijdens het afdrukken is veranderd, om het daarna precies terug te zetten. */
let printState = null;

/**
 * "Focus keyword-rapport - solar-outlet.nl - zonnepanelen kopen - 2026-09-22": de
 * bestandsnaam en de /Title van de pdf. De datum is de lokale datum van de analyse.
 */
function pdfTitle(report) {
  const date = new Date(report.generatedAt);
  const day = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('sv-SE');
  return ['Focus keyword-rapport', domainFromUrl(report.page?.url) || 'pagina', truncate(report.keyword, 60), day]
    .filter(Boolean)
    .join(' - ')
    // Tekens die Windows of macOS niet in een bestandsnaam toestaat, vallen weg.
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tekst voor de kantlijn van de pdf, als CSS-string: aanhalingstekens en backslashes ontsnapt. */
function cssString(text) {
  return `"${String(text).replace(/[\\"]/g, '\\$&').replace(/[\r\n\f]+/g, ' ')}"`;
}

/** Vult de kopregel (vanaf pagina 2) en de voetregel van elke pdf-pagina. */
function setPrintContext(report) {
  renderedReport = report;
  const root = document.documentElement;
  root.style.setProperty('--print-running', cssString(`${report.keyword} · ${domainFromUrl(report.page?.url)}`));
  root.style.setProperty('--print-date', cssString(` · ${formatDate(report.generatedAt)}`));
  // print.css drukt alleen een rapport af; zonder deze vlag een korte melding.
  root.dataset.printable = '';
}

function clearPrintContext() {
  renderedReport = null;
  const root = document.documentElement;
  root.style.removeProperty('--print-running');
  root.style.removeProperty('--print-date');
  delete root.dataset.printable;
}

function preparePrint() {
  if (printState || !renderedReport || !output.classList.contains('report')) return;
  const opened = [...output.querySelectorAll('details:not([open])')];
  opened.forEach((node) => { node.open = true; });
  printState = { title: document.title, opened };
  document.title = pdfTitle(renderedReport);
}

/** Vuurt ook als de marketeer het afdrukvenster annuleert. */
function restoreAfterPrint() {
  if (!printState) return;
  printState.opened.forEach((node) => { node.open = false; });
  document.title = printState.title;
  printState = null;
}

window.addEventListener('beforeprint', preparePrint);
window.addEventListener('afterprint', restoreAfterPrint);

/** Synchroon in de klik: anders ziet een browser het afdrukvenster als een pop-up. */
function printReport() {
  preparePrint();
  window.print();
}

/**
 * De knop naast "kopieer markdown". Magenta bij een compleet rapport (delen is dan
 * de volgende stap), omlijnd bij geen match (dan is een beter zoekwoord de volgende stap).
 */
function pdfButton(report) {
  const button = el('button', `btn ${report.stage === 'compleet' ? 'btn-primary' : 'btn-outline'} btn-sm relative`);
  button.type = 'button';
  button.dataset.pdf = '';
  button.innerHTML = PDF_DOWNLOAD_ICON;
  button.append(el('span', null, 'download als pdf'));
  button.title = 'Opent het afdrukvenster: kies ‘Opslaan als PDF’.';
  button.addEventListener('click', () => {
    if (storageGet(PDF_HINT_KEY)) printReport();
    else showPdfHelp(button);
  });
  return button;
}

/**
 * Eenmalige uitleg: de standaardbestemming in het afdrukvenster is vaak een printer.
 * Daarna onthoudt de browser "Opslaan als PDF" zelf, en gaat de knop meteen door.
 */
function showPdfHelp(anchor) {
  document.querySelector('.pdf-help')?.remove();
  const help = el('div', 'popover pdf-help');
  help.setAttribute('role', 'dialog');
  help.setAttribute('aria-labelledby', 'pdf-help-title');
  const title = el('h3', null, 'Zo bewaar je het rapport als pdf');
  title.id = 'pdf-help-title';
  const steps = el('ol');
  [
    'Kies bij Bestemming voor ‘Opslaan als PDF’.',
    'Klik op Opslaan. Bestandsnaam en paginanummers staan al klaar.',
    'Zie je toch een datum of webadres in de kantlijn? Zet onder Meer instellingen ‘Kop- en voetteksten’ uit.',
  ].forEach((text) => steps.append(el('li', null, text)));
  const note = el('p', 'note', 'Op een iPhone of iPad tik je in het printvoorbeeld op het deelicoon en kies je ‘Bewaar in Bestanden’.');

  const go = el('button', 'btn btn-primary btn-sm', 'open afdrukvenster');
  go.type = 'button';
  const cancel = el('button', 'btn btn-quiet btn-sm', 'annuleer');
  cancel.type = 'button';
  const buttons = el('div', 'pdf-help-actions');
  buttons.append(go, cancel);
  help.append(title, steps, note, buttons);

  const close = () => {
    help.remove();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    close();
    anchor.focus();
  };
  const onOutside = (event) => {
    if (!help.contains(event.target) && event.target !== anchor && !anchor.contains(event.target)) close();
  };
  go.addEventListener('click', () => {
    storageSet(PDF_HINT_KEY, '1');
    close();
    anchor.focus();
    printReport();
  });
  cancel.addEventListener('click', () => {
    close();
    anchor.focus();
  });

  anchor.parentElement.append(help);
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onOutside, true);
  go.focus();
}
