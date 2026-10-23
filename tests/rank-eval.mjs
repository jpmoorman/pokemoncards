// Fast offline scoring of the card-ranking step on saved bench output (no OCR, no browser).
// 1) node tests/bench.mjs --photos <dir> --out bench.json      (slow: runs OCR once, saves what was read)
// 2) node tests/rank-eval.mjs --bench bench.json --photos <dir> (seconds: re-ranks from the saved reads)
//
// Ranks exactly like identify.js: match.rankCandidates, then rerank.js's second pass, with the
// card details it looks up served from the catalog snapshot (catalog/details.json.gz) instead
// of the TCGdex API.
//   --split dev|holdout|all   which half (see below)
//   --rerank none             first pass only (or --rerank <module> to try another second pass)
//   --fetch N                 look up at most N candidates' details (default: rerank.js's)
//   --offline                 second pass without any details (no network)
//   --verbose                 list the misses
//
// Photos are split into a "dev" half (tune on it) and a "holdout" half (only check it at the end),
// by a stable hash of the photo id, so improvements are proven on photos the tuning never saw.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildIndex, rankCandidates } from '../js/match.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const dir = path.resolve(arg('photos', '../pokemoncards-testphotos'));
const bench = JSON.parse(fs.readFileSync(arg('bench', 'test-results/bench.json')));
const split = arg('split', 'all'); // dev | holdout | all
const verbose = process.argv.includes('--verbose');
const offline = process.argv.includes('--offline');
const fetchMax = arg('fetch', '') ? parseInt(arg('fetch', ''), 10) : undefined;

const cards = JSON.parse(fs.readFileSync(path.join(dir, 'catalog/cards.json')));
const sets = JSON.parse(fs.readFileSync(path.join(dir, 'catalog/sets.json')));
const codes = JSON.parse(fs.readFileSync(path.join(dir, 'catalog/set-codes.json')));
const detailsFile = path.join(dir, 'catalog/details.json.gz');
export const details = fs.existsSync(detailsFile) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(detailsFile))) : {};

export function half(id) {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 2 ? 'holdout' : 'dev';
}

const index = buildIndex(cards, sets);
const rows = bench.rows.filter((r) => r.clues && (split === 'all' || half(r.id) === split));

// Second pass: js/rerank.js unless --rerank none, or another module exporting rerank(ranked, read, ctx).
const rerankPath = arg('rerank', 'js/rerank.js');
const rerank = rerankPath === 'none' ? null : (await import(path.resolve(rerankPath))).rerank;
let lookups = 0;
const getCard = offline
  ? null
  : (id) => {
      lookups++;
      return details[id] || null;
    };

let top1 = 0;
let top5 = 0;
const misses = [];
for (const r of rows) {
  // identify.js passes on where the name came from (the dictionary or the name area).
  const clues = { ...r.clues, nameFrom: r.clues.nameFrom || r.nameFrom || '' };
  let ranked = rankCandidates(index, clues, codes, rerank ? 150 : 40);
  if (rerank) ranked = await rerank(ranked, { clues, debug: r.debug || {}, border: r.border }, { index, getCard, fetch: fetchMax });
  const ids = ranked.slice(0, 5).map((x) => x.card.id);
  if (ids[0] === r.truth) top1++;
  else {
    const t = ranked.find((x) => x.card.id === r.truth);
    misses.push({ id: r.id, truth: r.truth, rank: ranked.indexOf(t), got: ranked.slice(0, 3).map((x) => `${x.card.id} ${x.score.toFixed(2)}`), why: ranked[0]?.reasons.join(', '), truthWhy: t ? `${t.score.toFixed(2)} ${t.reasons.join(', ')}` : '' });
  }
  if (ids.includes(r.truth)) top5++;
}
const pct = (a) => `${((100 * a) / rows.length).toFixed(1)}%`;
const per = rerank && getCard ? `  details looked up: ${(lookups / rows.length).toFixed(1)} per photo` : '';
console.log(`${split}: ${rows.length} photos  top-1 ${pct(top1)} (${top1})  top-5 ${pct(top5)} (${top5})${per}`);
if (verbose) {
  for (const m of misses) {
    console.log(`  ${m.id} ${m.truth} (rank ${m.rank}) <- ${m.got.join(', ')}\n      best: ${m.why}\n      truth: ${m.truthWhy}`);
  }
}
