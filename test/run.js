/**
 * Snelle controles zonder testframework: `npm test`.
 *
 * Test de code die meet en controleert; de Claude-aanroepen en de externe
 * fetches blijven buiten schot. Elke controle die faalt, stopt met exit 1.
 */

import assert from 'node:assert/strict';
import { parseGscExport } from '../lib/gsc.js';
import { phraseCoverage, normalize, repairLatexDiaeresis } from '../lib/text.js';
import { describePageType } from '../lib/pagetype.js';
import { measureSerp, keywordPlacement, verifyIntent } from '../lib/intent.js';
import { verifyRefocus } from '../lib/refocus.js';
import { mappingCandidates, buildReport, topicHeadings, termCandidates } from '../lib/compare.js';
import {
  normalizePrivateKey, readCredentials, matchProperty, pageVariants, classifyGscError, toRow, fetchPageQueries,
} from '../lib/searchconsole.js';
import { readRegion, REGIONS, regionInstruction } from '../lib/region.js';
import { createProgress } from '../lib/progress.js';
import { buildIntentMessage } from '../lib/intent.js';
import { collectKeywordRows } from '../lib/keywordsources.js';
import { passwordOk } from '../lib/auth.js';
import { mergeKeywordLists, sourceFlags, pageInsight, isMeasured } from '../lib/hybrid.js';
import {
  numberReadings, factBase, unsupportedNumbers, groundText, groundIntent, groundGapTopics, groundGapTerms, groundRefocus,
  factCheckSummary, FACT_RULES,
} from '../lib/facts.js';
import { INTENT_SYSTEM_PROMPT } from '../lib/intent.js';
import { readPage } from '../lib/page.js';
import { GAP_TOPICS_SYSTEM_PROMPT, GAP_TERMS_SYSTEM_PROMPT } from '../lib/gap.js';
import { REFOCUS_SYSTEM_PROMPT } from '../lib/refocus.js';

