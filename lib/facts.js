/**
 * Feiten bewaken: elk cijfer dat Claude noemt, moet in de aangeleverde data staan.
 *
 * De prompts verbieden verzonnen cijfers en kennis van buiten het bericht
 * (FACT_RULES). Deze code controleert het, zoals de rest van de tool elke bewering
 * van Claude controleert: Claude krijgt alle cijfers in het bericht (zoekvolumes,
 * klikken, vertoningen, posities, woordenaantallen, de tekst en koppen van de
 * pagina's). Een getal in het antwoord dat nergens in dat bericht voorkomt, is
 * verzonnen, uitgerekend of uit het geheugen van het model, en de zin waarin het
 * staat verdwijnt. Zo haalt een jaartal, prijs of percentage dat niet in de data
 * staat nooit het rapport.
 *
 * Wat de code niet kan zien: een verzonnen feit zonder getal ("verplicht sinds de
 * nieuwe wet"). Daarvoor zijn de regels in de prompt; de controle hier vangt het
 * deel dat meetbaar is.
 */

/** Toegevoegd aan elke systeemprompt die Claude laat schrijven. */
export const FACT_RULES = `Harde regels voor feiten (de tool controleert ze):
- Noem alleen cijfers die letterlijk in het bericht staan: zoekvolumes, klikken, vertoningen, CTR, posities, moeilijkheid, verkeer, woordenaantallen, prijzen, jaartallen en percentages. Neem ze over zoals ze er staan, met hun bron: Search Console is een meting, Ahrefs een schatting. Reken niets uit (geen sommen, gemiddelden, aandelen of groeicijfers) en rond niet af.
- Ontbreekt een cijfer, of staat er "onbekend" of "niet beschikbaar", zeg dan dat het ontbreekt of laat het weg. Nooit schatten, nooit "ongeveer", "rond de" of "naar verwachting".
- Elk argument, elke aanbeveling en elke nieuwe tekst steunt op wat in het bericht staat: de tekst en koppen van de doelpagina, de koppen en gegevens van de concurrenten, of de vragen uit Google. Gebruik geen kennis van buiten het bericht: geen wetgeving, regelingen, subsidies, prijzen, merken, keurmerken, productspecificaties of jaartallen die er niet in staan, en geen "studies tonen aan" of "volgens Google".
- Een nieuwe tekst voor de pagina (kop, H1, meta title, meta description, eerste alinea) belooft alleen wat de doelpagina zelf al zegt of aanbiedt.
- Twijfel je of iets in de data staat, laat het dan weg. De tool haalt zinnen met een cijfer dat niet in het bericht staat automatisch uit het rapport.`;

// --- Getallen lezen ------------------------------------------------------------------------

/** Een getal met eventueel scheidingstekens: 5.100, 1,234, 6,2, 2.222, 2027. */
const NUMBER = /\d+(?:[.,]\d+)*/g;

/**
 * Alle waarden die een geschreven getal kan hebben. "5.100" is in het Nederlands
 * 5100 en in het Engels 5,1; "6,2" is 6,2; "1,234" kan 1234 of 1,234 zijn. Een
 * getal telt als gedekt als één van zijn lezingen in het bericht voorkomt, zodat een
 * Engels geschreven 5,100 gewoon matcht met de 5.100 die de tool meestuurde.
 */
export function numberReadings(raw) {
  const text = String(raw).trim();
  const readings = new Set();
  const separators = text.match(/[.,]/g) || [];
  if (!separators.length) {
    readings.add(Number(text));
  } else {
    const groups = text.split(/[.,]/);
    // Alle scheidingstekens zijn duizendtallen: 5.100, 1,234,567.
    if (groups.slice(1).every((group) => group.length === 3)) readings.add(Number(groups.join('')));
    // Het laatste scheidingsteken is de komma of punt voor decimalen: 6,2, 1.234,5.
    const last = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
    readings.add(Number(`${text.slice(0, last).replace(/[.,]/g, '')}.${text.slice(last + 1)}`));
  }
  return [...readings].filter(Number.isFinite);
}

