/**
 * De vergelijking tussen doelpagina en concurrenten.
 *
 * Verdeling van het werk: de code meet (woorden, koppen, termfrequenties,
 * plekken van het zoekwoord) en controleert; Claude groepeert en formuleert.
 * Alles wat Claude aanlevert, wordt hier tegen de gemeten data gehouden: een
 * onderwerp zonder aantoonbare bron, een term die niet geteld is of een
 * zoekwoord dat niet in de ideeënlijst staat, haalt het rapport niet.
 */

import { fetchPage, canonicalUrl } from './page.js';
import { describePageType } from './pagetype.js';
import {
  normalize, stem, contentWords, stemmedHaystack, wordOnPage, STOPWORDS, BOILERPLATE,
} from './text.js';

const COMPETITOR_TIMEOUT_MS = 10_000;
const MAX_COMPETITOR_HEADINGS = 40;
const MAX_TERM_CANDIDATES = 120;
const MAX_QUESTIONS = 10;
const MAX_AVOID = 4;

/**
 * Domeinen waar geen artikeltekst te halen valt. Die slaan we over in plaats van
 * ze als "mislukt" te tellen: het is geen fout, het is een ander soort resultaat.
 */
const NON_ARTICLE_DOMAINS = [
  'youtube.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'pinterest.com', 'x.com',
  'twitter.com', 'linkedin.com', 'google.com', 'maps.google.com',
];

/** Koppen die bij de site horen en niet bij het onderwerp. */
const BOILERPLATE_HEADING = /cookie|nieuwsbrief|klantenservice|contact|volg ons|gerelateerd|lees ook|lees meer|populair|meest gelezen|menu|winkelwagen|inloggen|mijn account|social|deel dit|reacties|over ons|footer|download de app|meer weten|hulp nodig|nog vragen|advies nodig|interesse in|neem contact|gevonden\?|niet gevonden|zoek je iets|in je winkelwagen/i;

// --- Concurrenten ophalen -------------------------------------------------------

/**
 * Haalt de organische resultaten parallel op. Mislukt een pagina, dan noteren we
 * waarom en gaan we door: één trage of geblokkeerde concurrent mag de analyse
 * niet tegenhouden, maar de marketeer moet wel kunnen zien wat er ontbrak.
 */
export async function fetchCompetitors(organic, target) {
  const targetUrl = canonicalUrl(target.url);
  const targetDomain = canonicalUrl(target.url).split('/')[0];

  return Promise.all(
    organic.map(async (result) => {
      const base = { ...result, wordCount: null, headingCount: null, reason: '' };

      if (canonicalUrl(result.url) === targetUrl) {
        return { ...base, status: 'jouw pagina' };
      }
      if (result.domain === targetDomain) {
        return { ...base, status: 'eigen domein', reason: 'Andere pagina van dezelfde site; telt niet als concurrent.' };
      }
      if (NON_ARTICLE_DOMAINS.some((domain) => result.domain === domain || result.domain.endsWith(`.${domain}`))) {
        return { ...base, status: 'overgeslagen', reason: 'Video of social media, geen artikeltekst.' };
      }

      try {
        const page = await fetchPage(result.url, { timeoutMs: COMPETITOR_TIMEOUT_MS });
        return {
          ...base,
          status: 'vergeleken',
          wordCount: page.wordCount,
          headingCount: page.headings.length,
          page,
        };
      } catch (error) {
        return { ...base, status: 'mislukt', reason: error.message };
      }
    })
  );
}

/** Koppen van een concurrent die over het onderwerp gaan, niet over de site. */
export function topicHeadings(page) {
  return page.headings
    .filter((heading) => heading.text.length > 2 && heading.text.length < 160)
    .filter((heading) => !BOILERPLATE_HEADING.test(heading.text))
    .slice(0, MAX_COMPETITOR_HEADINGS);
}

// --- Samenvattingen voor het rapport --------------------------------------------

/** De SERP zoals de UI hem toont: zonder de opgehaalde paginatekst, met een leesbaar paginatype. */
export function serpSummary(serp, serpResults, providerLabel) {
  const targetResult = serpResults.find((result) => result.status === 'jouw pagina');
  return {
    provider: providerLabel,
    providerId: serp.provider,
    updatedAt: serp.updatedAt || null,
    targetPosition: targetResult ? targetResult.position : null,
    compared: serpResults.filter((result) => result.status === 'vergeleken').length,
    peopleAlsoAsk: serp.peopleAlsoAsk.length,
    results: serpResults.map(({ page, ...result }) => ({
      ...result,
      pageTypeLabel: describePageType(result.pageType)?.label ?? null,
    })),
    relatedSearches: serp.relatedSearches || [],
    features: serp.features || [],
  };
}

