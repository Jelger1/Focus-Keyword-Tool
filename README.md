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
| `app.js` | Formulier, fetch naar de API, de vijf resultaatkaarten en de kopieerknoppen. |
| `api/analyze.js` | Het endpoint en de Claude-aanroep. |
| `lib/` | Pagina's uitlezen, Serper, termen tellen en de controle van Claude's output. |
| `pureminds-logo.*`, `favicon.png` | Huisstijlbeeld. |

## Hoe de analyse werkt

1. De **echte Google-top 10** (Nederland) komt via [Serper.dev](https://serper.dev),
   inclusief het "Mensen vragen ook"-blok.
2. De doelpagina en alle concurrenten worden **opgehaald en op dezelfde manier
   gemeten**: koppen, woordenaantal, tekst. Video's en social media worden
   overgeslagen; geblokkeerde pagina's staan als "mislukt" in het rapport.
3. De code **telt** welke woorden en woordparen bij minstens 30% van de
   concurrenten voorkomen.
4. **Claude groepeert** concurrentkoppen tot onderwerpen en kiest inhoudelijke
   termen uit de getelde lijst. Per onderwerp moet het letterlijke koppen van
   minstens twee concurrenten citeren.
5. De code **controleert elke bron**. Onderwerpen zonder geldige bron verdwijnen.

Het rapport toont bij elke suggestie de bron, zodat een SEO-specialist de
groepering zelf kan beoordelen. Een analyse duurt ongeveer een minuut en kost
circa 20 cent aan Claude plus één Serper-zoekopdracht.

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
| `ANTHROPIC_API_KEY` | ja | Onderwerpen groeperen, termen kiezen, antwoordrichtingen. |
| `SERPER_API_KEY` | ja | De echte Google-top 10. Aanmaken op serper.dev. |
| `APP_PASSWORD` | nee | Zet je die, dan vraagt de tool eenmalig om een wachtwoord. |
