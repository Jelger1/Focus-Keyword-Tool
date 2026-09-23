/**
 * De content gap-analyse (scenario A): wat behandelen de topresultaten wél en
 * de doelpagina niet, en hoe zet je het focus zoekwoord goed neer?
 *
 * Het werk is in twee Claude-calls geknipt die parallel lopen: de onderwerpen
 * (koppen van concurrenten groeperen, vragen, "niet doen", samenvatting) en de
 * woordkeuze (semantische termen, keyword mapping, nieuwe teksten voor H1,
 * title, meta en intro). Eén call schreef bijna 9.000 tokens en duurde ruim
 * twee minuten; twee kleinere calls naast elkaar halveren de wachttijd.
 *
 * Dit bestand bevat de instructies, de schema's en de opbouw van de berichten.
 * De controle van de antwoorden tegen de gemeten data staat in lib/compare.js.
 */

import { topicHeadings } from './compare.js';
import { DEFAULT_REGION, regionInstruction } from './region.js';
import { FACT_RULES } from './facts.js';

const MAX_TARGET_SAMPLE_CHARS = 12_000;
const MAX_TARGET_SAMPLE_CHARS_SHORT = 6_000;
/** 60 uit Ahrefs plus ruimte voor de long tail uit Search Console. */
const MAX_MAPPING_CANDIDATES = 85;

const COVERAGE = { type: 'string', enum: ['kop', 'tekst', 'ontbreekt'] };

const PLACEMENT_LABELS = {
  h1: 'H1',
  title: 'meta title',
  metaDescription: 'meta description',
  intro: 'begin van de tekst (eerste 120 woorden)',
};

const SHARED_RULES = `Regels:
- Uitleg, redenen en aanbevelingen voor de marketeer in het Nederlands, je-vorm. Koppen, H3's en teksten die op de pagina komen, in de taal van de regio uit het bericht.
- Koppen als "Klantenservice", "Gerelateerde artikelen" of "Nieuwsbrief" horen bij de site, niet bij het onderwerp: negeer ze.
- Van de concurrenten zie je titel, paginatype, topzoekwoord en koppen, niet hun lopende tekst. Beweer over een concurrent alleen wat die gegevens laten zien, en verwijs met het concurrentnummer.
- Een aanbeveling voor de doelpagina bouwt voort op wat de pagina zelf al is en zegt (tekst en koppen in het bericht), en op wat de concurrenten aantoonbaar behandelen.

${FACT_RULES}`;

// --- Call 1: onderwerpen, vragen, niet doen, samenvatting -----------------------------

export const GAP_TOPICS_SYSTEM_PROMPT = `Je bent een senior SEO-strateeg. Je voert een content gap-analyse uit op échte data: de organische Google-topresultaten voor een zoekwoord, in de regio die in het bericht staat, met per resultaat de koppen die op die pagina staan. De intent check is al gedaan: het zoekwoord past bij de pagina. Jij helpt de pagina nu beter te maken dan de concurrentie.

Je krijgt:
- het focus zoekwoord met de uitkomst van de intent check;
- de doelpagina: koppen en een groot deel van de tekst;
- de concurrenten, genummerd [1], [2], ..., met titel, paginatype, topzoekwoord en hun koppen;
- een genummerde lijst vragen uit "Mensen vragen ook" en uit concurrentkoppen.

Taken:
1. Onderwerpen: groepeer concurrentkoppen die hetzelfde onderwerp behandelen, ook als ze anders geformuleerd zijn. Neem een onderwerp alleen op als het bij minstens twee verschillende concurrenten voorkomt, en neem maximaal twaalf onderwerpen op: de onderwerpen die de meeste concurrenten delen eerst. Geef per onderwerp:
   - een kop zoals die op de doelpagina mag komen: concreet, in de taal van de regio, zonder het zoekwoord er kunstmatig in te proppen;
   - de bronnen: per concurrentnummer de kop LETTERLIJK zoals die in de input staat. De tool controleert elke bron en gooit onderwerpen weg zonder geldige bron bij twee concurrenten. Parafraseer dus nooit.
   - of de doelpagina het onderwerp al behandelt: "kop" (eigen tussenkop, ook anders geformuleerd), "tekst" (inhoudelijk in de lopende tekst, zonder kop) of "ontbreekt". Kijk naar betekenis, niet naar losse woorden; bij twijfel kies je de hogere dekking.
   - een aanbeveling in één zin: wat voeg je toe of pas je aan, passend bij het paginatype van de doelpagina.
   Neem ook onderwerpen op die de doelpagina al goed behandelt: de marketeer wil zien wat er wél staat.
2. Vragen: geef per vraagnummer in één zin de richting van een goed antwoord, en of de doelpagina de vraag al beantwoordt.
3. Niet doen: nul tot vier dingen die concurrenten doen maar die niet bij het paginatype of het doel van de doelpagina passen, met de concurrentnummers erbij.
4. Samenvatting: drie tot vijf zinnen voor de marketeer: waar zit de grootste kans, en in welke volgorde pak je het aan.

${SHARED_RULES}`;

