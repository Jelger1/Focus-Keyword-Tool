# SEO Content Gap Analyzer

Interne tool van Pure Minds. Vul een doel-URL en een primair zoekwoord in, en de
tool laat zien welke onderwerpen de organische topresultaten wél behandelen en
jouw pagina niet: ontbrekende H2/H3-koppen, semantische termen en FAQ's.

## Stack

Statische front-end (HTML, Tailwind via CDN, vanilla JS) met Vercel Serverless
Functions als back-end. Geen build-stap.

| Pad | Rol |
|---|---|
| `index.html` | De UI: formulier, resultaatkaart, lege staat en het skeleton-template. |
| `styles.css` | Designsysteem van pureminds.nl: kaarten, knoppen, velden, labels, skeletons. |
| `app.js` | Formulier, fetch naar de API, de vier resultaatkaarten en de kopieerknoppen. |
| `api/analyze.js` | Haalt de pagina op, vraagt Claude om de SERP-kant en legt beide naast elkaar. |
| `pureminds-logo.*`, `favicon.png` | Huisstijlbeeld. |

## Hoe de analyse werkt

De pagina wordt **echt opgehaald en gemeten**: koppenstructuur, woordenaantal,
titel en meta description. De **SERP-kant is een inschatting** van Claude op basis
van modelkennis — geen live meting van Google.

Elke suggestie van het model wordt daarna tegen de echte paginatekst getoetst. Bij
een verschil van mening wint altijd de ruimhartigste uitkomst, zodat de tool nooit
adviseert iets toe te voegen dat er al staat. Een analyse duurt ongeveer een minuut.

## Lokaal draaien

```bash
npm install -g vercel   # eenmalig
npm install
cp .env.example .env.local
npm run dev             # vercel dev, standaard op http://localhost:3000
```

`vercel dev` is nodig omdat de tool serverless functions uit `api/` gebruikt; met
een kale static server werkt de analyse niet.

## Omgevingsvariabelen

Kopieer `.env.example` naar `.env.local` en zet dezelfde variabelen in Vercel
onder **Settings → Environment Variables**.

| Variabele | Verplicht | Waarvoor |
|---|---|---|
| `ANTHROPIC_API_KEY` | ja | De analyse van de topresultaten. |
| `APP_PASSWORD` | nee | Zet je die, dan vraagt de tool eenmalig om een wachtwoord. |
