/**
 * Snelle controles zonder testframework: `npm test`.
 *
 * Test de code die meet en controleert; de Claude-aanroepen en de externe
 * fetches blijven buiten schot. Elke controle die faalt, stopt met exit 1.
 */

import assert from 'node:assert/strict';
import { parseGscExport } from '../lib/gsc.js';
import { phraseCoverage, normalize } from '../lib/text.js';
import { describePageType } from '../lib/pagetype.js';
import { measureSerp, keywordPlacement, verifyIntent } from '../lib/intent.js';
import { verifyRefocus } from '../lib/refocus.js';
import { mappingCandidates, buildReport } from '../lib/compare.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}\n  ${error.message}`);
    process.exitCode = 1;
  }
}

// --- Search Console-export ---------------------------------------------------------

test('GSC-export: Nederlandse CSV met puntkomma en Nederlandse getallen', () => {
  const csv = [
    'Meest gebruikte zoekopdrachten;Klikken;Vertoningen;CTR;Positie',
    'hex dumbbells;120;1.234;9,7%;5,5',
    '"dumbbells, hex";3;40;7,5%;12,1',
    'zonnepanelen kopen;0;12;0%;48,3',
  ].join('\n');
  const rows = parseGscExport(csv);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { query: 'hex dumbbells', clicks: 120, impressions: 1234, ctr: 9.7, position: 5.5 });
  assert.equal(rows[1].query, 'dumbbells, hex');
  assert.equal(rows[1].position, 12.1);
});

test('GSC-export: Engelse CSV met komma en duizendtallen tussen aanhalingstekens', () => {
  const csv = [
    'Top queries,Clicks,Impressions,CTR,Position',
    'paper packaging systems,"1,050","22,300",4.71%,6.2',
    'pregis,900,"1,500",60%,1.1',
  ].join('\r\n');
  const rows = parseGscExport(csv);
  assert.equal(rows[0].query, 'paper packaging systems');
  assert.equal(rows[0].clicks, 1050);
  assert.equal(rows[0].impressions, 22300);
  assert.equal(rows[0].ctr, 4.7);
  assert.equal(rows[0].position, 6.2);
});

test('GSC-export: JSON in de vorm van de Search Console API', () => {
  const json = JSON.stringify({
    rows: [
      { keys: ['compact paper void fill machine'], clicks: 4, impressions: 300, ctr: 0.0133, position: 8.4 },
      { keys: ['bantam'], clicks: 40, impressions: 100, ctr: 0.4, position: 1.2 },
    ],
  });
  const rows = parseGscExport(json);
  assert.equal(rows[0].query, 'compact paper void fill machine'); // gesorteerd op vertoningen
  assert.equal(rows[0].ctr, 1.3);
  assert.equal(rows[1].query, 'bantam');
});

test('GSC-export: dubbele zoekopdrachten worden samengevoegd, lege rijen overgeslagen', () => {
  const csv = 'Zoekopdracht\tKlikken\tVertoningen\nhex dumbbells\t1\t10\nhex dumbbells\t5\t50\n\t0\t0\n';
  const rows = parseGscExport(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].impressions, 50);
});

test('GSC-export: een bestand zonder herkenbare kolommen geeft een nette fout', () => {
  assert.throws(() => parseGscExport('1;2;3\n4;5;6'), (error) => error.code === 'gsc_no_queries');
  assert.throws(() => parseGscExport('   '), (error) => error.code === 'gsc_empty');
});

// --- Tekst ---------------------------------------------------------------------------

