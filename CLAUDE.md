# Working on this repo

A free Pokémon card scanner: a static PWA (vanilla ES modules, no build step) on GitHub Pages.
`README.md` explains the app, the file layout, the big-file cache, the card details file and
how to measure. History, decisions and next steps live in the PRIVATE test-photo repo
(`jpmoorman/pokemoncards-testphotos`, cloned next to this one): read its `docs/HANDOFF.md`
first, then `docs/architecture-review-2026-10-24.md`.

## Branches and releases
- Work on `claude/pokemon-card-scanner`. `main` is what's live; it deploys on push (the Pages
  workflow runs the unit tests first).
- Publish a version only after unit tests, all browser suites and the dev bench pass: fast-forward
  `main` to that commit. Don't open pull requests unless asked.

## Tests
- `npm test`: unit tests (`node --test tests/*.test.mjs`).
- Browser suites: `node tests/<suite>.mjs`, one per file (`e2e`, `e2e-photo`, `e2e-stamps`, `e2e-batch`,
  `e2e-trade`, `e2e-ui`, `e2e-ocr`, `e2e-offline`, `e2e-backup`, `e2e-bench-page`). Set
  `CHROMIUM_PATH` if Playwright's own Chromium isn't installed.
- Accuracy: `tests/bench.mjs` (the real app on labelled photos) and `tests/rank-eval.mjs`
  (re-ranks saved reads in seconds). See README "Measuring".

## Rules
- Never put the private photos, crops, OCR reads or bench output in this repo (they are eBay
  sellers' photos). Bench output goes outside the repo or in the ignored `test-results/`.
- Tune only on the dev half; check a holdout once at the end. The default photo-id holdout is
  used up: use the owner's new photos or `--split-by card` for clean checks.
- A "Confident match" must never be wrong, including offline and with partial details;
  reprints (Celebrations / 30th Classic Collection) must never be a silent pick.
- Big files under `models/`, `vendor/`, `data/` are versioned (new name for a new version);
  run `node tools/assets.mjs` after changing them; new scripts/styles go in `SHELL` in `sw.js`.
- Prices in USD. Plain-English, short user-facing text. Match the surrounding code's style.