let passed = 0;
const queue = [];
function test(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}\n  ${error.message}`);
      process.exitCode = 1;
    }
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

test('repairLatexDiaeresis: LaTeX-trema terug naar ë, echte aanhalingstekens blijven', () => {
  const raw = JSON.stringify({ a: 'x' }).replace('x', 'commerci\\"ele, ori\\"enteert');
  assert.equal(JSON.parse(repairLatexDiaeresis(raw)).a, 'commerciële, oriënteert');
  const quoted = JSON.stringify({ b: 'het woord "energie" staat erin' });
  assert.equal(JSON.parse(repairLatexDiaeresis(quoted)).b, 'het woord "energie" staat erin');
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


// --- Search Console en de smart fallback ------------------------------------------------

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEabc\nDEF==\n-----END PRIVATE KEY-----';

test('normalizePrivateKey: letterlijke \\n, echte regeleindes, CRLF en aanhalingstekens', () => {
  const expected = PEM + '\n';
  assert.equal(normalizePrivateKey(PEM.replace(/\n/g, '\\n')), expected);
  assert.equal(normalizePrivateKey('"' + PEM.replace(/\n/g, '\\n') + '"'), expected);
  assert.equal(normalizePrivateKey(PEM), expected);
  assert.equal(normalizePrivateKey(PEM.replace(/\n/g, '\r\n')), expected);
  assert.equal(normalizePrivateKey('geen sleutel'), null);
  assert.equal(normalizePrivateKey('-----BEGIN PRIVATE KEY-----\nMIIE'), null); // afgekapt
});

test('readCredentials: niets ingesteld, half ingesteld en compleet', () => {
  assert.equal(readCredentials({}), null);
  assert.deepEqual(readCredentials({ GOOGLE_CLIENT_EMAIL: 'x@y.iam.gserviceaccount.com' }), { invalid: true });
  assert.deepEqual(readCredentials({ GOOGLE_CLIENT_EMAIL: 'x@y', GOOGLE_PRIVATE_KEY: PEM }), { email: 'x@y', key: PEM + '\n' });
});

test('matchProperty: URL-prefix gaat voor domein, niet-geverifieerd telt niet', () => {
  const sites = [
    { siteUrl: 'sc-domain:klant.nl', permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://www.klant.nl/', permissionLevel: 'siteRestrictedUser' },
    { siteUrl: 'https://www.klant.nl/blog/', permissionLevel: 'siteOwner' },
    { siteUrl: 'sc-domain:ander.nl', permissionLevel: 'siteUnverifiedUser' },
  ];
  assert.equal(matchProperty(sites, 'https://www.klant.nl/blog/artikel'), 'https://www.klant.nl/blog/');
  assert.equal(matchProperty(sites, 'https://www.klant.nl/diensten/'), 'https://www.klant.nl/');
  assert.equal(matchProperty(sites, 'https://shop.klant.nl/x'), 'sc-domain:klant.nl');
  assert.equal(matchProperty(sites, 'http://www.klant.nl/x'), 'sc-domain:klant.nl'); // http valt niet onder de https-prefix
  assert.equal(matchProperty(sites, 'https://www.ander.nl/x'), null);
  assert.equal(matchProperty(sites, 'https://nietklant.nl/x'), null); // geen suffix-truc
  assert.equal(matchProperty([], 'geen url'), null);
});

test('pageVariants: met en zonder slash, zonder trackingparameters, homepage één padvorm', () => {
  assert.deepEqual(pageVariants('https://www.x.nl/a/b/'), ['https://www.x.nl/a/b/', 'https://www.x.nl/a/b']);
  assert.deepEqual(pageVariants('https://www.x.nl/a/b'), ['https://www.x.nl/a/b', 'https://www.x.nl/a/b/']);
  assert.deepEqual(pageVariants('https://www.x.nl/a?c=1#top'),
    ['https://www.x.nl/a?c=1', 'https://www.x.nl/a/?c=1', 'https://www.x.nl/a', 'https://www.x.nl/a/']);
  assert.deepEqual(pageVariants('https://www.x.nl/a/?utm_source=nieuwsbrief'),
    ['https://www.x.nl/a/?utm_source=nieuwsbrief', 'https://www.x.nl/a?utm_source=nieuwsbrief', 'https://www.x.nl/a/', 'https://www.x.nl/a']);
  assert.deepEqual(pageVariants('https://www.x.nl/?gclid=abc'), ['https://www.x.nl/?gclid=abc', 'https://www.x.nl/']);
  assert.deepEqual(pageVariants('https://www.x.nl/'), ['https://www.x.nl/']);
});

test('classifyGscError: 403 is geen toegang, API uit, sleutel, limiet, timeout', () => {
  assert.equal(classifyGscError({ status: 403, message: "User does not have sufficient permission for site 'sc-domain:x.nl'." }).status, 'geen_toegang');
  assert.equal(classifyGscError({ status: 403, errors: [{ reason: 'accessNotConfigured' }], message: 'x' }).status, 'api_uit');
  assert.equal(classifyGscError({ status: 403, message: 'Google Search Console API has not been used in project 1 before' }).status, 'api_uit');
  assert.equal(classifyGscError({ message: 'invalid_grant: Invalid JWT Signature.' }).status, 'sleutel_ongeldig');
  assert.equal(classifyGscError({ status: 401, message: 'x' }).status, 'sleutel_ongeldig');
  assert.equal(classifyGscError({ status: 429, message: 'x' }).status, 'limiet');
  assert.equal(classifyGscError({ code: 'GSC_TIMEOUT', message: 'timeout' }).status, 'timeout');
  assert.equal(classifyGscError({ status: 500, message: 'backend' }).status, 'fout');
  assert.match(classifyGscError({ status: 403, message: 'x' }, { email: 'sa@x' }).message, /sa@x/);
});

test('toRow: CTR van fractie naar procent, afgerond', () => {
  assert.deepEqual(toRow({ keys: ['pregis paper'], clicks: 5, impressions: 484, ctr: 0.010330578, position: 13.008 }),
    { query: 'pregis paper', clicks: 5, impressions: 484, ctr: 1, position: 13 });
});

test('fetchPageQueries: ook op een publieke deploy zonder APP_PASSWORD gewoon proberen', async () => {
  // Met een kapotte sleutel komt de aanroep tot aan de sleutelcontrole: er is geen wachtwoorddrempel meer.
  const result = await fetchPageQueries('https://www.x.nl/', { env: { VERCEL_ENV: 'production', GOOGLE_CLIENT_EMAIL: 'x@y', GOOGLE_PRIVATE_KEY: 'kapot' } });
  assert.equal(result.status, 'sleutel_ongeldig');
  assert.equal(result.attempted, true);
});

test('readRegion: nl en us, onbekend of leeg wordt Nederland', () => {
  assert.equal(readRegion('us'), REGIONS.us);
  assert.equal(readRegion('US '), REGIONS.us);
  assert.equal(readRegion('nl'), REGIONS.nl);
  assert.equal(readRegion(''), REGIONS.nl);
  assert.equal(readRegion('de'), REGIONS.nl);
  assert.deepEqual([REGIONS.us.ahrefsCountry, REGIONS.us.gscCountry, REGIONS.us.serper.hl], ['us', 'usa', 'en']);
});

test('passwordOk: open zonder wachtwoord, anders exact en in constante tijd', () => {
  assert.equal(passwordOk({ headers: {} }, {}), true);
  assert.equal(passwordOk({ headers: {} }, { APP_PASSWORD: 'geheim' }), false);
  assert.equal(passwordOk({ headers: { 'x-app-password': 'gehei' } }, { APP_PASSWORD: 'geheim' }), false);
  assert.equal(passwordOk({ headers: { 'x-app-password': 'geheim' } }, { APP_PASSWORD: 'geheim' }), true);
});

test('collectKeywordRows: zonder Ahrefs-sleutel en zonder Search Console de echte oorzaak', async () => {
  await assert.rejects(
    collectKeywordRows({ mode: 'auto', pageUrl: 'https://www.x.nl/', env: {}, ahrefsKey: null }),
    (error) => error.code === 'no_ahrefs_key' && /Search Console/.test(error.message)
  );
});

test('fetchPageQueries: zonder of met halve sleutel geen crash, wel een status', async () => {
  const none = await fetchPageQueries('https://www.x.nl/', { env: {} });
  assert.equal(none.status, 'niet_ingesteld');
  assert.equal(none.error, false);
  assert.deepEqual(none.rows, []);
  const half = await fetchPageQueries('https://www.x.nl/', { env: { GOOGLE_CLIENT_EMAIL: 'x@y', GOOGLE_PRIVATE_KEY: 'kapot' } });
  assert.equal(half.status, 'sleutel_ongeldig');
  assert.equal(half.error, true);
});

test('mergeKeywordLists: gemeten eerst, Ahrefs vult aan, bron per rij', () => {
  const merged = mergeKeywordLists(
    [{ query: 'Hex Dumbbells', clicks: 10, impressions: 688, ctr: 1.5, position: 5.5 }, { query: 'hex dumbbell set', clicks: 0, impressions: 90, ctr: 0, position: 12 }],
    [{ query: 'hex dumbbells', position: 4, volume: 1300, traffic: 200, intents: { commercieel: true } }, { query: 'dumbbells', position: 30, volume: 9000, traffic: 5 }]
  );
  assert.deepEqual(merged.map((row) => [row.query, row.origin]), [['Hex Dumbbells', 'gsc+ahrefs'], ['hex dumbbell set', 'gsc'], ['dumbbells', 'ahrefs']]);
  assert.equal(merged[0].impressions, 688); // de meting blijft
  assert.equal(merged[0].position, 5.5); // de gemeten positie, niet die van Ahrefs
  assert.equal(merged[0].volume, 1300); // het volume komt erbij
  assert.equal(isMeasured(merged[0]) && isMeasured(merged[1]) && !isMeasured(merged[2]), true);
});

test('mergeKeywordLists: dubbele Ahrefs-rij wordt geen "beide"', () => {
  const merged = mergeKeywordLists([], [{ query: 'zonnepanelen kosten', position: 1, traffic: 900 }, { query: 'Zonnepanelen kosten', position: 4, traffic: 50 }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].origin, 'ahrefs');
  assert.equal(merged[0].position, 1);
  assert.equal(isMeasured(merged[0]), false);
});

test('sourceFlags: hybride, alleen Ahrefs, upload; gsc_error alleen bij een mislukte poging', () => {
  assert.deepEqual(sourceFlags({ status: 'ok', error: false }), { source: 'hybrid_gsc_ahrefs', gsc_error: false });
  assert.deepEqual(sourceFlags({ status: 'geen_toegang', error: true }), { source: 'ahrefs_only', gsc_error: true });
  assert.deepEqual(sourceFlags({ status: 'niet_ingesteld', error: false }), { source: 'ahrefs_only', gsc_error: false });
  assert.deepEqual(sourceFlags({ status: 'leeg', error: false }), { source: 'ahrefs_only', gsc_error: false });
  assert.deepEqual(sourceFlags({ status: 'ok', error: false }, { ahrefsUsed: false }), { source: 'gsc_only', gsc_error: false });
  assert.deepEqual(sourceFlags(null, { upload: true }), { source: 'gsc_upload', gsc_error: false });
  assert.deepEqual(sourceFlags({ status: 'geen_toegang', error: true }, { ahrefsUsed: false }), { source: 'serp_only', gsc_error: true });
});

test('pageInsight: het focus zoekwoord en de top-zoekopdrachten', () => {
  const gsc = { status: 'ok', rows: [{ query: 'pregis paper', impressions: 484, clicks: 5 }, { query: 'Paper Packing Machine', impressions: 99, clicks: 9 }] };
  const insight = pageInsight(gsc, 'paper packing machine');
  assert.equal(insight.focusKeyword.impressions, 99);
  // Zonder paginatotaal: de som, en eerlijk gelabeld als som van wat Search Console toont.
  assert.deepEqual(insight.totals, { queries: 2, scope: 'getoonde_zoekopdrachten', impressions: 583, clicks: 14, position: null });
  // Met paginatotaal: dat is hoger dan de som, want Google anonimiseert zeldzame zoekopdrachten.
  const withTotals = pageInsight({ ...gsc, pageTotals: { impressions: 18962, clicks: 174, ctr: 0.9, position: 9.1 } }, 'x');
  assert.deepEqual(withTotals.totals, { queries: 2, scope: 'pagina', impressions: 18962, clicks: 174, position: 9.1 });
  assert.equal(withTotals.focusKeyword, null);
  assert.equal(pageInsight({ status: 'geen_toegang', rows: [] }, 'x'), null);
});

test('mappingCandidates: Search Console-zoekopdrachten als kandidaat, na de Ahrefs-ideeën', () => {
  const candidates = mappingCandidates(
    [{ keyword: 'paper packaging systems', volume: 90, sources: ['bevat het zoekwoord'] }],
    { organic: [] },
    'paper packaging machine',
    [{ query: 'paper packaging systems', impressions: 40, position: 9.2 }, { query: 'pregis easypack', impressions: 62, position: 5 }, { query: 'paper packaging machine', impressions: 99 }]
  );
  assert.deepEqual(candidates.map((item) => item.keyword), ['paper packaging systems', 'pregis easypack']);
  assert.ok(candidates[0].sources.some((source) => source.startsWith('Search Console: 40 vertoningen')));
  assert.equal(candidates[1].volume, null);
  assert.equal(candidates[1].impressions, 62);
});

// --- Voortgang en regio ------------------------------------------------------------------

function fakeResponse() {
  const listeners = {};
  return {
    statusCode: 0, headers: {}, chunks: [], ended: false, writableEnded: false, writableFinished: false, destroyed: false, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    write(chunk) { this.chunks.push(chunk); },
    end() { this.ended = true; this.writableEnded = true; this.writableFinished = true; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.end(); },
    on(event, fn) { listeners[event] = fn; },
    emit(event) { listeners[event]?.(); },
  };
}

test('createProgress: zonder Accept-header gewoon één JSON-antwoord', () => {
  const res = fakeResponse();
  const progress = createProgress({ headers: {} }, res);
  progress.step('bronnen', 'active', 'x');
  progress.send(200, { ok: true });
  assert.equal(res.chunks.length, 0);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(res.statusCode, 200);
});

test('createProgress: met NDJSON een regel per fase en het resultaat als laatste', () => {
  const res = fakeResponse();
  const progress = createProgress({ headers: { accept: 'application/x-ndjson' } }, res);
  progress.step('bronnen', 'active', 'ophalen');
  progress.step('bronnen', 'done', 'klaar', { source: 'ahrefs_only' });
  progress.send(200, { stage: 'intent' });
  const lines = res.chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(res.headers['content-type'], 'application/x-ndjson; charset=utf-8');
  assert.deepEqual(lines.map((line) => line.type), ['progress', 'progress', 'result']);
  assert.equal(lines[1].data.source, 'ahrefs_only');
  assert.deepEqual(lines[2].data, { stage: 'intent' });
  assert.equal(res.ended, true);
});

test('createProgress: een fout na de start komt als error-regel, ervoor als gewone status', () => {
  const early = fakeResponse();
  createProgress({ headers: { accept: 'application/x-ndjson' } }, early).send(400, { error: 'x', code: 'missing_input' });
  assert.equal(early.statusCode, 400);
  assert.equal(early.body.code, 'missing_input');

  const late = fakeResponse();
  const progress = createProgress({ headers: { accept: 'application/x-ndjson' } }, late);
  progress.step('bronnen', 'active', 'x');
  progress.send(502, { error: 'Ahrefs weigert', code: 'ahrefs_auth' });
  const last = JSON.parse(late.chunks.at(-1));
  assert.deepEqual([last.type, last.status, last.code], ['error', 502, 'ahrefs_auth']);
});

test('createProgress: afgehaakte gebruiker stopt het dure werk', () => {
  const res = fakeResponse();
  const progress = createProgress({ headers: { accept: 'application/x-ndjson' } }, res);
  progress.step('bronnen', 'active', 'x');
  res.emit('close');
  assert.throws(() => progress.throwIfGone(), (error) => error.code === 'client_gone');
  progress.send(200, { stage: 'intent' }); // schrijft niets meer
  assert.equal(res.chunks.length, 1);
});

test('regionInstruction en buildIntentMessage: de regio staat bovenaan het bericht', () => {
  assert.match(regionInstruction(REGIONS.us), /Google Verenigde Staten \(US\)[\s\S]*in het Engels[\s\S]*in het Nederlands/);
  const message = buildIntentMessage({
    keyword: 'paper packaging machine',
    target: { url: 'https://x.com/', title: 't', metaDescription: '', h1: 'h', wordCount: 100, headings: [], text: 'tekst' },
    serp: { organic: [], peopleAlsoAsk: [] },
    serpResults: [],
    keywordInfo: null,
    measured: { pageTypes: [], typed: 0, total: 0, topKeywords: [], features: [], ownPosition: null },
    providerLabel: 'Ahrefs (Google Verenigde Staten)',
    gsc: { status: 'ok', startDate: '2026-06-22', endDate: '2026-09-20', country: 'usa' },
    gscInsight: { focusKeyword: null, topQueries: [], totals: { queries: 3, scope: 'pagina', impressions: 10, clicks: 1, position: 4 } },
    region: REGIONS.us,
  });
  assert.ok(message.startsWith('# Regio'));
  assert.match(message, /alleen Verenigde Staten/);
});

// --- Taal: sitekoppen en termen ------------------------------------------------------

test('topicHeadings: Engelse en Nederlandse sitekoppen weg, inhoudelijke koppen blijven', () => {
  const texts = [
    'Subscribe to our newsletter', 'Related articles', 'You may also like', 'Have questions?',
    'Need help?', 'Shopping cart', 'Lees ook', 'Nieuwsbrief',
    // Tegenvoorbeelden: dezelfde woorden, maar over het onderwerp.
    'Related costs of paper packaging', 'Need for protective packaging in e-commerce',
    'How to read more from packaging labels', 'Customer experience with void fill',
    'Wat kost een zonnepaneel?',
  ];
  const kept = topicHeadings({ headings: texts.map((text) => ({ level: 2, text })) }).map((heading) => heading.text);
  assert.deepEqual(kept, [
    'Related costs of paper packaging', 'Need for protective packaging in e-commerce',
    'How to read more from packaging labels', 'Customer experience with void fill',
    'Wat kost een zonnepaneel?',
  ]);
});

test('termCandidates: Engelse opvulwoorden alleen weg bij regio US, vaktermen blijven', () => {
  const us = [1, 2, 3].map(() => ({
    title: 'Paper cushioning',
    text: 'Choose the best settings for your paper cushioning machine. Subscribe to our newsletter. A landing page explains the checkout flow.',
  }));
  const target = { title: '', metaDescription: '', text: '' };
  const usTerms = termCandidates(us, target, 'paper packaging', { region: REGIONS.us }).map((c) => c.term);
  for (const term of ['cushioning', 'paper cushioning', 'landing page', 'checkout']) assert.ok(usTerms.includes(term), `${term} ontbreekt`);
  for (const term of ['settings', 'best settings', 'subscribe']) assert.ok(!usTerms.includes(term), `${term} hoort er niet in`);

  // Nederlands: Engelse leenwoorden zijn hier vaak gewoon vakterm.
  const nl = [1, 2, 3].map(() => ({
    title: 'Conversie',
    text: 'Een goede landing page heeft een duidelijke call to action en een snelle checkout voor elke bezoeker.',
  }));
  const nlTerms = termCandidates(nl, target, 'conversie', { region: REGIONS.nl }).map((c) => c.term);
  for (const term of ['landing page', 'checkout', 'duidelijke call']) assert.ok(nlTerms.includes(term), `${term} ontbreekt`);
});

// --- Feiten: elk cijfer van Claude moet in het bericht staan ----------------------------

test('facts: getallen in Nederlandse en Engelse notatie hebben dezelfde waarde', () => {
  assert.deepEqual(numberReadings('5.100'), [5100, 5.1]);
  assert.deepEqual(numberReadings('6,2'), [6.2]);
  assert.deepEqual(numberReadings('1.234,5'), [1234.5]);
  const base = factBase('Zoekvolume: 5.100 per maand · gemiddelde positie 6,2 · 1.234 vertoningen');
  // Engels geschreven door het model, Nederlands meegestuurd door de tool: gedekt.
  assert.deepEqual(unsupportedNumbers('5,100 searches, position 6.2, 1,234 impressions', base), []);
  assert.deepEqual(unsupportedNumbers('Na 2027 vervalt de regeling en je dekt 46% van de onderwerpen.', base), ['2027', '46']);
});

test('facts: een zin met een verzonnen cijfer verdwijnt, de rest blijft', () => {
  const base = factBase('Volume 5.100 per maand. Koppen: "Wat verandert er na de afschaffing van de salderingsregeling?"');
  const log = [];
  const text = groundText('Bijna alle concurrenten leggen uit wat salderen oplevert. Na 2027 vervalt de regeling. Het volume is 5.100 per maand.', base, log, 'summary');
  assert.equal(text, 'Bijna alle concurrenten leggen uit wat salderen oplevert. Het volume is 5.100 per maand.');
  assert.deepEqual(log.map((item) => item.numbers), [['2027']]);
  // Decimalen en duizendtallen breken een zin niet op.
  assert.equal(groundText('Je staat op 6,2 gemiddeld. Het volume is 5.100.', factBase('6,2 5.100'), [], 'x'), 'Je staat op 6,2 gemiddeld. Het volume is 5.100.');
});

test('groundIntent: argument met een verzonnen cijfer valt weg, het oordeel blijft', () => {
  const base = factBase('Zoekvolume: 5.100 per maand · positie 3');
  const { model, removed } = groundIntent({
    match: true,
    page: { summary: 'Een webshop.' },
    serp: { summary: 'De zoeker wil kopen.' },
    reasons: [{ text: 'Je staat al op positie 3.', positions: [3] }, { text: 'Er zijn 12.000 zoekopdrachten per maand.', positions: [] }],
    mismatch: { kind: 'geen', explanation: '', direction: '' },
  }, base);
  assert.equal(model.match, true);
  assert.deepEqual(model.reasons.map((reason) => reason.text), ['Je staat al op positie 3.']);
  assert.equal(removed.length, 1);
  assert.deepEqual(factCheckSummary(removed), { removed: 1, numbers: ['12.000'] });
});

test('groundGapTopics: kop met een verzonnen jaartal wordt de letterlijke concurrentkop', () => {
  const base = factBase('Koppen: Salderen en terugleveren | Wat verandert er na de afschaffing van de salderingsregeling?');
  const { model } = groundGapTopics({
    topics: [
      { heading: 'Salderingsregeling, terugleveren en wat er na 2027 verandert', why: 'Bijna iedereen legt het uit.', advice: 'Voeg een blok toe.', subheadings: ['Wat kost 1 paneel in 2026?', 'Zelf verbruiken'], sources: [{ result: 1, heading: 'Salderen en terugleveren' }], coverage: 'ontbreekt' },
      { heading: 'Prijzen in 2026', why: 'x', advice: 'y', subheadings: [], sources: [{ result: 2, heading: 'Prijzen in 2026' }], coverage: 'ontbreekt' },
    ],
    questions: [{ index: 1, angle: 'Noem de kosten. Reken op 400 euro per paneel.', coverage: 'ontbreekt' }],
    avoid: [{ text: 'Geen 10 jaar garantie beloven.', results: [1] }],
    summary: 'Pak de saldering aan.',
  }, base);
  assert.equal(model.topics.length, 1);
  assert.equal(model.topics[0].heading, 'Salderen en terugleveren');
  assert.deepEqual(model.topics[0].subheadings, ['Zelf verbruiken']);
  assert.equal(model.questions[0].angle, 'Noem de kosten.');
  assert.equal(model.avoid.length, 0);
  assert.equal(model.summary, 'Pak de saldering aan.');
});

test('groundGapTerms: nieuwe paginatekst met een verzonnen cijfer valt helemaal weg', () => {
  const base = factBase('Tekst van de pagina: 100% gerecycled papier, 5.100 per maand');
  const { model, removed } = groundGapTerms({
    terms: [{ term: 'papier', context: 'Kern van het aanbod.' }],
    keywordMapping: { secondary: [{ keyword: 'paper', why: 'Zelfde intentie, 5.100 per maand.' }], supporting: [], variants: [], brand: [] },
    placement: { h1: 'Papier op maat', title: '', metaDescription: 'Bestel vandaag, 30 dagen retour.', intro: '100% gerecycled papier voor je verpakking.' },
  }, base);
  assert.equal(model.placement.h1, 'Papier op maat');
  assert.equal(model.placement.metaDescription, '');
  assert.equal(model.placement.intro, '100% gerecycled papier voor je verpakking.');
  assert.equal(model.keywordMapping.secondary[0].why, 'Zelfde intentie, 5.100 per maand.');
  assert.deepEqual(removed.map((item) => item.field), ['placement.metaDescription']);
});

test('groundRefocus: uitleg met een verzonnen volume verdwijnt, de keuze blijft voor de lijstcontrole', () => {
  const base = factBase('1. "zonnepanelen kopen": [Search Console] 38.500 vertoningen');
  const { model } = groundRefocus({
    pageSummary: 'Een webshop.',
    found: true,
    pick: { keyword: 'zonnepanelen kopen', why: 'Past bij de webshop. De pagina krijgt 38.500 vertoningen.' },
    alternatives: [{ keyword: 'x', why: 'Heeft 9.900 zoekopdrachten.', fit: 'matig' }],
    proposals: [],
    rejected: '',
  }, base);
  assert.equal(model.pick.keyword, 'zonnepanelen kopen');
  assert.equal(model.pick.why, 'Past bij de webshop. De pagina krijgt 38.500 vertoningen.');
  assert.equal(model.alternatives[0].why, '');
});

test('prompts: alle vier de Claude-aanroepen hebben de harde feitregels', () => {
  for (const prompt of [INTENT_SYSTEM_PROMPT, GAP_TOPICS_SYSTEM_PROMPT, GAP_TERMS_SYSTEM_PROMPT, REFOCUS_SYSTEM_PROMPT]) {
    assert.ok(prompt.includes(FACT_RULES));
  }
  assert.match(FACT_RULES, /letterlijk in het bericht/);
  assert.match(FACT_RULES, /Nooit schatten/);
});

// --- Pagina uitlezen: alleen de hoofdinhoud -----------------------------------------------

const SHOP_HTML = `<!doctype html><html><head><title>Zonnepanelen kopen | Solar Shop</title>
<meta content="Koop zonnepanelen online." name="description"></head><body>
<ul class="hidden-data hidden"><li>94720183235</li><li>ja</li><li>live</li></ul>
<div class="topbar usp-bar">Bel 033-4617740 · Gratis verzending</div>
<header id="top"><a href="/">Solar Shop</a><div class="account">Inloggen Mijn account</div>
<div class="mini-cart">Winkelwagen Uw winkelwagen is leeg</div><nav><a>Zonnepanelen</a><a>Omvormers</a></nav></header>
<div id="cookie-consent">Deze website maakt gebruik van cookies. Akkoord?</div>
<section class="intro"><h1>Zonnepanelen kopen</h1>
<p class="author-line">Door Jan · Bijgewerkt op 1 maart 2026</p>
<p>Bij Solar Shop koop je zonnepanelen van topmerken zoals AEG en Aiko, scherp geprijsd en snel geleverd. <a class="read-more">Toon meer</a></p>
<p>Kies uit glas-glas en full black panelen voor elk dak.</p></section>
<section id="collection"><div class="filters">Filter Wis alle filters Sorteer Laagste prijs</div>
<form class="product-list"><div class="card"><h3>AEG 450 Wp paneel</h3><div class="card-footer">€ 129 per stuk, op voorraad, morgen in huis</div></div>
<div class="card"><h3>Aiko 485 Wp Gen3</h3><div class="card-footer">€ 149 per stuk, op voorraad, morgen in huis</div></div>
<p>Alle panelen hebben 25 jaar productgarantie en worden geleverd met montagemateriaal naar keuze, zodat je direct aan de slag kunt met je installatie.</p>
<p>Twijfel je over het aantal panelen? Onze opbrengstcalculator rekent het voor je uit op basis van je dak en je verbruik.</p></form>
<form class="newsletter-signup"><h2>Nieuwsbrief</h2>Schrijf je in</form></section>
<footer><h4>Klantenservice</h4>Bel ons op 033-4617740</footer></body></html>`;

test('readPage: geen titel, header, winkelwagen, cookies of telefoonnummer in de tekst', () => {
  const page = readPage(SHOP_HTML);
  assert.equal(page.title, 'Zonnepanelen kopen | Solar Shop');
  assert.equal(page.metaDescription, 'Koop zonnepanelen online.');
  assert.equal(page.h1, 'Zonnepanelen kopen');
  for (const junk of ['Solar Shop Zonnepanelen', 'Winkelwagen', 'Inloggen', 'cookies', '033-4617740', '94720183235', 'Wis alle filters', 'Nieuwsbrief', 'Klantenservice', 'Toon meer']) {
    assert.ok(!page.text.includes(junk), `"${junk}" hoort niet in de tekst`);
  }
  assert.ok(page.text.startsWith('Zonnepanelen kopen'));
  // De productlijst staat in een formulier en in "card-footer"s: dat is wel inhoud.
  assert.ok(page.text.includes('AEG 450 Wp paneel') && page.text.includes('€ 129 per stuk'));
  assert.deepEqual(page.headings.map((heading) => heading.text), ['Zonnepanelen kopen', 'AEG 450 Wp paneel', 'Aiko 485 Wp Gen3']);
});

test('readPage: de eerste alinea is de eerste echte alinea na de H1, zonder auteursregel of knoptekst', () => {
  const page = readPage(SHOP_HTML);
  assert.equal(page.intro, 'Bij Solar Shop koop je zonnepanelen van topmerken zoals AEG en Aiko, scherp geprijsd en snel geleverd. Kies uit glas-glas en full black panelen voor elk dak.');
  // En de meting gebruikt die alinea, niet de titel: daar staat "kopen" wél in, in de alinea niet ("koop").
  assert.equal(keywordPlacement(page, 'zonnepanelen kopen').intro.status, 'ontbreekt');
  assert.equal(keywordPlacement(page, 'zonnepanelen kopen').title.status, 'letterlijk');
});

test('readPage: kiest <main>, en een kop in een artikel is inhoud', () => {
  const html = `<html><body><div class="site-header"><a>Home</a><a>Over ons</a><a>Contact</a></div>
