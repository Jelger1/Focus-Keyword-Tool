# Keyword Focus & Intent Check

Interne tool van Pure Minds. Vul een doel-URL en een focus zoekwoord in. De tool
controleert eerst of de pagina past bij de zoekintentie van de Google-top 10 voor
dat zoekwoord. Past het, dan volgen de aanbevelingen: keyword mapping, optimalisatie
van H1, title, meta en eerste alinea, en de content gap (ontbrekende koppen, termen
en vragen). Past het niet, dan zoekt de tool een beter zoekwoord in een Search
Console-export (of als schatting via Ahrefs) en analyseert opnieuw.

## Stack

Statische front-end (HTML, Tailwind via CDN, vanilla JS) met Vercel Serverless
Functions als back-end. Geen build-stap.

| Pad | Rol |
|---|---|
| `index.html` | De UI: formulier, stappenbalk, resultaatkaart, lege staat en het skeleton-template. |
| `styles.css` | Designsysteem van pureminds.nl: kaarten, knoppen, velden, labels, skeletons, oordeel, dropzone. |
| `app.js` | De flow in de browser: analyse, herfocus, automatische heranalyse, de kaarten en de markdown-export. |
| `api/analyze.js` | Verzamelen, intent check en (bij een match) de content gap. |
| `api/refocus.js` | Een beter zoekwoord zoeken in een Search Console-export of de Ahrefs-schatting. |
| `lib/ahrefs.js` | Alle Ahrefs-calls: SERP-overzicht, zoekwoordcijfers, zoekwoordideeën, rankende zoekwoorden per URL. |
| `lib/serp.js` | Provider-schakelaar: Ahrefs (standaard) of Serper (terugval). |
| `lib/page.js` | Pagina's ophalen en uitlezen, voor doelpagina én concurrenten identiek. |
| `lib/intent.js` | De intent check: meten, de Claude-instructie en de controle van het oordeel. |
| `lib/gap.js` | De content gap-instructie en het schema voor Claude. |
| `lib/compare.js` | Termen tellen, vragen verzamelen, keyword mapping en elke bewering van Claude controleren. |
| `lib/refocus.js` | De herfocus-instructie en de controle van de keuze. |
| `lib/gsc.js` | Search Console-exports lezen (CSV, TSV, JSON, Nederlandse en Engelse koppen). |
| `lib/claude.js` | De gedeelde Claude-aanroep. |
| `lib/pagetype.js`, `lib/text.js`, `lib/ratelimit.js` | Paginatypes vertalen, tekstnormalisatie, rate limit. |
| `test/run.js` | Snelle controles zonder framework: `npm test`. |

## Hoe de analyse werkt

1. **Verzamelen.** De doelpagina, de Google-top 10 volgens [Ahrefs](https://ahrefs.com)
   (met per resultaat het paginatype en het topzoekwoord) en de cijfers van het
   zoekwoord (volume, moeilijkheid, parent topic, intenties) komen tegelijk binnen.
   De top 10 wordt daarna opgehaald en op dezelfde manier gemeten als de doelpagina.
2. **Intent check.** De code telt de paginatypes in de top 10; Claude beoordeelt of
   het doel van de pagina bij de SERP past en citeert posities als bewijs; de code
   gooit posities weg die niet bestaan. De UI toont meting en interpretatie apart.
3. **Match.** Ahrefs levert zoekwoordideeën; de code telt termen en verzamelt vragen;
   Claude groepeert koppen tot onderwerpen, kiest de keyword mapping uit de ideeën,
   schrijft nieuwe teksten voor plekken waar het zoekwoord ontbreekt en formuleert
   aanbevelingen. Elke bron wordt gecontroleerd.
4. **Geen match.** De marketeer laadt een Search Console-export in (of kiest de
   Ahrefs-schatting). Claude kiest een passend zoekwoord uit die lijst; staat er niets
   in, dan stelt het zelf zoekwoorden voor die de code op zoekvolume checkt bij Ahrefs.
   Met het gekozen zoekwoord start automatisch een nieuwe analyse, maximaal twee rondes.

Het rapport volgt de opbouw van onze focus keyword-documenten: beoordeling, focus
zoekwoord (behouden of nieuw), keyword mapping, optimalisatie, aanbevelingen met
SERP-bewijs, niet doen, samenvatting. Kopieerbaar als markdown.

Een analyse duurt één tot twee minuten en kost circa 25 cent aan Claude plus
ongeveer 1.500 Ahrefs-units (herfocus: 500 tot 2.000 extra).

## Lokaal draaien

```bash
npm install -g vercel   # eenmalig
npm install
cp .env.example .env.local
npm run dev             # vercel dev, standaard op http://localhost:3000
npm test                # snelle controles van de meet- en controlecode
```

`vercel dev` is nodig omdat de tool serverless functions uit `api/` gebruikt; met
een kale static server werkt de analyse niet.

## Uitrollen op Vercel

De tool draait op Vercel vanuit deze GitHub-repo. Elke push naar `main` rolt
automatisch opnieuw uit.

1. Ga in Vercel naar **Add New → Project** en importeer `Jelger1/Focus-Keyword-Tool`.
   Framework preset: **Other**. Build command en output directory laat je leeg.
2. Open **Settings → Environment Variables** en voeg de variabelen uit de tabel
   hieronder toe, voor Production én Preview. Plak alleen de waarde, zonder
   aanhalingstekens.
3. Klik op **Deploy**. Wijzig je later een sleutel, doe dan **Deployments → Redeploy**:
   de functies lezen de variabelen bij het uitrollen in.

Ontbreekt een sleutel, dan zegt de tool dat in de foutmelding, met de naam van de
variabele erbij. De sleutels blijven op de server; de browser krijgt alleen JSON.

## Omgevingsvariabelen

Kopieer `.env.example` naar `.env.local` en zet dezelfde variabelen in Vercel
onder **Settings → Environment Variables**.

| Variabele | Verplicht | Waarvoor |
|---|---|---|
| `ANTHROPIC_API_KEY` | ja | Intent check, herfocus en content gap. |
| `AHREFS_API_KEY` | ja | SERP, zoekvolumes, zoekwoordideeën, rankende zoekwoorden per URL. |
| `SERP_PROVIDER` | nee | `ahrefs` (standaard) of `serper`. |
| `SERPER_API_KEY` | nee | Alleen bij `SERP_PROVIDER=serper`: de live top 10 zonder paginatypes. |
| `APP_PASSWORD` | nee | Zet je die, dan vraagt de tool eenmalig om een wachtwoord. |