test('phraseCoverage: letterlijk, los en ontbreekt', () => {
  assert.equal(phraseCoverage('Professionele Hex dumbbells koop je bij Fitness Seller', 'hex dumbbells'), 'letterlijk');
  assert.equal(phraseCoverage('Deze hex dumbbell is ideaal voor thuis', 'hex dumbbells'), 'letterlijk'); // verbuiging telt mee
  assert.equal(phraseCoverage('Wil je zonnepanelen kopen tegen een scherpe prijs?', 'zonnepanelen kopen'), 'letterlijk');
  assert.equal(phraseCoverage('Dumbbells in hex-vorm rollen niet weg', 'hex dumbbells'), 'los');
  assert.equal(phraseCoverage('Kettlebells voor thuis', 'hex dumbbells'), 'ontbreekt');
  assert.equal(phraseCoverage('', 'hex dumbbells'), 'ontbreekt');
});

// --- Paginatypes -------------------------------------------------------------------

test('describePageType: Ahrefs-hiërarchie naar Nederlands label', () => {
  assert.deepEqual(describePageType('/Listing_Collection,/Listing_Collection/Product'), {
    raw: '/Listing_Collection,/Listing_Collection/Product', family: 'overzichtspagina', label: 'productoverzicht',
  });
  assert.equal(describePageType('/Article,/Article/Tutorial_or_Guide').label, 'gids of uitleg');
  assert.equal(describePageType('/Core_Page,/Core_Page/Homepage').label, 'homepage');
  assert.equal(describePageType('/Article').label, 'artikel');
  assert.equal(describePageType('/Weird_Family,/Weird_Family/Some_Thing').label, 'some thing');
  assert.equal(describePageType(null), null);
});

// --- Intent check --------------------------------------------------------------------

const serp = {
  provider: 'ahrefs',
  updatedAt: '2026-09-19T09:36:00Z',
  organic: [
    { position: 1, url: 'https://a.nl/x', domain: 'a.nl', title: 'A', pageType: '/Listing_Collection,/Listing_Collection/Product', topKeyword: 'zonnepanelen', topKeywordVolume: 33000 },
    { position: 3, url: 'https://b.nl/x', domain: 'b.nl', title: 'B', pageType: '/Listing_Collection,/Listing_Collection/Product', topKeyword: 'zonnepanelen', topKeywordVolume: 33000 },
    { position: 5, url: 'https://c.nl/x', domain: 'c.nl', title: 'C', pageType: '/Article,/Article/Tutorial_or_Guide', topKeyword: 'zonnepanelen kosten', topKeywordVolume: 2000 },
    { position: 6, url: 'https://d.nl/x', domain: 'd.nl', title: 'D', pageType: null, topKeyword: null, topKeywordVolume: null },
  ],
  peopleAlsoAsk: [],
  relatedSearches: [],
  features: [{ type: 'question', count: 4 }, { type: 'local_pack', count: 2 }],
};
const serpResults = serp.organic.map((result) => ({ ...result, status: result.position === 3 ? 'jouw pagina' : 'vergeleken' }));

test('measureSerp: telt paginatypes, topzoekwoorden en de eigen positie', () => {
  const measured = measureSerp({ serp, serpResults });
  assert.equal(measured.total, 4);
  assert.equal(measured.typed, 3);
  assert.equal(measured.dominant.label, 'productoverzicht');
  assert.deepEqual(measured.dominant.positions, [1, 3]);
  assert.equal(measured.topKeywords[0].keyword, 'zonnepanelen');
  assert.equal(measured.topKeywords[0].count, 2);
  assert.equal(measured.ownPosition, 3);
});

test('verifyIntent: posities die niet bestaan verdwijnen, enums vallen terug', () => {
  const verified = verifyIntent({
    page: { pageType: 'productoverzicht', intentType: 'commercieel', summary: 'Verkoopt panelen.' },
    serp: { dominantPageType: 'productoverzicht', intentType: 'commercieel', summary: 'Wil kopen.', positions: [1, 3, 99] },
    match: false,
    confidence: 'onzin',
    reasons: [{ text: 'Twee overzichten.', positions: [1, 3, 42] }, { text: '', positions: [1] }],
    mismatch: { kind: 'geen', explanation: 'x', direction: 'y' },
  }, { serp });
  assert.equal(verified.match, false);
  assert.equal(verified.confidence, 'middel');
  assert.deepEqual(verified.serp.positions, [1, 3]);
  assert.equal(verified.reasons.length, 1);
  assert.deepEqual(verified.reasons[0].positions, [1, 3]);
  assert.equal(verified.mismatch.kind, 'onbekend');
});

