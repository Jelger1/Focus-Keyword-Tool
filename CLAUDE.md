# CLAUDE.md — SEO Content Gap Analyzer

Vaste instructieset voor dit project. Lees dit bestand voordat je code wijzigt.

> Dit project hergebruikt het designsysteem van de eerdere interne tool
> (Landingpage & Ads Optimizer). De styling is behouden, alle oude logica is
> verwijderd. Zoek dus niet naar CRO- of Google Ads-functionaliteit: die bestaat
> hier niet meer.

---

## Wat de tool doet

Een marketeer vult twee dingen in:

1. **Doel-URL** — de klantpagina die moet ranken.
2. **Primair zoekwoord** — het zoekwoord waarop die pagina moet scoren.

De tool haalt de pagina op, zet die naast de organische topresultaten voor dat
zoekwoord (voorlopig gesimuleerde SERP-data) en levert vier inzichten:

| Blok | Inhoud |
|---|---|
| Dekkingsgraad | Woordenaantal en dekking van de pagina versus de top-resultaten. |
| Ontbrekende koppen | H2's en H3's die concurrenten behandelen en de pagina mist. |
| Semantische termen | Woorden die concurrenten gebruiken en op de pagina ontbreken. |
| Mensen vragen ook | FAQ-items die als blok aan de pagina toegevoegd kunnen worden. |

De output is een dashboard van kaarten, kopieerbaar per suggestie én in één keer
als markdown.

---

## Architectuur

Geen framework, geen build-stap. Statische bestanden plus Vercel Serverless
Functions.

| Pad | Rol |
|---|---|
| `index.html` | De volledige UI: chrome, formulier, resultaatkaart, `<template>`s voor lege en ladende staat. |
| `styles.css` | Het designsysteem: kaarten, knoppen, invoervelden, labels, scoretegels, skeletons. |
| `app.js` | Frontend-logica: formulier, fetch naar de API, rendering, kopieerknoppen. |
| `api/analyze.js` | POST-endpoint: haalt de URL op, vergelijkt met SERP-data, geeft JSON terug. |
| `vercel.json` | Functie-instellingen (timeout). |

Regels:

- **Geen bundler, geen npm-frontend.** Tailwind komt van de Play CDN, de
  kleurtokens staan in de `tailwind.config` bovenin `index.html` én als CSS-
  variabelen in `styles.css`. Wijzig je een kleur, wijzig hem dan op beide plekken.
- **Secrets blijven server-side.** Sleutels staan in omgevingsvariabelen en worden
  alleen in `api/` gelezen, nooit in de browser.
- **De API geeft JSON terug**, geen HTML. De frontend bepaalt de opmaak.
- **Elke externe fetch heeft een timeout** en een nette foutboodschap in het
  Nederlands; een onbereikbare URL mag de tool nooit laten hangen.

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

---

## Grenzen

- **Verzin geen data.** Is een cijfer gesimuleerd of geschat, benoem dat in de UI.
  De marketeer moet het verschil zien tussen een meting en een aanname.
- **Geen valse zekerheid.** De tool levert hypotheses voor een contentschrijver,
  geen garantie op posities.
- Respecteer `robots.txt`-achtige fatsoensregels bij het ophalen van pagina's:
  één request, duidelijke User-Agent, geen crawls.
