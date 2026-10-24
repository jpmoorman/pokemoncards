// Fast offline scoring of the card-ranking step on saved bench output (no OCR, no browser).
// 1) node tests/bench.mjs --photos <dir> --out bench.json      (slow: runs OCR once, saves what was read)
// 2) node tests/rank-eval.mjs --bench bench.json --photos <dir> (seconds: re-ranks from the saved reads)
//
// Ranks exactly like identify.js: match.rankCandidates, then rerank.js's second pass, with the
// card details it looks up served from the catalog snapshot (catalog/details.json.gz) instead
// of the TCGdex API.
//   --split dev|holdout|all   which half (see below)
//   --split-by photo|card     halve by photo id (default) or by card id (see tests/printing.mjs)
//   --rerank none             first pass only (or --rerank <module> to try another second pass)
//   --fetch N                 look up at most N candidates' details (default: rerank.js's)
//   --offline                 second pass without any details (no network)
//   --details <file>          the card details file the app ships (data/details-*.json): looked
//                             up first, as js/api.js does; with --offline the only source
//   --drop P                  each lookup fails with probability P (0..1): details that arrive
//                             only partly, as on a slow phone connection
//   --seeds 1,2,3             which random drops to try (one run each, default 1)
//   --verbose                 list the misses
// Besides top-1/top-5 it counts how often the scanner would say "Confident match" (high) and
// how many of those are wrong, and how many top picks carry a reprint warning (match.reprintRivals).
// With labels.json in the photo folder it also scores the printed version the result sheet would
// show first (1st Edition, reverse holo, stamps…, from the saved stamp read clues.artText) against
// the label's: "right card + printing", overall and per labelled version (tests/printing.mjs);
// --verbose lists the right cards shown in the wrong version too.
//
// Photos are split into a "dev" half (tune on it) and a "holdout" half (only check it at the end),
// by a stable hash of the photo id, so improvements are proven on photos the tuning never saw.
// (--split-by card hashes the card id instead: a new split, for holdouts no photo of the same
// card was tuned on; the default split stays the one every number so far used.)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildIndex, rankCandidates, confidence, reprintRivals } from '../js/match.js';
import { hash, half, splitOf, sheetCard, scorePrinting, printingSummary, printingReport } from './printing.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const dir = path.resolve(arg('photos', '../pokemoncards-testphotos'));
const bench = JSON.parse(fs.readFileSync(arg('bench', 'test-results/bench.json')));
const split = arg('split', 'all'); // dev | holdout | all
const splitBy = arg('split-by', 'photo'); // photo | card
const verbose = process.argv.includes('--verbose');
const offline = process.argv.includes('--offline');
const fetchMax = arg('fetch', '') ? parseInt(arg('fetch', ''), 10) : undefined;
const drop = +arg('drop', '0');
const seeds = String(arg('seeds', '1')).split(',').map(Number);

const cards = JSON.parse(fs.readFileSync(path.join(dir, 'catalog/cards.json')));
const sets = JSON.parse(fs.readFileSync(path.join(dir, 'catalog/sets.json')));
const codes = JSON.parse(fs.readFileSync(path.join(dir, 'catalog/set-codes.json')));
const detailsFile = path.join(dir, 'catalog/details.json.gz');
export const details = fs.existsSync(detailsFile) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(detailsFile))) : {};
// --details (foundations step 0): read with the app's own reader, js/details.js.
const shippedFile = arg('details', '');
const shipped = shippedFile ? (await import('../js/details.js')).readDetails(JSON.parse(fs.readFileSync(shippedFile))) : null;

// The labels, for the printing score (a bench row has the card id, not the version).
const labelsFile = path.join(dir, 'labels.json');
const labels = new Map(fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile)).map((l) => [l.id, l]) : []);
const snapshot = { cardById: new Map(cards.map((c) => [c.id, c])), setById: new Map(sets.map((s) => [s.id, s])), details };

export { half };

const index = buildIndex(cards, sets);
const rows = bench.rows.filter((r) => r.clues && (split === 'all' || splitOf(r, splitBy) === split));

// Second pass: js/rerank.js unless --rerank none, or another module exporting rerank(ranked, read, ctx).
const rerankPath = arg('rerank', 'js/rerank.js');
const rerank = rerankPath === 'none' ? null : (await import(path.resolve(rerankPath))).rerank;

