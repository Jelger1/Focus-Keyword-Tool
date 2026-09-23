# CLAUDE.md — Keyword Focus & Intent Check

Vaste instructieset voor dit project. Lees dit bestand voordat je code wijzigt.

> Dit project is de opvolger van de SEO Content Gap Analyzer en hergebruikt het
> designsysteem van de eerdere interne tools. De content gap is nu de laatste
> stap; de tool controleert eerst of het focus zoekwoord überhaupt bij de pagina
> past. Zoek niet naar CRO- of Google Ads-functionaliteit: die bestaat hier niet.

---

## Wat de tool doet

Een marketeer vult twee dingen in:

1. **Doel-URL** — de klantpagina die moet ranken.
2. **Focus zoekwoord** — het zoekwoord waarop die pagina moet scoren.

De tool haalt de pagina op, haalt de Google-top 10 (NL) voor dat zoekwoord op via
Ahrefs, leest die pagina's op dezelfde manier uit en beantwoordt eerst de
hoofdvraag: **komt het doel van deze pagina overeen met de gemeenschappelijke
intentie van de SERP?**

| Uitkomst | Wat er gebeurt |
|---|---|
| Match | Keyword mapping (primary, secondary, supporting, varianten, merktermen), focus keyword optimalisatie (H1, title, meta, eerste alinea), aanbevelingen met SERP-bewijs, semantische termen, vragen, "niet doen", samenvatting. |
| Geen match | De marketeer laadt een Search Console-export in (of kiest de Ahrefs-schatting). Claude kiest daaruit een passend zoekwoord (B1) of stelt er zelf een voor dat de code op zoekvolume checkt (B2). Met dat zoekwoord start automatisch een nieuwe analyse, maximaal twee rondes. |

De output is een dashboard van kaarten, kopieerbaar per suggestie én in één keer
als markdown, en te downloaden als pdf voor de klant, in de opbouw van onze focus
keyword-documenten.

---

## Architectuur

Geen framework, geen build-stap. Statische bestanden plus Vercel Serverless
Functions.

| Pad | Rol |
|---|---|
| `index.html` | De volledige UI: chrome, formulier, stappenbalk, resultaatkaart, `<template>` voor de ladende staat. |
| `styles.css` | Het designsysteem: kaarten, knoppen, invoervelden, labels, stappen, oordeel, dropzone, skeletons, en de rapportcomponenten (kerncijfers, bronlabels, tabellen, aanbevelingen). |
| `print.css` | Het rapport als A4-pdf (alleen bij afdrukken): merkkop, kop- en voetregel met paginanummers, pagina-einden, compactere opmaak. |
| `fonts/` | Open Sans als statische woff2 (OFL). Het variabele font van Google Fonts komt in een pdf als Type3 terecht; deze als TrueType. |
| `report.js` | Het rapport: alle kaarten in de opbouw van onze focus keyword-documenten, met de bron bij elk cijfer. |
| `pdf.js` | Het moment van afdrukken: bestandsnaam, kantlijnteksten, uitklapblokken open, eenmalige uitleg bij "download als pdf". |
| `app.js` | Frontend-flow: analyse, herfocus, automatische heranalyse, kopieerknoppen, markdown-export. Laadt als laatste. |
| `api/analyze.js` | Verzamelen, intent check en bij een match de content gap. Dun: het echte werk zit in `lib/`. |
| `api/refocus.js` | Scenario B: een beter zoekwoord zoeken. |
| `lib/ahrefs.js` | Alle Ahrefs-calls. Velden, timeouts en foutmeldingen staan alleen hier. |
| `lib/serp.js` | Provider-schakelaar (Ahrefs standaard, Serper terugval). Wisselen van provider = alleen dit bestand. |
| `lib/page.js` | Pagina's ophalen en uitlezen, voor doelpagina én concurrenten identiek. |
| `lib/intent.js` | Meten (paginatypes, topzoekwoorden, eigen positie, plaatsing van het zoekwoord), de intent-instructie, de controle van het oordeel. |
| `lib/gap.js` | Instructie en schema van de content gap-call. |
| `lib/compare.js` | Termen tellen, vragen verzamelen, mapping-kandidaten, en elke bewering van Claude controleren (`buildReport`). |
| `lib/refocus.js` | Instructie, schema en controle van de herfocus. |
| `lib/gsc.js` | Search Console-exports lezen. |
| `lib/searchconsole.js` | Search Console API via een service account. Gooit nooit; geeft altijd een status. |
| `lib/hybrid.js` | Search Console en Ahrefs samenvoegen, bron per zoekwoordrij, de vlaggen `source` en `gsc_error`. |
| `lib/keywordsources.js` | De zoekwoordlijst voor de herfocus: export, of Search Console plus Ahrefs met terugval. |
| `lib/claude.js` | De gedeelde Claude-aanroep (model, schema-output, server-side terugval). |
| `lib/facts.js` | De feitenregels voor elke prompt, en de controle dat elk cijfer van Claude in het meegestuurde bericht staat. |
| `lib/auth.js` | Het optionele wachtwoord, in constante tijd vergeleken. |
| `lib/region.js` | Regio en taal (NL, US): Ahrefs-country, Serper gl/hl, Accept-Language, Search Console-land, taalinstructie voor Claude. |
| `lib/progress.js` | Echte voortgang als NDJSON-stroom, heartbeats, en stoppen als de gebruiker afhaakt. |
| `lib/pagetype.js`, `lib/text.js`, `lib/ratelimit.js` | Paginatypes van Ahrefs vertalen, normalisatie en stemming, rate limit. |
| `test/run.js` | `npm test`: controles van de meet- en controlecode, zonder externe calls. |
| `vercel.json` | Functie-instellingen (timeouts). |

