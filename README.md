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
| `styles.css` | Designsysteem van pureminds.nl: kaarten, knoppen, velden, labels, skeletons, oordeel, dropzone en de rapportcomponenten. |
| `print.css` | Het rapport als A4-pdf: merkkop, kop- en voetregel, paginanummers. |
| `fonts/` | Open Sans lokaal (OFL), zodat de pdf gewone TrueType-tekst bevat. |
| `report.js` | De kaarten van het rapport, met de bron bij elk cijfer. |
| `pdf.js` | "Download als pdf": bestandsnaam, kantlijnteksten en uitklapblokken bij het afdrukken. |
| `app.js` | De flow in de browser: analyse, herfocus, automatische heranalyse en de markdown-export. |
| `api/analyze.js` | Verzamelen, intent check en (bij een match) de content gap. |
| `api/refocus.js` | Een beter zoekwoord zoeken: Search Console plus Ahrefs, of een zelf ingeladen export. |
| `lib/ahrefs.js` | Alle Ahrefs-calls: SERP-overzicht, zoekwoordcijfers, zoekwoordideeën, rankende zoekwoorden per URL. |
| `lib/serp.js` | Provider-schakelaar: Ahrefs (standaard) of Serper (terugval). |
| `lib/page.js` | Pagina's ophalen en uitlezen, voor doelpagina én concurrenten identiek. |
| `lib/intent.js` | De intent check: meten, de Claude-instructie en de controle van het oordeel. |
| `lib/gap.js` | De content gap-instructie en het schema voor Claude. |
| `lib/compare.js` | Termen tellen, vragen verzamelen, keyword mapping en elke bewering van Claude controleren. |
| `lib/refocus.js` | De herfocus-instructie en de controle van de keuze. |
| `lib/gsc.js` | Search Console-exports lezen (CSV, TSV, JSON, Nederlandse en Engelse koppen). |
| `lib/searchconsole.js` | Search Console API via een service account. Gooit nooit: geeft altijd een status terug. |
| `lib/hybrid.js` | Search Console en Ahrefs samenvoegen, en de vlaggen `source` en `gsc_error`. |
| `lib/keywordsources.js` | De zoekwoordlijst voor de herfocus: export, of Search Console plus Ahrefs met terugval. |
| `lib/claude.js` | De gedeelde Claude-aanroep. |
| `lib/facts.js` | Feitencontrole: elk cijfer in de tekst van Claude moet in de meegestuurde data staan. |
| `lib/auth.js` | Het optionele wachtwoord, in constante tijd vergeleken. |
| `lib/region.js` | Regio en taal: Nederland (Nederlands) of Verenigde Staten (Engels). |
| `lib/progress.js` | Echte voortgang tijdens een analyse, als NDJSON-stroom. |
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

**Regio en taal.** Kies Nederland of de Verenigde Staten. Dat bepaalt welke Google de
tool bekijkt (Ahrefs en Serper), in welke taal pagina's worden opgehaald, op welk
land Search Console filtert en in welke taal de voorgestelde koppen, H1, meta en
eerste alinea zijn. De uitleg in het rapport blijft Nederlands.

**Voortgang en bijsturen.** Tijdens een analyse meldt de server elke fase die hij
afrondt; de UI toont die live, inclusief welke databron gebruikt wordt. Boven de
resultaten staat een zoekwoordbalk die altijd bewerkbaar is: een ander zoekwoord
proberen voor dezelfde pagina kan op elk moment, ook tijdens een analyse (die wordt
dan afgebroken, en de server stopt vóór de dure stappen).

Het rapport volgt de opbouw van onze focus keyword-documenten: beoordeling, focus
zoekwoord (behouden of nieuw), keyword mapping, optimalisatie, aanbevelingen met
SERP-bewijs, niet doen, samenvatting. Kopieerbaar als markdown en te downloaden als
pdf.

**Geen verzonnen cijfers.** Elke prompt verbiedt cijfers die niet in de meegestuurde
data staan, rekensommen en kennis van buiten het bericht. Daarna controleert de code
het: elk getal in de tekst van Claude (zoekvolume, vertoningen, positie, jaartal,
prijs, percentage) moet in het bericht staan dat Claude kreeg. Een zin met een ander
getal verdwijnt, een voorgestelde paginatekst met zo'n getal helemaal. De bijlage van
het rapport meldt hoeveel er is weggelaten.

**Pdf voor de klant.** "Download als pdf" opent het afdrukvenster van de browser; kies
daar "Opslaan als PDF". De pdf is hetzelfde rapport als op het scherm, als A4 met
logo, kopregel, voetregel en paginanummers, en met selecteerbare tekst. Bestandsnaam:
`Focus keyword-rapport - domein - zoekwoord - datum.pdf`. Paginanummers en de
kopregel werken in Chrome en Edge; Firefox en Safari laten die weg (logo, zoekwoord
en datum staan dan nog op pagina 1). Ziet iemand toch een datum of URL in de
kantlijn, dan staat onder "Meer instellingen" de optie "Kop- en voetteksten" aan.

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

