/**
 * Tekstnormalisatie en woordvergelijking. Alles wat twee teksten met elkaar
 * vergelijkt, loopt hierlangs, zodat doelpagina en concurrenten op precies
 * dezelfde manier gemeten worden.
 */

/** Kleine letters, accenten eraf, leestekens naar spaties. */
export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Functiewoorden en algemene woorden: zeggen niets over het onderwerp van een pagina. */
export const STOPWORDS = new Set([
  'de', 'het', 'een', 'en', 'van', 'in', 'op', 'te', 'dat', 'die', 'is', 'voor', 'met', 'als',
  'zijn', 'er', 'aan', 'ook', 'je', 'om', 'uit', 'bij', 'naar', 'of', 'maar', 'dan', 'wat',
  'hoe', 'wie', 'waar', 'welke', 'welk', 'niet', 'geen', 'wel', 'meer', 'over', 'door', 'tot', 'per',
  'u', 'we', 'wij', 'ze', 'zij', 'hun', 'hij', 'kan', 'kun', 'kunt', 'kunnen', 'moet', 'moeten',
  'wordt', 'worden', 'werd', 'heeft', 'hebben', 'heb', 'hebt', 'had', 'was', 'waren', 'zal', 'zullen',
  'zou', 'zouden', 'mag', 'mogen', 'wil', 'wilt', 'willen', 'gaat', 'gaan', 'komt', 'komen', 'maakt',
  'maken', 'krijgt', 'krijgen', 'geeft', 'geven', 'staat', 'staan', 'laat', 'laten', 'doen', 'doet',
  'zien', 'ziet', 'weet', 'weten', 'vind', 'vindt', 'vinden', 'kies', 'kiest', 'kiezen', 'ons', 'onze',
  'uw', 'jouw', 'jou', 'jij', 'mijn', 'mij', 'ik', 'men', 'deze', 'dit', 'dat', 'daar', 'hier', 'hierbij',
  'daarom', 'dus', 'nog', 'al', 'alle', 'alles', 'alleen', 'even', 'heel', 'erg', 'zeer', 'zelf', 'elk',
  'elke', 'ieder', 'iedere', 'andere', 'ander', 'eigen', 'zonder', 'tussen', 'onder', 'tegen', 'altijd',
  'vaak', 'soms', 'nooit', 'ongeveer', 'zoals', 'omdat', 'want', 'wanneer', 'echter', 'toch', 'steeds',
  'veel', 'weinig', 'minder', 'meest', 'meeste', 'goed', 'goede', 'beter', 'beste', 'groot', 'grote',
  'klein', 'kleine', 'nieuw', 'nieuwe', 'jaar', 'jaren', 'maand', 'dag', 'dagen', 'week', 'keer',
  'manier', 'mogelijk', 'mogelijkheden', 'belangrijk', 'belangrijke', 'verschillende', 'verschil',
  'volgende', 'eerste', 'tweede', 'waarbij', 'waarin', 'waarmee', 'waarop', 'waardoor', 'daarnaast',
  'bijvoorbeeld', 'namelijk', 'eigenlijk', 'natuurlijk', 'gewoon', 'snel', 'makkelijk', 'eenvoudig',
  'precies', 'direct', 'helemaal', 'extra', 'lees', 'kijk', 'bekijk', 'moment', 'vraag', 'vragen',
  'waarom', 'hoeveel', 'persoonlijk', 'persoonlijke', 'situatie', 'helpen', 'helpt', 'bestaan',
  'bestaat', 'gebruikt', 'gebruiken', 'krijg', 'vanaf', 'informatie', 'gemiddeld', 'gemiddelde',
  'betaal', 'betaalt', 'betalen', 'nodig', 'ongeveer', 'zodat', 'zowel', 'waarde', 'hierdoor',
  'daardoor', 'binnen', 'buiten', 'sinds', 'tijdens', 'volgens', 'verder', 'straks', 'tijd',
  'the', 'and', 'for', 'you', 'your', 'with', 'this', 'that', 'are', 'from', 'our',
]);

/**
 * Tekst die op bijna elke website staat en dus in de telling van "wat
 * concurrenten gebruiken" naar boven drijft zonder iets over het onderwerp te zeggen.
 */