Regels:

- **Geen bundler, geen npm-frontend.** Tailwind komt van de Play CDN, de
  kleurtokens staan in de `tailwind.config` bovenin `index.html` én als CSS-
  variabelen in `styles.css`. Wijzig je een kleur, wijzig hem dan op beide plekken.
- **Secrets blijven server-side.** Sleutels staan in omgevingsvariabelen en worden
  alleen in `api/` gelezen en als argument aan `lib/` doorgegeven; nooit in de browser.
- **De API geeft JSON terug**, geen HTML. De frontend bepaalt de opmaak. Een
  antwoord van `/api/analyze` heeft `stage: 'intent'` (geen match, stop) of
  `stage: 'compleet'` (het hele rapport); beide bevatten dezelfde basisvelden.
  Vraagt de client `Accept: application/x-ndjson`, dan komt hetzelfde antwoord als
  laatste regel van een stroom, na één regel per fase (`lib/progress.js`). Meld
  alleen echte fasen: geen geschatte percentages. Roep `progress.throwIfGone()`
  aan vóór elke dure stap.
- **De pdf is het rapport zelf.** Geen html2pdf of jsPDF: `print.css` maakt van
  dezelfde kaarten een A4-document, en de marketeer kiest "Opslaan als PDF". Zo blijft
  de tekst selecteerbaar en staat meting naast schatting precies zoals op het scherm.
  Wat moet printen hangt nooit af van responsieve Tailwind-klassen (het afdrukvlak is
  ~680px breed): gebruik de container queries op `#result-output` (`.cq-m`, `.cq-l`,
  `.cq-until-*`). Een nieuwe kaart krijgt een printregel (`break-inside`) en zet niets
  essentieels alleen achter een klik.
- **Elk cijfer draagt zijn bron.** Gebruik `prov(kind, tekst)` uit `report.js`:
  `meting` (Search Console, gemeten koppen en woorden), `schatting` (Ahrefs), `serp`
  (de Google-top 10 als momentopname) of `claude` (interpretatie). Een ontbrekend
  cijfer is een streepje met de reden, nooit 0.
- **Hulpcode hoort in `lib/`, niet in `api/`.** Vercel maakt van elk bestand in
  `api/` een eigen endpoint.
- **De code meet, Claude interpreteert, de code controleert.** Dat geldt voor
  elke Claude-call:
  - intent check: de code telt paginatypes en intentievlaggen; Claude oordeelt;
    posities die Claude citeert en die niet in de SERP staan, verdwijnen;
  - content gap: Claude moet per onderwerp letterlijke koppen van minstens twee
    concurrenten citeren, termen en mapping-zoekwoorden komen uit door de code
    getelde of opgehaalde lijsten, nieuwe teksten alleen voor plekken waar de
    meting zegt dat het zoekwoord ontbreekt; `buildReport()` gooit de rest weg;
  - herfocus: een keuze moet letterlijk in de lijst staan; een AI-voorstel telt pas
    als Ahrefs er zoekvolume voor kent;
  - cijfers, bij elke call: elke systeemprompt bevat `FACT_RULES` (alleen cijfers
    uit het bericht, niets uitrekenen, ontbrekend is ontbrekend, geen kennis van
    buiten het bericht), en `lib/facts.js` legt daarna elk getal in de tekst van
    Claude naast het bericht dat die call kreeg. Een zin met een getal dat daar niet
    in staat verdwijnt; een nieuwe paginatekst (kop, H1, title, meta, intro) met zo'n
    getal verdwijnt helemaal. Het rapport meldt hoeveel er weg is (`factCheck`).
    Een nieuwe Claude-call krijgt dezelfde twee lagen.
  Houd die scheiding intact.