test('keywordPlacement: meet H1, title, meta description en intro', () => {
  const target = {
    h1: 'Hex Dumbbells',
    title: 'Professionele Hex dumbbells koop je bij Fitness Seller',
    metaDescription: 'Ontdek ons assortiment dumbbells.',
    text: 'Op zoek naar dumbbells met een hex vorm? ' + 'woord '.repeat(200),
  };
  const placement = keywordPlacement(target, 'hex dumbbells');
  assert.equal(placement.h1.status, 'letterlijk');
  assert.equal(placement.title.status, 'letterlijk');
  assert.equal(placement.metaDescription.status, 'ontbreekt');
  assert.equal(placement.intro.status, 'los');
});

// --- Herfocus ------------------------------------------------------------------------

test('verifyRefocus: een keuze moet letterlijk in de lijst staan', () => {
  const rows = [{ query: 'hex dumbbells', impressions: 688 }, { query: 'dumbbells', impressions: 4000 }];
  const verified = verifyRefocus({
    pageSummary: 'Productoverzicht.',
    found: true,
    pick: { keyword: 'Hex Dumbbells', why: 'Past.' },
    alternatives: [{ keyword: 'dumbbells', why: 'Te breed.', fit: 'matig' }, { keyword: 'kettlebells', why: 'Staat niet in de lijst.', fit: 'goed' }],
    proposals: [],
    rejected: 'Rest is merk.',
  }, rows);
  assert.equal(verified.pick.keyword, 'hex dumbbells');
  assert.equal(verified.alternatives.length, 1);
  assert.equal(verified.alternatives[0].fit, 'matig');
});

test('verifyRefocus: zonder match blijven alleen de voorstellen over', () => {
  const verified = verifyRefocus({
    pageSummary: 'x', found: false, pick: { keyword: '', why: '' }, alternatives: [],
    proposals: [{ keyword: ' Compact Paper Void Fill Machine ', why: 'Past.' }], rejected: 'Niets past.',
  }, [{ query: 'pregis' }]);
  assert.equal(verified.pick, null);
  assert.deepEqual(verified.proposals, [{ keyword: 'compact paper void fill machine', why: 'Past.' }]);
});

// --- Keyword mapping en rapport ----------------------------------------------------------

test('mappingCandidates: ideeën plus topzoekwoorden, zonder het focus zoekwoord', () => {
  const ideas = [
    { keyword: 'zonnepanelen kopen', volume: 5100, sources: ['bevat het zoekwoord'] },
    { keyword: 'losse zonnepanelen kopen', volume: 300, sources: ['bevat het zoekwoord'] },
    { keyword: 'zonnepanelen', volume: 33000, sources: ['top 10 rankt er ook op'] },
  ];
  const candidates = mappingCandidates(ideas, serp, 'zonnepanelen kopen');
  assert.equal(candidates.some((item) => normalize(item.keyword) === 'zonnepanelen kopen'), false);
  const parent = candidates.find((item) => item.keyword === 'zonnepanelen');
  assert.ok(parent.sources.includes('topzoekwoord van #1'));
  assert.equal(candidates[0].keyword, 'zonnepanelen');
  assert.ok(candidates.some((item) => item.keyword === 'zonnepanelen kosten'));
});