export const BOILERPLATE = new Set([
  'cookie', 'cookies', 'privacy', 'privacyverklaring', 'privacybeleid', 'akkoord', 'accepteren',
  'accepteer', 'weigeren', 'instellingen', 'menu', 'zoeken', 'zoek', 'inloggen', 'login', 'account',
  'winkelwagen', 'winkelmand', 'nieuwsbrief', 'aanmelden', 'contact', 'klantenservice', 'voorwaarden',
  'algemene', 'copyright', 'rechten', 'voorbehouden', 'delen', 'facebook', 'linkedin', 'instagram',
  'twitter', 'whatsapp', 'youtube', 'tiktok', 'pinterest', 'klik', 'home', 'terug', 'vorige',
  'pagina', 'website', 'artikel', 'artikelen', 'reactie', 'reacties', 'auteur', 'datum', 'geplaatst',
  'gepubliceerd', 'bijgewerkt', 'laatst', 'download', 'bellen', 'mail', 'email', 'adres',
  'openingstijden', 'vacatures', 'sitemap', 'disclaimer', 'hoofdinhoud', 'inhoudsopgave',
  'navigatie', 'overslaan', 'sluiten', 'verzenden',
  // Bewust níét in deze lijst: "offerte", "gratis", "bestellen". Bij commerciële
  // zoekwoorden zijn dat juist inhoudelijke termen.
]);

/**
 * Ruwe Nederlandse stam: haalt de meest voorkomende meervouds- en werkwoords-
 * uitgangen eraf, zodat "kosten" en "kost" als hetzelfde begrip tellen. Geen echte
 * stemmer, wel genoeg om verbuigingen niet als verschillende termen te tellen.
 */
export function stem(word) {
  if (word.length > 5 && word.endsWith('en')) return word.slice(0, -2);
  if (word.length > 5 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith('e')) return word.slice(0, -1);
  return word;
}

export function contentWords(text) {
  return normalize(text)
    .split(' ')
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map(stem);
}

/** Gestemde tokens met spaties aan beide kanten, voor het zoeken naar woordgroepen. */
export function stemmedHaystack(text) {
  return ` ${normalize(text).split(' ').filter(Boolean).map(stem).join(' ')} `;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Staat dit losse woord op de pagina? Op woordgrens, met ruimte voor verbuiging. */
export function wordOnPage(word, normalizedPage) {
  return new RegExp(`(^| )${escapeRegex(word)}[a-z]{0,3}( |$)`).test(normalizedPage);
}

/**
 * Staat een woordgroep (zoals het focus zoekwoord) in een tekst?
 *   'letterlijk': aaneengesloten, verbuigingen toegestaan ("zonnepaneel kopen" telt voor "zonnepanelen kopen");
 *   'los':        alle inhoudelijke woorden komen voor, maar niet als één groep;
 *   'ontbreekt':  minstens één inhoudelijk woord ontbreekt.
 */
export function phraseCoverage(text, phrase) {
  const words = contentWords(phrase);
  if (words.length === 0 || !text) return 'ontbreekt';

  const literal = ` ${normalize(phrase).split(' ').filter(Boolean).map(stem).join(' ')} `;
  if (stemmedHaystack(text).includes(literal)) return 'letterlijk';

  const normalized = normalize(text);
  const hits = words.filter((word) => wordOnPage(word, normalized)).length;
  return hits === words.length ? 'los' : 'ontbreekt';
}

const DIAERESIS = { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü' };

/**
 * Herstelt trema's die het model in LaTeX-notatie schreef. In ruwe JSON staat
 * dan `commerci\"ele`, wat na het parsen `commerci"ele` wordt. Een echt
 * aanhalingsteken staat in Nederlandse tekst nooit tussen een letter en een
 * klinker, dus die combinatie is veilig terug te zetten. Werkt op de ruwe
 * JSON-tekst, vóór JSON.parse.
 */
export function repairLatexDiaeresis(json) {
  return String(json).replace(/(\p{L})\\"([aeiouAEIOU])/gu, (_, before, vowel) => before + DIAERESIS[vowel]);
}
