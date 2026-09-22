/**
 * Vertaalt het paginatype van Ahrefs naar iets wat een marketeer herkent.
 *
 * Ahrefs geeft een hiërarchie, bijvoorbeeld "/Listing_Collection,/Listing_Collection/Product".
 * Het laatste deel is het meest specifiek. Onbekende typen krijgen een nette
 * weergave van de Engelse naam, zodat er nooit iets wegvalt.
 */

const FAMILY_LABELS = {
  Listing_Collection: 'overzichtspagina',
  Article: 'artikel',
  Landing_Page: 'landingspagina',
  Core_Page: 'kernpagina',
  Tool: 'tool',
  Forum: 'forum',
  Documentation: 'documentatie',
  Directory: 'directory',
  Profile: 'profiel',
  Media: 'media',
};

const SPECIFIC_LABELS = {
  Product: 'productoverzicht',
  Product_Page: 'productpagina',
  Tutorial_or_Guide: 'gids of uitleg',
  Homepage: 'homepage',
  FAQ_Page: 'FAQ-pagina',
  News: 'nieuwsartikel',
  Review: 'review',
  Listicle: 'lijstartikel',
  Comparison: 'vergelijking',
  Service: 'dienstpagina',
  Service_Page: 'dienstpagina',
  Category: 'categoriepagina',
  About: 'over ons',
  Contact: 'contactpagina',
  Blog: 'blogartikel',
  Opinion: 'opinie',
  Research: 'onderzoek',
  Recipe: 'recept',
  Video: 'video',
  Event: 'evenement',
  Job: 'vacature',
  Location: 'locatiepagina',
  Lead_Gen: 'leadpagina',
  Pricing: 'prijspagina',
  Glossary: 'begrippenlijst',
  Case_Study: 'casestudy',
  Press_Release: 'persbericht',
  Q_and_A: 'vraag en antwoord',
  Definition: 'definitie',
  How_To: 'stappenplan',
  Local_Business: 'lokaal bedrijf',
  Brand: 'merkpagina',
  Search_Results: 'zoekresultaten',
};

function prettify(key) {
  return String(key || '').replace(/_/g, ' ').replace(/\bor\b/g, 'of').toLowerCase().trim() || 'onbekend';
}

/** @returns {{raw: string, family: string, label: string}|null} */
export function describePageType(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map((part) => part.trim()).filter(Boolean);
  const segments = (parts[parts.length - 1] || '').split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const familyKey = segments[0];
  const specificKey = segments[segments.length - 1];
  const family = FAMILY_LABELS[familyKey] || prettify(familyKey);
  const label = segments.length > 1 ? SPECIFIC_LABELS[specificKey] || prettify(specificKey) : family;
  return { raw: String(raw), family, label };
}