test('buildReport: mapping, plaatsing en "niet doen" worden gecontroleerd', () => {
  const page = (headings) => ({ title: 't', metaDescription: '', text: 'tekst over zonnepanelen en subsidie en de terugverdientijd', headings, wordCount: 300 });
  const compared = [
    { position: 1, domain: 'a.nl', url: 'https://a.nl/x', title: 'A', wordCount: 900, page: page([{ level: 'H2', text: 'Wat kosten zonnepanelen?' }]) },
    { position: 3, domain: 'b.nl', url: 'https://b.nl/x', title: 'B', wordCount: 700, page: page([{ level: 'H2', text: 'Kosten van zonnepanelen' }]) },
  ];
  const target = { url: 'https://mijn.nl/p', title: 'Mijn pagina', metaDescription: '', h1: 'Mijn H1', text: 'Zonnepanelen kopen doe je hier.', wordCount: 120, headings: [] };
  const report = buildReport({
    keyword: 'zonnepanelen kopen',
    target,
    serp,
    serpResults,
    compared,
    candidates: [{ key: 'subsidi', term: 'subsidie', usedBy: 2, present: true }],
    questions: [],
    model: {
      topics: [{
        heading: 'Wat kosten zonnepanelen?', level: 'H2', why: 'Iedereen noemt kosten.', advice: 'Voeg een kostenblok toe.',
        sources: [{ result: 1, heading: 'Wat kosten zonnepanelen?' }, { result: 2, heading: 'Kosten van zonnepanelen' }, { result: 7, heading: 'Bestaat niet' }],
        coverage: 'ontbreekt', subheadings: [],
      }],
      terms: [{ term: 'subsidie', context: 'Regeling.' }, { term: 'verzonnen', context: 'x' }],
      questions: [],
      keywordMapping: {
        secondary: [{ keyword: 'zonnepanelen', why: 'Parent.' }],
        supporting: [{ keyword: 'zonnepanelen', why: 'Dubbel.' }, { keyword: 'niet in lijst', why: 'x' }],
        variants: [],
        brand: [],
      },
      placement: { h1: 'Zonnepanelen kopen bij Mijn', title: 'genegeerd want al goed', metaDescription: 'Nieuwe meta.', intro: '' },
      avoid: [{ text: 'Geen lange blogtekst.', results: [1] }, { text: 'Zonder bron.', results: [9] }],
      summary: 'Samenvatting.',
    },
    mappingCandidates: [{ keyword: 'zonnepanelen', volume: 33000, sources: ['top 10 rankt er ook op'] }],
    placement: {
      h1: { text: 'Mijn H1', status: 'ontbreekt' },
      title: { text: 'Zonnepanelen kopen', status: 'letterlijk' },
      metaDescription: { text: '', status: 'ontbreekt' },
      intro: { text: 'Zonnepanelen kopen doe je hier.', status: 'letterlijk' },
    },
    providerLabel: 'Ahrefs (test)',
  });

  assert.equal(report.missingTopics.length, 1);
  assert.equal(report.missingTopics[0].sources.length, 2);
  assert.equal(report.missingTopics[0].advice, 'Voeg een kostenblok toe.');
  assert.equal(report.presentTerms.length, 1);
  assert.equal(report.mapping.secondary[0].keyword, 'zonnepanelen');
  assert.equal(report.mapping.supporting.length, 0); // dubbel en onbekend afgekeurd
  assert.equal(report.quality.droppedMapping, 2);
  assert.equal(report.placement.h1.rewrite, 'Zonnepanelen kopen bij Mijn');
  assert.equal(report.placement.title.rewrite, ''); // al letterlijk aanwezig
  assert.equal(report.placement.metaDescription.rewrite, 'Nieuwe meta.');
  assert.equal(report.avoid.length, 1);
  assert.equal(report.avoid[0].sources[0].domain, 'a.nl');
  assert.equal(report.summary, 'Samenvatting.');
  assert.equal(report.serp.results[0].pageTypeLabel, 'productoverzicht');
});

console.log(`\n${passed} controles geslaagd${process.exitCode ? ', met fouten' : ''}.`);