export function pageSummary(target) {
  return {
    url: target.url,
    title: target.title,
    metaDescription: target.metaDescription,
    h1: target.h1,
    wordCount: target.wordCount,
    headings: target.headings,
  };
}

// --- Termen tellen --------------------------------------------------------------

function isTermWord(word) {
  return word.length >= 3 && !/^\d+$/.test(word) && !STOPWORDS.has(word) && !BOILERPLATE.has(word);
}

/**
 * Alle losse woorden (vanaf vijf letters) en woordparen op een pagina, als set
 * gestemde sleutels. Per pagina telt een term één keer: we willen weten hóeveel
 * concurrenten een term gebruiken, niet hoe vaak één concurrent hem herhaalt.
 */
function pageGrams(text) {
  const tokens = normalize(text).split(' ').filter(Boolean);
  const grams = new Map(); // sleutel -> zoals hij op de pagina stond

  const add = (words) => {
    const key = words.map(stem).join(' ');
    if (!grams.has(key)) grams.set(key, words.join(' '));
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const word = tokens[i];
    if (!isTermWord(word)) continue;
    if (word.length >= 5) add([word]);
    const next = tokens[i + 1];
    if (next && isTermWord(next)) add([word, next]);
  }
  return grams;
}

/**
 * Kandidaat-termen: woorden en woordparen die bij meerdere concurrenten
 * voorkomen. Een term moet bij minstens 30% van de vergeleken pagina's staan
 * (en minimaal twee), anders is het het vocabulaire van één site en geen patroon.
 *
 * Deze lijst is nog ruw: "zonnepanelen installeren" staat naast "installeren".
 * Claude kiest er de inhoudelijke termen uit, maar kan er niets aan toevoegen.
 */
export function termCandidates(competitorPages, targetPage, keyword) {
  const counts = new Map(); // sleutel -> { df, forms: Map<vorm, aantal> }
  for (const page of competitorPages) {
    for (const [key, form] of pageGrams(`${page.title} ${page.text}`)) {
      const entry = counts.get(key) || { df: 0, forms: new Map() };
      entry.df += 1;
      entry.forms.set(form, (entry.forms.get(form) || 0) + 1);
      counts.set(key, entry);
    }
  }

  const keywordStems = new Set(normalize(keyword).split(' ').filter(Boolean).map(stem));
  const targetHaystack = stemmedHaystack(`${targetPage.title} ${targetPage.metaDescription} ${targetPage.text}`);
  const minimum = Math.max(2, Math.ceil(competitorPages.length * 0.3));

  return [...counts.entries()]
    .filter(([, entry]) => entry.df >= minimum)
    .filter(([key]) => !key.split(' ').every((part) => keywordStems.has(part)))
    .map(([key, entry]) => ({
      key,
      term: [...entry.forms.entries()].sort((a, b) => b[1] - a[1])[0][0],
      usedBy: entry.df,
      present: targetHaystack.includes(` ${key} `),
    }))
    // Meest gedeelde termen eerst; bij gelijke stand gaan woordparen voor, die
    // zijn specifieker dan losse woorden.
    .sort((a, b) => b.usedBy - a.usedBy || b.key.split(' ').length - a.key.split(' ').length)
    .slice(0, MAX_TERM_CANDIDATES);
}

// --- Vragen verzamelen ----------------------------------------------------------

/**
 * Vragen komen uit twee echte bronnen: het "Mensen vragen ook"-blok van Google en
 * koppen van concurrenten die als vraag geformuleerd zijn. Claude schrijft er
 * alleen een antwoordrichting bij; de vragen zelf verzint het niet.
 */
export function collectQuestions(peopleAlsoAsk, competitors) {
  const questions = [];
  const seen = new Set();

  const push = (question, source) => {
    const key = normalize(question);
    if (!key || seen.has(key) || questions.length >= MAX_QUESTIONS) return;
    seen.add(key);
    questions.push({ question: question.trim(), ...source });
  };

  peopleAlsoAsk.forEach((item) => push(item.question, { source: 'Mensen vragen ook', from: item.url }));

  // Om en om per concurrent: anders vult de eerste site met veel vraagkoppen de
  // hele lijst en zie je niet wat de rest van de top 10 vraagt.
  const perCompetitor = competitors.map((competitor) =>
    topicHeadings(competitor.page)
      .filter((heading) => heading.text.trim().endsWith('?'))
      .map((heading) => ({ text: heading.text, competitor })));
  const rounds = Math.max(0, ...perCompetitor.map((list) => list.length));
  for (let round = 0; round < rounds; round += 1) {
    perCompetitor.forEach((list) => {
      const item = list[round];
      if (!item) return;
      push(item.text, { source: 'Kop bij concurrent', from: item.competitor.url, position: item.competitor.position });
    });
  }

  return questions;
}