/** De getallen in een tekst, met hun mogelijke waarden. */
export function numbersIn(text) {
  return [...String(text || '').matchAll(NUMBER)].map((match) => ({ raw: match[0], values: numberReadings(match[0]) }));
}

/**
 * De feitenbasis van één Claude-aanroep: elke waarde van elk getal in het bericht
 * dat Claude kreeg. Een analyse met een heel ander bericht krijgt een eigen basis.
 */
export function factBase(...texts) {
  const values = new Set();
  for (const text of texts) {
    for (const number of numbersIn(text)) number.values.forEach((value) => values.add(value));
  }
  return { values };
}

/** De getallen in een tekst die niet in de feitenbasis staan. */
export function unsupportedNumbers(text, base) {
  if (!base) return [];
  return numbersIn(text)
    .filter((number) => !number.values.some((value) => base.values.has(value)))
    .map((number) => number.raw);
}

// --- Teksten schoonmaken ---------------------------------------------------------------------

/**
 * Zinnen: een punt, uitroep- of vraagteken met spatie en daarna een hoofdletter,
 * cijfer of aanhalingsteken. "5.100" en "bijv. een" breken zo niet af.
 */
function sentences(text) {
  return String(text || '').split(/(?<=[.!?…])\s+(?=[\p{Lu}\d"“‘'(])/u).filter((part) => part.trim());
}

/**
 * Laat alleen de zinnen staan waarvan elk getal in de feitenbasis staat. `log`
 * verzamelt wat er wegviel, voor de logs en de telling in het rapport.
 */
export function groundText(text, base, log, field) {
  const value = String(text || '');
  if (!base || !value) return value;
  const kept = [];
  for (const sentence of sentences(value)) {
    const missing = unsupportedNumbers(sentence, base);
    if (missing.length) log?.push({ field, text: sentence.trim(), numbers: missing });
    else kept.push(sentence.trim());
  }
  return kept.join(' ');
}

/** Een tekst die als geheel op de pagina komt (een kop, een H1): één verzonnen cijfer en hij valt weg. */
export function groundCopy(text, base, log, field) {
  const value = String(text || '');
  if (!base || !value) return value;
  const missing = unsupportedNumbers(value, base);
  if (!missing.length) return value;
  log?.push({ field, text: value, numbers: missing });
  return '';
}

// --- Per Claude-aanroep ---------------------------------------------------------------------

/** De intent check: het oordeel blijft, zinnen met een onbekend cijfer verdwijnen. */
export function groundIntent(model, base) {
  const log = [];
  if (!base || !model) return { model, removed: log };
  const reasons = (Array.isArray(model.reasons) ? model.reasons : [])
    .map((reason, index) => ({ ...reason, text: groundText(reason?.text, base, log, `reasons[${index}]`) }))
    .filter((reason) => reason.text);
  return {
    model: {
      ...model,
      page: { ...model.page, summary: groundText(model.page?.summary, base, log, 'page.summary') },
      serp: { ...model.serp, summary: groundText(model.serp?.summary, base, log, 'serp.summary') },
      reasons,
      mismatch: model.mismatch && {
        ...model.mismatch,
        explanation: groundText(model.mismatch.explanation, base, log, 'mismatch.explanation'),
        direction: groundText(model.mismatch.direction, base, log, 'mismatch.direction'),
      },
    },
    removed: log,
  };
}

/**
 * Content gap, call 1: onderwerpen, vragen, niet doen en samenvatting. Een
 * voorgestelde kop met een onbekend cijfer maakt plaats voor de letterlijke kop van
 * een concurrent die het onderwerp onderbouwt; zonder zo'n kop valt het onderwerp weg.
 */
export function groundGapTopics(model, base) {
  const log = [];
  if (!base || !model) return { model, removed: log };

  const topics = (Array.isArray(model.topics) ? model.topics : []).map((topic, index) => {
    let heading = String(topic?.heading || '');
    const missing = unsupportedNumbers(heading, base);
    if (missing.length) {
      log.push({ field: `topics[${index}].heading`, text: heading, numbers: missing });
      const literal = (topic.sources || []).find((source) => source?.heading && !unsupportedNumbers(source.heading, base).length);
      heading = literal ? String(literal.heading) : '';
    }
    return {
      ...topic,
      heading,
      why: groundText(topic?.why, base, log, `topics[${index}].why`),
      advice: groundText(topic?.advice, base, log, `topics[${index}].advice`),
      subheadings: (Array.isArray(topic?.subheadings) ? topic.subheadings : [])
        .map((sub, subIndex) => groundCopy(sub, base, log, `topics[${index}].subheadings[${subIndex}]`))
        .filter(Boolean),
    };
  }).filter((topic) => topic.heading);

  return {
    model: {
      ...model,
      topics,
      questions: (Array.isArray(model.questions) ? model.questions : [])
        .map((item, index) => ({ ...item, angle: groundText(item?.angle, base, log, `questions[${index}].angle`) })),
      avoid: (Array.isArray(model.avoid) ? model.avoid : [])
        .map((item, index) => ({ ...item, text: groundText(item?.text, base, log, `avoid[${index}]`) }))
        .filter((item) => item.text),
      summary: groundText(model.summary, base, log, 'summary'),
    },
    removed: log,
  };
}

/**
 * Content gap, call 2: termen, keyword mapping en de nieuwe teksten. Een nieuwe
 * H1, title, meta of intro met een onbekend cijfer valt helemaal weg: die zou
 * letterlijk op de klantpagina komen.
 */
export function groundGapTerms(model, base) {
  const log = [];
  if (!base || !model) return { model, removed: log };
  const mappingGroup = (items, group) => (Array.isArray(items) ? items : [])
    .map((item, index) => ({ ...item, why: groundText(item?.why, base, log, `keywordMapping.${group}[${index}].why`) }));
  const mapping = model.keywordMapping || {};
  const placement = model.placement || {};
  return {
    model: {
      ...model,
      terms: (Array.isArray(model.terms) ? model.terms : [])
        .map((item, index) => ({ ...item, context: groundText(item?.context, base, log, `terms[${index}].context`) })),
      keywordMapping: {
        ...mapping,
        secondary: mappingGroup(mapping.secondary, 'secondary'),
        supporting: mappingGroup(mapping.supporting, 'supporting'),
        variants: mappingGroup(mapping.variants, 'variants'),
        brand: mappingGroup(mapping.brand, 'brand'),
      },
      placement: Object.fromEntries(Object.entries(placement)
        .map(([key, text]) => [key, groundCopy(text, base, log, `placement.${key}`)])),
    },
    removed: log,
  };
}

/**
 * In de functielogs van Vercel: welke zinnen de controle weghaalde. Zo zie je of
 * een prompt verzonnen cijfers blijft proberen, zonder dat het rapport ze toont.
 */
export function logRemovedClaims(label, removed) {
  if (!removed?.length) return;
  console.log(JSON.stringify({
    label: `Cijfercontrole ${label}: ${removed.length} weggelaten`,
    weggelaten: removed.map((item) => ({ veld: item.field, cijfers: item.numbers, tekst: item.text.slice(0, 160) })),
  }));
}

/** Wat de controle weghaalde, samengevat voor het rapport: hoeveel, en welke cijfers. */
export function factCheckSummary(...logs) {
  const removed = logs.flat();
  return {
    removed: removed.length,
    numbers: [...new Set(removed.flatMap((item) => item.numbers))].slice(0, 12),
  };
}

/** De herfocus: de keuze zelf controleert refocus.js tegen de lijst, hier alleen de uitleg. */
export function groundRefocus(model, base) {
  const log = [];
  if (!base || !model) return { model, removed: log };
  const why = (items, field) => (Array.isArray(items) ? items : [])
    .map((item, index) => ({ ...item, why: groundText(item?.why, base, log, `${field}[${index}].why`) }));
  return {
    model: {
      ...model,
      pageSummary: groundText(model.pageSummary, base, log, 'pageSummary'),
      pick: model.pick && { ...model.pick, why: groundText(model.pick.why, base, log, 'pick.why') },
      alternatives: why(model.alternatives, 'alternatives'),
      proposals: why(model.proposals, 'proposals'),
      rejected: groundText(model.rejected, base, log, 'rejected'),
    },
    removed: log,
  };
}