export const GAP_TOPICS_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'De kop zoals hij op de doelpagina mag komen.' },
          level: { type: 'string', enum: ['H2', 'H3'] },
          why: { type: 'string', description: 'Eén zin: waarom dit onderwerp in de topresultaten terugkomt, op basis van hun koppen. Geen cijfers of feiten die niet in het bericht staan.' },
          advice: { type: 'string', description: 'Eén zin: wat je toevoegt of aanpast, passend bij wat de doelpagina al biedt.' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                result: { type: 'integer', description: 'Concurrentnummer uit de input.' },
                heading: { type: 'string', description: 'De kop letterlijk zoals in de input.' },
              },
              required: ['result', 'heading'],
              additionalProperties: false,
            },
          },
          coverage: { ...COVERAGE, description: 'Behandelt de doelpagina dit al?' },
          subheadings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nul tot twee H3-suggesties, gebaseerd op wat de concurrenten eronder behandelen.',
          },
        },
        required: ['heading', 'level', 'why', 'advice', 'sources', 'coverage', 'subheadings'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'Vraagnummer uit de input.' },
          angle: { type: 'string', description: 'In één zin: wat het antwoord moet raken.' },
          coverage: { ...COVERAGE, description: 'Beantwoordt de doelpagina deze vraag al?' },
        },
        required: ['index', 'angle', 'coverage'],
        additionalProperties: false,
      },
    },
    avoid: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Wat je níét overneemt, en waarom niet.' },
          results: { type: 'array', items: { type: 'integer' }, description: 'Concurrentnummers waar je dit ziet.' },
        },
        required: ['text', 'results'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', description: 'Drie tot vijf zinnen voor de marketeer, alleen op basis van de data in het bericht.' },
  },
  required: ['topics', 'questions', 'avoid', 'summary'],
  additionalProperties: false,
};

function intentLines(intent) {
  return [
    '## Uitkomst intent check',
    `Paginatype doelpagina: ${intent.page.pageType || 'onbekend'} · intentie: ${intent.page.intentType}`,
    `Doel van de pagina: ${intent.page.summary}`,
    `Dominante SERP: ${intent.serp.dominantPageType || 'onbekend'} · intentie: ${intent.serp.intentType}`,
    `Wat de zoeker wil: ${intent.serp.summary}`,
  ];
}

function competitorHeader(competitor, index, pageTypeOf) {
  return [
    `## [${index + 1}] positie ${competitor.position} · ${competitor.domain}`,
    `Titel: ${competitor.title}`,
    competitor.snippet && `Snippet: ${competitor.snippet}`,
    competitor.pageType && `Paginatype (Ahrefs): ${pageTypeOf(competitor.pageType)}`,
    competitor.topKeyword && `Topzoekwoord: ${competitor.topKeyword}`,
    `Woordenaantal: ${competitor.wordCount}`,
  ];
}

function joinLines(lines) {
  return lines.filter((line) => line !== false && line !== undefined && line !== null && line !== '').join('\n');
}