// --- Kandidaten voor de keyword mapping -------------------------------------------

/** Zoveel Search Console-zoekopdrachten gaan maximaal mee als kandidaat voor de mapping. */
const MAX_GSC_MAPPING_CANDIDATES = 25;

/**
 * Zoekwoorden waaruit Claude de secondary, supporting, varianten en merktermen
 * mag kiezen: de ideeën van Ahrefs, de topzoekwoorden van de concurrenten en,
 * als die er is, de zoekopdrachten waarop de pagina volgens Search Console al
 * vertoond wordt. Het focus zoekwoord zelf hoort er niet bij.
 */
export function mappingCandidates(ideas, serp, keyword, gscRows = []) {
  const primary = normalize(keyword);
  const byKey = new Map();

  for (const idea of ideas) {
    const key = normalize(idea.keyword);
    if (!key || key === primary) continue;
    byKey.set(key, {
      keyword: idea.keyword,
      volume: idea.volume ?? null,
      difficulty: idea.difficulty ?? null,
      intents: idea.intents ?? null,
      parentTopic: idea.parentTopic ?? null,
      sources: [...(idea.sources || [])],
    });
  }

  for (const result of serp.organic) {
    if (!result.topKeyword) continue;
    const key = normalize(result.topKeyword);
    if (!key || key === primary) continue;
    const label = `topzoekwoord van #${result.position}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.sources.push(label);
      continue;
    }
    byKey.set(key, {
      keyword: result.topKeyword,
      volume: result.topKeywordVolume ?? null,
      difficulty: null,
      intents: null,
      parentTopic: null,
      sources: [label],
    });
  }

  for (const row of gscRows.slice(0, MAX_GSC_MAPPING_CANDIDATES)) {
    const key = normalize(row.query);
    if (!key || key === primary) continue;
    const position = typeof row.position === 'number' ? `, positie ${String(row.position).replace('.', ',')}` : '';
    const label = `Search Console: ${(row.impressions ?? 0).toLocaleString('nl-NL')} vertoningen${position}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.sources.push(label);
      existing.impressions = row.impressions ?? null;
      continue;
    }
    byKey.set(key, {
      keyword: row.query,
      volume: null,
      difficulty: null,
      intents: null,
      parentTopic: null,
      impressions: row.impressions ?? null,
      sources: [label],
    });
  }

  // Eerst wat Ahrefs een volume geeft, daarna de gemeten long tail zonder volume:
  // anders zakken die onder de afkapgrens van het bericht aan Claude.
  const all = [...byKey.values()];
  const withVolume = all.filter((item) => typeof item.volume === 'number').sort((a, b) => b.volume - a.volume);
  const measuredOnly = all.filter((item) => typeof item.volume !== 'number').sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0));
  return [...withVolume, ...measuredOnly];
}

// --- Oordelen samenvoegen -------------------------------------------------------

const STATUS_RANK = { ontbreekt: 0, tekst: 1, kop: 2 };

/**
 * Combineert het oordeel van het model met dat van de code over de doelpagina.
 * De hoogste van de twee wint, dus de code kan de uitkomst alleen milder maken:
 * geen van beide kan een gat verzinnen dat er niet is.
 */
function settleStatus(fromModel, fromCode) {
  const highest = Math.max(STATUS_RANK[fromModel] ?? 0, STATUS_RANK[fromCode] ?? 0);
  return Object.keys(STATUS_RANK).find((key) => STATUS_RANK[key] === highest);
}

/**
 * Letterlijke tegencheck op de doelpagina: staan de onderscheidende woorden al
 * in een kop, of anders in de lopende tekst? De woorden uit het zoekwoord tellen
 * niet mee; die staan overal en zouden elk onderwerp als behandeld laten lijken.
 *
 * Blijft er geen onderscheidend woord over ("Welke zonnepanelen zijn het beste?"),
 * dan heeft de code geen bewijs en geeft ze de laagste stand terug. Omdat
 * settleStatus() de hoogste van beide kiest, beslist het model dan alleen.
 */
