/**
 * Regio en taal van een analyse.
 *
 * Eén instelling bepaalt welke Google de tool bekijkt (Ahrefs en Serper), in
 * welke taal pagina's worden opgehaald, welk land Search Console filtert en in
 * welke taal de teksten zijn die op de pagina komen (koppen, H1, meta, eerste
 * alinea). De uitleg in het rapport blijft Nederlands: die is voor het team.
 *
 * Een regio toevoegen = hier één regel erbij.
 */

export const REGIONS = {
  nl: {
    id: 'nl',
    label: 'Nederland',
    short: 'NL',
    language: 'Nederlands',
    ahrefsCountry: 'nl',
    serper: { gl: 'nl', hl: 'nl' },
    // Search Console gebruikt ISO 3166-1 alpha-3.
    gscCountry: 'nld',
    acceptLanguage: 'nl-NL,nl;q=0.9,en;q=0.8',
  },
  us: {
    id: 'us',
    label: 'Verenigde Staten',
    short: 'US',
    language: 'Engels',
    ahrefsCountry: 'us',
    serper: { gl: 'us', hl: 'en' },
    gscCountry: 'usa',
    acceptLanguage: 'en-US,en;q=0.9',
  },
};

export const DEFAULT_REGION = REGIONS.nl;

/** Onbekend of leeg wordt Nederland: zo werkt een oud rapport of een oude client gewoon door. */
export function readRegion(value) {
  return REGIONS[String(value || '').trim().toLowerCase()] || DEFAULT_REGION;
}

/**
 * De regel die elk bericht aan Claude krijgt. Uitleg blijft Nederlands; wat op
 * de pagina komt, is in de taal van de regio.
 */
export function regionInstruction(region) {
  return [
    `# Regio`,
    `Google ${region.label} (${region.short}). Zoekvolumes en posities gelden voor ${region.label}.`,
    `Taal op de pagina: ${region.language}. Schrijf koppen, H1, meta title, meta description, eerste alinea en voorgestelde zoekwoorden in het ${region.language}. Schrijf je uitleg, argumenten en aanbevelingen voor de marketeer in het Nederlands.`,
  ].join('\n');
}