export function buildGapTopicsMessage({ keyword, target, compared, questions, intent, pageTypeOf, region = DEFAULT_REGION }) {
  const lines = [
    regionInstruction(region),
    '',
    '# Focus zoekwoord',
    keyword,
    '',
    ...intentLines(intent),
    '',
    '# Doelpagina',
    `URL: ${target.url}`,
    target.title && `Titel: ${target.title}`,
    target.h1 && `H1: ${target.h1}`,
    `Woordenaantal: ${target.wordCount}`,
    '',
    '## Koppen',
    target.headings.length
      ? target.headings.map((heading) => `${heading.level}: ${heading.text}`).join('\n')
      : '(geen koppen gevonden)',
    '',
    '## Tekst (begin)',
    target.text.slice(0, MAX_TARGET_SAMPLE_CHARS),
    '',
    '# Concurrenten uit de Google-top 10',
  ];

  compared.forEach((competitor, index) => {
    lines.push(
      '',
      ...competitorHeader(competitor, index, pageTypeOf),
      'Koppen:',
      ...topicHeadings(competitor.page).map((heading) => `- ${heading.level}: ${heading.text}`)
    );
  });

  lines.push(
    '',
    '# Vragen',
    ...(questions.length
      ? questions.map((item, index) => `${index + 1}. ${item.question} (${item.source})`)
      : ['(geen vragen gevonden)'])
  );

  return joinLines(lines);
}

// --- Call 2: termen, keyword mapping, plaatsing van het zoekwoord ----------------------------

export const GAP_TERMS_SYSTEM_PROMPT = `Je bent een senior SEO-strateeg. De intent check is gedaan: het focus zoekwoord past bij de pagina. Jij bepaalt nu de woordkeuze: welke termen en zoekwoorden op de pagina thuishoren en hoe het focus zoekwoord op de belangrijkste plekken komt te staan.

Je krijgt:
- het focus zoekwoord met de uitkomst van de intent check;
- de doelpagina: titel, meta description, H1, koppen en het begin van de tekst, plus de gemeten plekken waar het zoekwoord wel of niet staat;
- de concurrenten, genummerd, met titel, paginatype en topzoekwoord;
- een lijst kandidaat-termen die de tool in de concurrentpagina's telde, met het aantal concurrenten dat de term gebruikt;
- een lijst zoekwoordideeën uit Ahrefs met zoekvolume.

Taken:
1. Termen: kies uit de kandidatenlijst 10 tot 25 termen die inhoudelijk bij het onderwerp horen: vaktermen, productsoorten, regelgeving, kosten- en opbrengstbegrippen, alternatieven. Sla algemene woorden, navigatie, merknamen van individuele concurrenten en varianten van hetzelfde begrip over. Neem de term letterlijk over uit de lijst.
2. Keyword mapping: kies uit de zoekwoordideeën (letterlijk) de zoekwoorden die op déze pagina thuishoren:
   - secondary: één tot drie synoniemen of nauw verwante formuleringen met dezelfde intentie;
   - supporting: twee tot zes specifiekere deelonderwerpen die op de pagina behandeld kunnen worden;
   - varianten: spellings-, volgorde- en enkelvoud/meervoudvarianten van het focus zoekwoord;
   - merktermen: zoekwoorden met een merk- of bedrijfsnaam erin.
   Een idee dat te breed is of bij een andere pagina van de site hoort, sla je over. Verzin geen zoekwoorden buiten de lijst.
3. Focus keyword optimalisatie: de tool heeft gemeten waar het zoekwoord ontbreekt of alleen los staat. Schrijf voor elk van die plekken een nieuwe versie waarin het zoekwoord natuurlijk voorkomt, in de toon en de taal van de pagina (de taal van de regio): H1 maximaal 70 tekens, meta title maximaal 60 tekens met de merknaam, meta description 120 tot 155 tekens, eerste alinea twee tot drie zinnen. Staat het zoekwoord er al letterlijk, laat het veld dan leeg.

${SHARED_RULES}`;