<main><article><header class="article-header"><h1>Wat kosten zonnepanelen?</h1></header>
<p>Een set van tien panelen kost inclusief installatie een paar duizend euro, afhankelijk van merk en dak.</p>
<div class="section-header"><h2>Terugverdientijd</h2></div><p>De terugverdientijd hangt af van je verbruik en de stroomprijs, meestal enkele jaren.</p>
<div class="cookieconsent-optout"><p>Accepteer de cookies om deze inhoud te bekijken</p></div></article>
<aside><h3>Lees ook</h3><a>Thuisbatterij</a></aside></main><div class="footer">© 2026</div></body></html>`;
  const page = readPage(html);
  assert.deepEqual(page.headings.map((heading) => heading.text), ['Wat kosten zonnepanelen?', 'Terugverdientijd']);
  assert.ok(!/Home|Over ons|Lees ook|©|cookies/.test(page.text));
  assert.match(page.intro, /^Een set van tien panelen/);
});

test('readPage: React-streaming in <div hidden id="S:..."> is gewone inhoud, een echt verborgen blok niet', () => {
  const html = `<html><body><div id="S:3" hidden><h1>Vind een installateur</h1><p>Vergelijk de beste zonnepanelen-installateurs in jouw regio op prijs, reviews en ervaring.</p></div>
<div hidden>Geheime beheertekst die niemand ziet</div><div style="display: none">Ook onzichtbaar</div></body></html>`;
  const page = readPage(html);
  assert.equal(page.h1, 'Vind een installateur');
  assert.ok(page.text.includes('Vergelijk de beste'));
  assert.ok(!/Geheime|onzichtbaar/.test(page.text));
});

test('readPage: rommelige HTML zonder <body> en zonder inhoudsblok valt terug op de hele pagina', () => {
  const html = `<div id="header"><a>Sign In</a> Cart (0) Call 877-826-9379</div><div id="info"><div class="product-header"><h1>Kraft Paper System</h1></div>
<p>Converts kraft paper rolls into crumpled cushioning and void fill for packing and shipping.</p></div><div id="footer">Contact us</div>`;
  const page = readPage(html);
  assert.equal(page.h1, 'Kraft Paper System');
  assert.ok(!/Sign In|Cart|877|Contact us/.test(page.text));
  assert.match(page.intro, /^Converts kraft paper rolls/);
});

await runAll();
console.log(`\n${passed} controles geslaagd${process.exitCode ? ', met fouten' : ''}.`);