function assessOnTarget(suggestion, targetPage, keywordWords, normalizedText) {
  const wanted = contentWords(suggestion).filter((word) => !keywordWords.has(word));
  if (wanted.length === 0) return 'ontbreekt';

  const inHeading = targetPage.headings.some((heading) => {
    const present = new Set(contentWords(heading.text));
    if (present.size === 0) return false;
    const hits = wanted.filter((word) => present.has(word)).length;
    return hits >= Math.min(2, wanted.length) && hits / Math.min(wanted.length, present.size) >= 0.6;
  });
  if (inHeading) return 'kop';

  const hits = wanted.filter((word) => wordOnPage(word, normalizedText)).length;
  return hits / wanted.length >= 0.6 ? 'tekst' : 'ontbreekt';
}

/**
 * Bestaat deze kop echt bij deze concurrent? Het model moet letterlijk citeren;
 * we staan alleen verschillen in hoofdletters, leestekens en een afgekapt eind toe.
 */
function headingExists(cited, competitor) {
  const wanted = normalize(cited);
  if (!wanted) return false;
  return competitor.page.headings.some((heading) => {
    const actual = normalize(heading.text);
    if (actual === wanted) return true;
    const [short, long] = actual.length < wanted.length ? [actual, wanted] : [wanted, actual];
    return short.length >= 12 && long.includes(short) && short.length / long.length >= 0.8;
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function competitorRef(competitor) {
  return { position: competitor.position, domain: competitor.domain, url: competitor.url };
}

// --- Het rapport ------------------------------------------------------------------

/**
 * @param compared  concurrenten met status 'vergeleken', in de volgorde waarin ze
 *                  genummerd aan Claude zijn voorgelegd (1 = compared[0])
 * @param placement de gemeten plekken van het zoekwoord (lib/intent.js); Claude
 *                  levert alleen een nieuwe tekst voor plekken die niet 'letterlijk' zijn
 */
export function buildReport({
  keyword, target, serp, serpResults, compared, candidates, questions, model, mappingCandidates: ideas, placement, providerLabel,
}) {
  const normalizedText = normalize(`${target.text} ${target.title} ${target.metaDescription}`);
  const keywordWords = new Set(contentWords(keyword));
  const total = compared.length;

  // Onderwerpen: alleen bronnen die echt bestaan tellen mee, en een onderwerp
  // moet bij minstens twee concurrenten voorkomen om een patroon te zijn.
  const topics = (model.topics || [])
    .map((topic) => {
      const byResult = new Map();
      for (const source of topic.sources || []) {
        const competitor = compared[source.result - 1];
        if (!competitor || byResult.has(source.result)) continue;
        if (headingExists(source.heading, competitor)) {
          byResult.set(source.result, { ...competitorRef(competitor), heading: source.heading });
        }
      }
      const sources = [...byResult.values()].sort((a, b) => a.position - b.position);
      return {
        heading: topic.heading,
        level: topic.level,
        why: topic.why,
        advice: topic.advice || '',
        subheadings: (topic.subheadings || []).filter(Boolean),
        sources,
        coveredBy: sources.length,
        status: settleStatus(topic.coverage, assessOnTarget(topic.heading, target, keywordWords, normalizedText)),
      };
    })
    .filter((topic) => topic.coveredBy >= 2)
    .sort((a, b) => b.coveredBy - a.coveredBy);

  const droppedTopics = (model.topics || []).length - topics.length;

  // Termen: Claude mag alleen kiezen uit wat de code geteld heeft.
  const candidateByTerm = new Map(candidates.map((candidate) => [normalize(candidate.term), candidate]));
  const chosen = new Map();
  for (const item of model.terms || []) {
    const candidate = candidateByTerm.get(normalize(item.term));
    if (candidate && !chosen.has(candidate.key)) {
      chosen.set(candidate.key, {
        term: candidate.term,
        context: item.context,
        usedBy: candidate.usedBy,
        present: candidate.present,
      });
    }
  }
  const terms = [...chosen.values()].sort((a, b) => b.usedBy - a.usedBy);

  // Vragen: de lijst is van ons, het model levert per nummer alleen richting en dekking.
  const notes = new Map((model.questions || []).map((note) => [note.index, note]));
  const questionList = questions.map((item, index) => {
    const note = notes.get(index + 1) || {};
    return {
      ...item,
      angle: note.angle || '',
      status: settleStatus(note.coverage, assessOnTarget(item.question, target, keywordWords, normalizedText)),
    };
  });

  // Keyword mapping: alleen zoekwoorden uit de ideeënlijst, elk in één groep.
  const ideaByKey = new Map((ideas || []).map((idea) => [normalize(idea.keyword), idea]));
  const usedIdeas = new Set([normalize(keyword)]);
  const pickIdeas = (items) => {
    const picked = [];
    for (const item of Array.isArray(items) ? items : []) {
      const key = normalize(item?.keyword);
      const idea = ideaByKey.get(key);
      if (!idea || usedIdeas.has(key)) continue;
      usedIdeas.add(key);
      picked.push({ keyword: idea.keyword, volume: idea.volume, impressions: idea.impressions ?? null, why: String(item.why || ''), sources: idea.sources });
    }
    return picked;
  };
  const mapping = {
    primary: keyword,
    secondary: pickIdeas(model.keywordMapping?.secondary),
    supporting: pickIdeas(model.keywordMapping?.supporting),
    variants: pickIdeas(model.keywordMapping?.variants),
    brand: pickIdeas(model.keywordMapping?.brand),
  };
  const droppedMapping = ['secondary', 'supporting', 'variants', 'brand']
    .reduce((sum, group) => sum + (model.keywordMapping?.[group]?.length || 0), 0)
    - (mapping.secondary.length + mapping.supporting.length + mapping.variants.length + mapping.brand.length);

  // Plaatsing van het zoekwoord: de meting is van de code, de nieuwe tekst van
  // Claude, en alleen waar de meting zegt dat het nodig is.
  const placementReport = {};
  for (const [key, measured] of Object.entries(placement)) {
    const rewrite = measured.status === 'letterlijk' ? '' : String(model.placement?.[key] || '').trim();
    placementReport[key] = { ...measured, rewrite };
  }

  // Niet doen: alleen met een bestaande concurrent als bron.
  const avoid = (model.avoid || [])
    .map((item) => ({
      text: String(item?.text || ''),
      sources: [...new Set(Array.isArray(item?.results) ? item.results : [])]
        .map((index) => compared[index - 1])
        .filter(Boolean)
        .map(competitorRef),
    }))
    .filter((item) => item.text && item.sources.length > 0)
    .slice(0, MAX_AVOID);

  const missingTopics = topics.filter((topic) => topic.status === 'ontbreekt');
  const partialTopics = topics.filter((topic) => topic.status === 'tekst');
  const missingTerms = terms.filter((term) => !term.present);

  // Dekkingsgraad: een onderwerp weegt zwaarder naarmate meer concurrenten het
  // behandelen. Alleen in de tekst telt half, want zonder kop ziet Google het
  // minder duidelijk als onderwerp van de pagina.
  const weight = topics.reduce((sum, topic) => sum + topic.coveredBy, 0);
  const earned = topics.reduce(
    (sum, topic) => sum + topic.coveredBy * (topic.status === 'kop' ? 1 : topic.status === 'tekst' ? 0.5 : 0),
    0
  );
  const topicScore = weight ? earned / weight : 0;
  const termScore = terms.length ? (terms.length - missingTerms.length) / terms.length : 0;
  const coverageScore = topics.length || terms.length ? Math.round((topicScore * 0.65 + termScore * 0.35) * 100) : null;

  const wordCounts = compared.map((competitor) => competitor.wordCount);
  const benchmark = median(wordCounts);

  return {
    serp: serpSummary(serp, serpResults, providerLabel),
    page: pageSummary(target),
    coverage: {
      score: coverageScore,
      topicsWithHeading: topics.length - missingTopics.length - partialTopics.length,
      topicsInTextOnly: partialTopics.length,
      topicsMissing: missingTopics.length,
      topicsTotal: topics.length,
      termsPresent: terms.length - missingTerms.length,
      termsTotal: terms.length,
      wordCount: target.wordCount,
      benchmarkWordCount: benchmark,
      wordCountRange: wordCounts.length ? [Math.min(...wordCounts), Math.max(...wordCounts)] : null,
      wordCountRatio: benchmark ? Math.round((target.wordCount / benchmark) * 100) : null,
      competitorsCompared: total,
    },
    mapping,
    placement: placementReport,
    missingTopics,
    partialTopics,
    coveredTopics: topics.filter((topic) => topic.status === 'kop'),
    missingTerms,
    presentTerms: terms.filter((term) => term.present),
    questions: questionList,
    avoid,
    summary: String(model.summary || ''),
    quality: { droppedTopics, droppedMapping },
    disclaimer:
      `Vergeleken met ${total} pagina's uit de Google-top 10 (${providerLabel}). Woordenaantallen, koppen, termen, ` +
      'vragen en de plekken van het zoekwoord op de pagina zijn gemeten; paginatypes en zoekvolumes komen uit Ahrefs. ' +
      'Het oordeel over de zoekintentie, het groeperen van koppen tot onderwerpen, de keyword mapping en de voorgestelde ' +
      'teksten zijn interpretaties van Claude; elk onderwerp is gecontroleerd op letterlijke koppen bij minstens twee concurrenten.',
  };
}