- **Elke externe fetch heeft een timeout** en een nette foutboodschap in het
  Nederlands; een onbereikbare URL mag de tool nooit laten hangen.
- **Search Console is een aanvulling, nooit een voorwaarde (smart fallback).** Het
  service account heeft alleen toegang tot klanten die het als gebruiker toevoegden.
  `fetchPageQueries()` gooit daarom nooit; bij geen toegang, geen sleutel of een
  storing loopt de analyse door op Ahrefs. Elk API-antwoord zegt via `source`,
  `gsc_error` en `gsc.status` wat er gebruikt is. Houd elke zoekwoordrij voorzien
  van zijn herkomst (`origin`): de UI moet meting en schatting kunnen scheiden.
- **Search Console werkt altijd, ook zonder wachtwoord.** Keuze van het bureau: de
  tool is intern en de link blijft binnen het team. `APP_PASSWORD` blijft optioneel
  voor wie de hele tool wil afschermen, en wordt in constante tijd vergeleken
  (`lib/auth.js`).
- **Regio en taal zijn een instelling, geen aanname.** Alles wat land of taal kent
  (Ahrefs-country, Serper gl/hl, Accept-Language, het landfilter van Search Console,
  de taal van voorgestelde teksten) komt uit `lib/region.js`. Nieuwe code hardcodet
  geen land; uitleg in het rapport blijft Nederlands.
- **Service account-sleutels nooit in de map.** Ze horen in `.env.local` en in
  Vercel; `.gitignore` en `.vercelignore` weren JSON-sleutelbestanden in `api/`.
  Print nooit een omgevingsvariabele met een regel-filter: een meerregelige sleutel
  lekt dan vanaf de tweede regel. Lees sleutels alleen via `readCredentials()`.
- **Ahrefs-units zijn geld.** Vraag alleen de velden op die gebruikt worden
  (`select`), verrijk lijsten tot een vast maximum en cache niets in de browser
  wat de server opnieuw zou moeten ophalen.

---

## Stijl en conventies

- **Taal: Nederlands**, in de interface én in de code-commentaren. Je-vorm,
  actieve zinnen, zakelijk maar toegankelijk.
- **Knoppen en labels in kleine letters** ("analyseer pagina"), zoals op
  pureminds.nl. Koppen wél met hoofdletter.
- **Commentaar legt uit waarom**, niet wat. Geen regel-voor-regel-uitleg.
- **Vanilla JS**, moderne syntax, geen dependencies in de frontend.
- **Kleuren:** cyaan `#1ab9e2` voor accenten en vlakken, magenta `#b61b50` voor de
  hoofdactie, groen `#009670` voor "goed/klaar", oranje `#e0951f` voor "kan beter",
  inkt `#303030` voor tekst. Gebruik de bestaande klassen uit `styles.css` voordat
  je nieuwe CSS schrijft.
- **Rapportopbouw** volgt de focus keyword-documenten van het team: beoordeling
  focus keyword, focus keyword behouden of nieuw, keyword mapping, focus keyword
  optimalisatie, aanbevelingen (SERP-evidence, gap, aanbeveling), niet doen,
  samenvatting. Nieuwe kaarten of markdown-secties passen in die volgorde.

---

## Grenzen

- **Verzin geen data.** Is een cijfer gesimuleerd of geschat, benoem dat in de UI.
  De marketeer moet het verschil zien tussen een meting (Search Console, via de API
  of een export, en gemeten koppen en woorden) en een schatting (Ahrefs-volumes,
  rankende zoekwoorden via Ahrefs). Er is bewust geen terugval op verzonnen SERP-data als Ahrefs faalt:
  dan faalt de analyse met een duidelijke melding.
- **Toon altijd de bronnen.** Met welke URL's vergeleken is, welke kop bij welke
  concurrent een onderwerp onderbouwt, welke posities een intent-argument dragen,
  en waar een nieuw zoekwoord vandaan komt (Search Console, Ahrefs of AI-voorstel).
- **Geen valse zekerheid.** Het oordeel over de intentie is een interpretatie op
  basis van gemeten data; de tool levert hypotheses voor een contentschrijver,
  geen garantie op posities. De zekerheid (hoog, middel, laag) staat erbij.
- **Geen oneindige lussen.** Een herfocus mag twee rondes; daarna kiest de
  marketeer zelf.
- Respecteer `robots.txt`-achtige fatsoensregels bij het ophalen van pagina's:
  één request per pagina, duidelijke User-Agent, geen crawls.
