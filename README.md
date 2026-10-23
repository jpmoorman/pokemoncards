# Pokémon Card Scanner

A free web app for your phone: point the camera at a Pokémon card and it identifies the card and shows what it's worth. There's no app-store install, no account and no subscription.

**How it identifies a card**

1. Text recognition ([Tesseract.js](https://github.com/naptha/tesseract.js)) runs **on your phone**. It reads the card's
   - **name** (the biggest text at the top),
   - **collector number and set size** (`125/197`, `4/102`, `TG05/TG30`, `SWSH050`),
   - **set code** printed on Scarlet & Violet and newer cards (`OBF EN`, `POR EN`, `PBL EN`, `30C EN`, …).
2. Those clues are matched against every English card ever printed, from Base Set to the newest sets.
   Older cards that only have a set *symbol* are matched by **set size + number + name**
   (for example, `4/102` + "Charizard" can only be Base Set Charizard).
   New sets show up automatically: the set list comes live from the card database.
3. You get the best match plus other likely matches with pictures. Tap one if the first guess is wrong.
   You can also correct what the camera read and tap **Re-match**.

**Prices and specialty markings**

Each printed version gets its own price: Normal, Reverse Holo, Holo, **1st Edition**, Shadowless, promo stamps and Jumbo.
- **TCGplayer** (USD): market, low, mid and high
- **Cardmarket** (EUR): trend, average, 7-day and 30-day
- One-tap links to **eBay sold listings** (what cards actually sold for), eBay active listings, TCGplayer and
  PriceCharting (graded values).

Card data and prices come from the free [TCGdex API](https://tcgdex.dev). Brand-new sets can take a few weeks to get prices; until then the app says "No price yet" and points you to eBay sold listings. eBay doesn't offer a free API that works from a browser, so the app opens eBay's own search, filtered to sold listings.

**Also included:** manual search, a collection list with a running total, CSV export, and works offline after the first load. You can add it to your home screen like a normal app.

## Use it on your phone

The app is a static website, so it needs to be hosted somewhere with **HTTPS**, because phones only allow camera access on secure sites. GitHub Pages is free:

1. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/pages.yml` runs the tests and publishes the site.
3. Open `https://<your-username>.github.io/<repo-name>/` on your phone.
   - **iPhone (Safari):** Share → *Add to Home Screen*.
   - **Android (Chrome):** ⋮ → *Add to Home screen* / *Install app*.

The first time you open it, it downloads the card list (a few MB) and the text-recognition engine (about 5 MB). After that, both are cached on the phone.

## Tips for good scans

- Lay the card flat, in good light, and fill the on-screen frame with it.
- Glare on holo cards and sleeves is the most common problem. Tilt the card slightly or turn on **Light** (Android).
- If the camera keeps missing, use **Photo**. Your phone's camera app takes sharper pictures than the live preview.
- The *Raw text read from the card* section at the bottom of a result shows exactly what the scanner saw.

## Development

No build step: plain HTML, CSS and ES modules.

```bash
npm install          # only needed for tests
npm start            # http://localhost:8080 (the camera works on localhost)
npm test             # unit tests: parsing, matching, prices
npm run test:e2e     # headless Chromium + real OCR on generated card images
```

| File | What it does |
| --- | --- |
| `js/ocr.js` | Camera, cropping the name and number areas, image clean-up, Tesseract |
| `js/parse.js` | Pulls numbers, set codes and the name out of OCR text |
| `js/match.js` | Fuzzy-matches the clues against the card list and ranks the candidates |
| `js/prices.js` | Prices per version (1st Ed., reverse holo, …) and marketplace links |
| `js/api.js` | TCGdex API, cached on the device in IndexedDB |
| `js/app.js` | User interface |