async function run(seed) {
  let lookups = 0;
  let top1 = 0;
  let top5 = 0;
  const conf = { high: [0, 0], medium: [0, 0], low: [0, 0], none: [0, 0] }; // [given, wrong]
  let rivals = 0;
  let rivalRight = 0; // top pick wrong, but the reprint note names the right card
  const misses = [];
  const printings = []; // { version, score } per photo with a label
  for (const r of rows) {
    // A lookup that fails does so the same way whatever the second pass asks for first.
    const lost = (id) => drop > 0 && hash(`${seed}:${r.id}:${id}`) / 2 ** 32 < drop;
    const getCard = offline
      ? shipped && ((id) => shipped.card(id))
      : (id) => {
          lookups++;
          return shipped?.card(id) || (lost(id) ? Promise.reject(new Error('dropped')) : details[id] || null);
        };
    // identify.js passes on where the name came from (the dictionary or the name area).
    const clues = { ...r.clues, nameFrom: r.clues.nameFrom || r.nameFrom || '' };
    let ranked = rankCandidates(index, clues, codes, rerank ? 150 : 40);
    if (rerank) ranked = await rerank(ranked, { clues, debug: r.debug || {}, border: r.border }, { index, getCard, fetch: fetchMax });
    const ids = ranked.slice(0, 5).map((x) => x.card.id);
    const c = confidence(ranked);
    conf[c][0]++;
    if (ids[0] !== r.truth) conf[c][1]++;
    const twins = reprintRivals(ranked);
    if (twins.length) rivals++;
    if (ids[0] !== r.truth && twins.some((t) => t.card.id === r.truth)) rivalRight++;
    if (ids[0] === r.truth) top1++;
    else {
      const t = ranked.find((x) => x.card.id === r.truth);
      misses.push({ id: r.id, truth: r.truth, conf: c, rank: ranked.indexOf(t), got: ranked.slice(0, 3).map((x) => `${x.card.id} ${x.score.toFixed(2)}`), why: ranked[0]?.reasons.join(', '), truthWhy: t ? `${t.score.toFixed(2)} ${t.reasons.join(', ')}` : '' });
    }
    if (ids.includes(r.truth)) top5++;
    const label = labels.get(r.id);
    if (label) {
      const score = scorePrinting(ids[0], sheetCard(r.truth, snapshot), clues, label);
      printings.push({ id: r.id, truth: r.truth, conf: c, version: label.version, score });
    }
  }
  return { top1, top5, conf, rivals, rivalRight, lookups, misses, printings };
}

const pct = (a) => `${((100 * a) / rows.length).toFixed(1)}%`;
const runs = [];
for (const seed of drop > 0 ? seeds : [seeds[0]]) runs.push({ seed, ...(await run(seed)) });
for (const x of runs) {
  const per = rerank && !offline ? `  details looked up: ${(x.lookups / rows.length).toFixed(1)} per photo` : '';
  const dropped = drop > 0 ? `  [${Math.round(drop * 100)}% of lookups dropped, seed ${x.seed}]` : '';
  const c = x.conf;
  console.log(
    `${split}: ${rows.length} photos  top-1 ${pct(x.top1)} (${x.top1})  top-5 ${pct(x.top5)} (${x.top5})` +
      `  high ${c.high[0]} (wrong ${c.high[1]})  medium ${c.medium[0]} (wrong ${c.medium[1]})  low ${c.low[0] + c.none[0]}  reprint notes ${x.rivals} (${x.rivalRight} name the right card)${per}${dropped}`,
  );
  if (x.printings.length) {
    const p = printingSummary(x.printings);
    const wrongHigh = x.printings.filter((q) => q.conf === 'high' && q.score.why === '' && !q.score.ok).length;
    console.log(
      `  printing: right card + printing ${p.all.printing} of ${p.all.scored} photos whose label names one (${((100 * p.all.printing) / (p.all.scored || 1)).toFixed(1)}%);` +
        ` of ${p.all.choice} right cards printed more than one way the version shown first is right for ${p.all.choiceRight} (${wrongHigh} of the ${p.all.choice - p.all.choiceRight} others were "high")`,
    );
    if (verbose || process.argv.includes('--by-version')) console.log(printingReport(p, '    '));
  }
}
if (runs.length > 1) {
  const avg = (f) => (runs.reduce((s, x) => s + f(x), 0) / runs.length).toFixed(1);
  const range = (f) => `${Math.min(...runs.map(f))}-${Math.max(...runs.map(f))}`;
  console.log(`  over ${runs.length} seeds: top-1 avg ${avg((x) => x.top1)} (${range((x) => x.top1)})  high wrong avg ${avg((x) => x.conf.high[1])} (${range((x) => x.conf.high[1])})`);
}
if (verbose) {
  for (const m of runs[0].misses) {
    console.log(`  ${m.id} ${m.truth} (rank ${m.rank}, ${m.conf}) <- ${m.got.join(', ')}\n      best: ${m.why}\n      truth: ${m.truthWhy}`);
  }
  // Right card, wrong printed version (the price shown is another version's).
  for (const q of runs[0].printings.filter((q) => q.score.why === '' && !q.score.ok)) {
    console.log(`  ${q.id} ${q.truth} [${q.version}] shown as "${q.score.printing}", wanted ${q.score.wanted.map((w) => `"${w}"`).join(' or ')}`);
  }
}