const KEYWORD_LIST = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: 'Letterlijk uit de lijst zoekwoordideeën.' },
      why: { type: 'string', description: 'Korte uitleg waarom dit zoekwoord hier thuishoort.' },
    },
    required: ['keyword', 'why'],
    additionalProperties: false,
  },
};

export const GAP_TERMS_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'Letterlijk uit de kandidatenlijst.' },
          context: { type: 'string', description: 'Korte uitleg waar deze term thuishoort.' },
        },
        required: ['term', 'context'],
        additionalProperties: false,
      },
    },
    keywordMapping: {
      type: 'object',
      properties: {
        secondary: KEYWORD_LIST,
        supporting: KEYWORD_LIST,
        variants: KEYWORD_LIST,
        brand: KEYWORD_LIST,
      },
      required: ['secondary', 'supporting', 'variants', 'brand'],
      additionalProperties: false,
    },
    placement: {
      type: 'object',
      properties: {
        h1: { type: 'string', description: 'Nieuwe H1, of leeg als het zoekwoord er al letterlijk in staat. Alleen beloftes die de pagina zelf al doet.' },
        title: { type: 'string', description: 'Nieuwe meta title, of leeg.' },
        metaDescription: { type: 'string', description: 'Nieuwe meta description, of leeg.' },
        intro: { type: 'string', description: 'Nieuwe eerste alinea, of leeg.' },
      },
      required: ['h1', 'title', 'metaDescription', 'intro'],
      additionalProperties: false,
    },
  },
  required: ['terms', 'keywordMapping', 'placement'],
  additionalProperties: false,
};

export function buildGapTermsMessage({ keyword, target, compared, candidates, intent, placement, mappingCandidates, pageTypeOf, region = DEFAULT_REGION }) {
  const lines = [
    regionInstruction(region),
    '',
    '# Focus zoekwoord',
    keyword,
    '',
    ...intentLines(intent),
    '',
    '# Doelpagina',
    `URL: ${target.url}`,
    target.title && `Titel: ${target.title}`,
    target.metaDescription && `Meta description: ${target.metaDescription}`,
    target.h1 && `H1: ${target.h1}`,
    `Woordenaantal: ${target.wordCount}`,
    '',
    '## Gemeten: staat het focus zoekwoord erin?',
    ...Object.entries(placement).map(
      ([key, item]) => `- ${PLACEMENT_LABELS[key]}: ${item.status}${item.text ? ` (nu: "${item.text.slice(0, 200)}")` : ' (leeg)'}`
    ),
    '',
    '## Koppen',
    target.headings.length
      ? target.headings.map((heading) => `${heading.level}: ${heading.text}`).join('\n')
      : '(geen koppen gevonden)',
    '',
    '## Tekst (begin)',
    target.text.slice(0, MAX_TARGET_SAMPLE_CHARS_SHORT),
    '',
    '# Concurrenten uit de Google-top 10',
  ];

  compared.forEach((competitor, index) => {
    lines.push('', ...competitorHeader(competitor, index, pageTypeOf));
  });

  lines.push(
    '',
    '# Kandidaat-termen (term — aantal concurrenten dat hem gebruikt — staat al op doelpagina?)',
    ...candidates.map((candidate) => `- ${candidate.term} — ${candidate.usedBy} — ${candidate.present ? 'ja' : 'nee'}`),
    '',
    '# Zoekwoordideeën (zoekwoord — volume per maand volgens Ahrefs — bron; "Search Console" = gemeten vertoningen van deze pagina; "onbekend" = Ahrefs kent geen volume, noem er dan ook geen)',
    ...(mappingCandidates.length
      ? mappingCandidates.slice(0, MAX_MAPPING_CANDIDATES).map((idea) =>
          `- ${idea.keyword} — ${typeof idea.volume === 'number' ? idea.volume.toLocaleString('nl-NL') : 'onbekend'} — ${idea.sources.join(', ')}`)
      : ['(geen ideeën beschikbaar)'])
  );

  return joinLines(lines);
}