## Google Search Console koppelen

Met een service account haalt de tool voor elke pagina de echte zoekopdrachten uit
Search Console: vertoningen, klikken en positie van de laatste 90 dagen, plus het
paginatotaal. Dat werkt alleen voor domeinen waar het service account gebruiker is.
Voor alle andere domeinen valt de tool stilletjes terug op Ahrefs; de analyse loopt
gewoon door.

De tool is bedoeld voor intern gebruik binnen het bureau; Search Console werkt ook
zonder `APP_PASSWORD`. Deel de link daarom niet buiten het bureau: wie hem heeft,
kan de Search Console-data van klanten opvragen. Wil je de deploy toch afschermen,
zet dan in Vercel **Deployment Protection** aan of gebruik `APP_PASSWORD`.

Search Console filtert op het land van de gekozen regio (Nederland of de Verenigde
Staten), zodat de vertoningen bij dezelfde Google horen als de top 10.

1. **Google Cloud-project.** Open [console.cloud.google.com](https://console.cloud.google.com),
   kies of maak een project en zet onder **APIs & Services → Library** de
   **Google Search Console API** aan.
2. **Service account.** Maak onder **IAM & Admin → Service Accounts** een account aan.
   Rollen in Google Cloud zijn niet nodig.
3. **Sleutel.** Kies bij het account **Keys → Add key → Create new key → JSON**.
   Bewaar het bestand buiten deze map en zet het nooit in git. Staan `client_email`
   en `private_key` eenmaal in `.env.local` en Vercel, verwijder het bestand dan of
   bewaar het in een wachtwoordmanager.
4. **Toegang per klant.** Voeg in Search Console bij elke klant-property het
   e-mailadres van het service account toe onder **Instellingen → Gebruikers en rechten**,
   met rechten **Beperkt**. Lezen is genoeg.
5. **Omgevingsvariabelen.** Zet `client_email` in `GOOGLE_CLIENT_EMAIL` en
   `private_key` in `GOOGLE_PRIVATE_KEY`:
   - **In Vercel:** plak de sleutel zoals hij in het JSON-bestand staat tussen de
     aanhalingstekens, dus met de letterlijke `\n`-tekens, of meerregelig. Geen
     aanhalingstekens eromheen. Vink **Sensitive** aan, zodat de waarde na het
     opslaan niet meer te lezen is.
   - **In `.env.local`:** op één regel, tussen dubbele aanhalingstekens, met `\n`
     op elke plek van een regeleinde:
     ```
     GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----\n"
     ```
   De tool accepteert alle drie de vormen: letterlijke `\n`, echte regeleindes en
   Windows-regeleindes.
6. **Gelekt?** Is de sleutel ergens zichtbaar geweest (chat, screenshot, commit), maak
   dan onder **IAM & Admin → Service Accounts → Keys** een nieuwe sleutel en verwijder
   de oude. Zet de nieuwe waarde in `.env.local` en Vercel en doe een redeploy.

Elk antwoord van de API vertelt wat er gebruikt is:

| Veld | Waarde | Betekenis |
|---|---|---|
| `source` | `hybrid_gsc_ahrefs` | Search Console-data is meegenomen naast Ahrefs. |
| `source` | `ahrefs_only` | Alleen Ahrefs: geen koppeling, geen toegang of geen vertoningen. |
| `source` | `gsc_only` | Alleen Search Console: Ahrefs kende de URL niet. |
| `source` | `gsc_upload` | De marketeer heeft zelf een export ingeladen. |
| `source` | `serp_only` | Alleen de SERP van Serper: geen Ahrefs-sleutel en geen Search Console. |
| `gsc_error` | `true` | Search Console werd geprobeerd en mislukte, bijvoorbeeld geen toegang. |
| `gsc.status` | `ok`, `leeg`, `niet_ingesteld`, `geen_toegang`, `sleutel_ongeldig`, `api_uit`, `limiet`, `timeout`, `fout` | De precieze reden, met een Nederlandse uitleg in `gsc.message`. |

## Omgevingsvariabelen

Kopieer `.env.example` naar `.env.local` en zet dezelfde variabelen in Vercel
onder **Settings → Environment Variables**.

| Variabele | Verplicht | Waarvoor |
|---|---|---|
| `ANTHROPIC_API_KEY` | ja | Intent check, herfocus en content gap. |
| `AHREFS_API_KEY` | ja | SERP, zoekvolumes, zoekwoordideeën, rankende zoekwoorden per URL. |
| `GOOGLE_CLIENT_EMAIL` | nee | E-mailadres van het service account, voor Search Console. |
| `GOOGLE_PRIVATE_KEY` | nee | Private key van het service account. Zie hieronder voor het formaat. |
| `SERP_PROVIDER` | nee | `ahrefs` (standaard) of `serper`. |
| `SERPER_API_KEY` | nee | Alleen bij `SERP_PROVIDER=serper`: de live top 10 zonder paginatypes. |
| `APP_PASSWORD` | nee | Zet je die, dan vraagt de tool eenmalig om een wachtwoord. |
