// Fast offline scoring of the card-ranking step on saved bench output (no OCR, no browser).
// 1) node tests/bench.mjs --photos <dir> --out bench.json      (slow: runs OCR once, saves what was read)
// 2) node tests/rank-eval.mjs --bench bench.json --photos <dir> (seconds: re-ranks from the saved reads)
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

// Optional re-ranking module under test: --rerank js/rerank.js exporting rerank(ranked, row, ctx).
const rerankPath = arg('rerank', '');
const rerank = rerankPath ? (await import(path.resolve(rerankPath))).rerank : null;

let top1 = 0;
let top5 = 0;
const misses = [];
for (const r of rows) {
  let ranked = rankCandidates(index, r.clues, codes, 40);
  if (rerank) ranked = await rerank(ranked, r, { index, details, codes });
  const ids = ranked.slice(0, 5).map((x) => x.card.id);
  if (ids[0] === r.truth) top1++;
  else misses.push({ id: r.id, truth: r.truth, got: ids.slice(0, 3), name: r.clues.nameBest, numbers: (r.clues.numbers || []).map((n) => n.text) });
  if (ids.includes(r.truth)) top5++;
}
const pct = (a) => `${((100 * a) / rows.length).toFixed(1)}%`;
console.log(`${split}: ${rows.length} photos  top-1 ${pct(top1)} (${top1})  top-5 ${pct(top5)} (${top5})`);
if (verbose) for (const m of misses.slice(0, 40)) console.log(`  ${m.id} ${m.truth} <- ${m.got.join(', ')}  name="${m.name}" num=${m.numbers.join('|')}`);
