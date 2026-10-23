// Accuracy bench: runs real labeled photos through the same identify() the phone uses,
// against a snapshot of the full TCGdex catalog, and scores each step.
//
//   node tests/bench.mjs --photos ../pokemoncards-testphotos [--limit 50] [--only base,sm] [--split dev|holdout]
//                        [--out results.json] [--save-cards <dir>]
// --split   use only the "dev" (tuning) or "holdout" (final check) half, same split as rank-eval.mjs
// --save-cards  also save each straightened card as <dir>/<photo id>.jpg for fast OCR experiments
//
// The photo folder needs labels.json, raw/<id>.jpg and catalog/{cards,sets,set-codes}.json,
// plus catalog/details.json.gz for the card details identify's second pass looks up (without
// it every lookup is "not found", as offline) (see the private pokemoncards-testphotos repo).
// Photos never leave this machine.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startHarness, results } from './harness.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const dir = path.resolve(arg('photos', '../pokemoncards-testphotos'));
const limit = parseInt(arg('limit', '0'), 10);
const only = (arg('only', '') || '').split(',').filter(Boolean);
const outFile = arg('out', path.join(results, 'bench.json'));
const split = arg('split', 'all');
const saveCards = arg('save-cards', '');
if (saveCards) fs.mkdirSync(saveCards, { recursive: true });

// Same stable split as tests/rank-eval.mjs.
function half(id) {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0) % 2 ? 'holdout' : 'dev';
}

const labels = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json')))
  .filter((l) => l.tcgdexId && l.checkedBySecondLabeler)
  .filter((l) => !only.length || only.some((o) => l.tcgdexId.startsWith(o)))
  .filter((l) => split === 'all' || half(l.id) === split);
const todo = limit ? labels.slice(0, limit) : labels;
const cards = fs.readFileSync(path.join(dir, 'catalog/cards.json'), 'utf8');
const sets = fs.readFileSync(path.join(dir, 'catalog/sets.json'), 'utf8');
const codes = JSON.parse(fs.readFileSync(path.join(dir, 'catalog/set-codes.json')));
// Card details (HP, attacks, illustrator…) for /cards/<id>, as identify's second pass looks
// up the best few candidates: a snapshot, shaped like the TCGdex card the app downloads.
const detailsFile = path.join(dir, 'catalog/details.json.gz');
const details = fs.existsSync(detailsFile) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(detailsFile))) : {};
const cardById = new Map(JSON.parse(cards).map((c) => [c.id, c]));
const setById = new Map(JSON.parse(sets).map((s) => [s.id, s]));
function apiCard(id) {
  const d = details[id];
  const c = cardById.get(id);
  if (!d || !c) return null;
  const set = setById.get(id.slice(0, id.length - String(c.localId).length - 1));
  const has = (t, stamp) => d.variants.some((v) => v.type === t && (!stamp || (v.stamp || []).includes(stamp)));
  return {
    ...c,
    category: d.category,
    hp: d.hp ?? undefined,
    types: d.types ?? undefined,
    stage: d.stage ?? undefined,
    attacks: d.attacks.map((name) => ({ name })),
    abilities: d.abilities.map((name) => ({ type: 'Ability', name })),
    effect: d.effect || undefined,
    illustrator: d.illustrator ?? undefined,
    rarity: d.rarity,
    regulationMark: d.regulationMark ?? undefined,
    set: set && { id: set.id, name: set.name, cardCount: set.cardCount },
    variants: { normal: has('normal'), reverse: has('reverse'), holo: has('holo'), firstEdition: has('holo', '1st-edition') || has('normal', '1st-edition') },
  };
}

const h = await startHarness();
// Fresh page with routes set BEFORE the app loads, so it never caches the small test fixtures.
const page = await h.context.newPage();
page.on('pageerror', (e) => h.logs.push(`pageerror: ${e.message}`));
// Page routes win over the harness's fixture routes: serve the real catalog snapshot.
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
await page.route('https://api.tcgdex.net/**', (route) => {
  const p = new URL(route.request().url()).pathname.replace('/v2/en', '');
  if (p === '/sets') return json(route, sets);
  if (p === '/cards') return json(route, cards);
  const m = /^\/sets\/([^/]+)$/.exec(p);
  if (m) return json(route, JSON.stringify({ id: m[1], abbreviation: codes[m[1]] ? { official: codes[m[1]] } : undefined }));
  const c = /^\/cards\/([^/]+)$/.exec(p);
  const card = c && apiCard(decodeURIComponent(c[1]));
  if (card) return json(route, JSON.stringify(card));
  return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
});
await page.route('https://photos.local/**', (route) => {
  const f = path.join(dir, 'raw', path.basename(new URL(route.request().url()).pathname));
  return fs.existsSync(f) ? route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(f) }) : route.fulfill({ status: 404 });
});
await page.goto(`${h.origin}/index.html`);
await page.evaluate(async () => {
  const { catalogReady, abbrReady } = await import('/js/catalog.js');
  await catalogReady();
  await abbrReady();
});

const num = (s) => {
  const m = /^\s*[A-Za-z]*0*(\d+)/.exec(String(s || ''));
  return m ? parseInt(m[1], 10) : null;
};
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const rows = [];
const t0 = Date.now();
for (const [i, l] of todo.entries()) {
  const r = await page.evaluate(async ([id, wantCard]) => {
    const { identify } = await import('/js/identify.js');
    const { fileToCanvas } = await import('/js/ocr.js');
    const blob = await (await fetch(`https://photos.local/${id}.jpg`)).blob();
    const started = performance.now();
    try {
      const canvas = await fileToCanvas(blob);
      // border: colour of the straightened card's edge (yellow = WOTC..SWSH era, silver = SV/ME era).
      const { ranked, clues, debug, card, border } = await identify(canvas);
      const cardJpeg = wantCard && card?.width ? card.toDataURL('image/jpeg', 0.92) : null;
      return {
        clues,
        debug: { name: debug.name, bottom: debug.bottom, full: debug.full, art: debug.art, detect: debug.detect, reads: debug.reads },
        border,
        cardJpeg,
        ms: Math.round(performance.now() - started),
        top: ranked.slice(0, 5).map((x) => x.card.id),
        score: ranked[0]?.score ?? null,
        name: clues.nameBest || '',
        numbers: (clues.numbers || []).map((n) => n.text || `${n.num}/${n.total}`),
        num: clues.numbers?.[0]?.num ?? null,
        codes: clues.setCodes || [],
        detect: debug.detect || '',
        nameFrom: debug.nameFrom || '',
      };
    } catch (e) {
      return { ms: Math.round(performance.now() - started), error: String(e?.message || e), top: [] };
    }
  }, [l.id, !!saveCards]);
  if (r.cardJpeg) fs.writeFileSync(path.join(saveCards, `${l.id}.jpg`), Buffer.from(r.cardJpeg.split(',')[1], 'base64'));
  delete r.cardJpeg;
  const row = {
    id: l.id,
    truth: l.tcgdexId,
    era: l.tcgdexId.split('-')[0].replace(/[\d.]+[a-z]?$/, ''),
    kind: l.kind,
    difficulty: l.difficulty,
    conditions: l.conditions,
    ...r,
    top1: r.top[0] === l.tcgdexId,
    top5: r.top.includes(l.tcgdexId),
    found: /card found/.test(r.detect || ''),
    numberOk: r.num != null && r.num === num(l.number),
    nameOk: !!r.name && (norm(r.name).includes(norm(l.name).slice(0, 6)) || norm(l.name).includes(norm(r.name))),
  };
  rows.push(row);
  const done = i + 1;
  if (done % 10 === 0 || done === todo.length) {
    const acc = rows.filter((x) => x.top1).length;
    console.log(`${done}/${todo.length}  top-1 ${((100 * acc) / done).toFixed(1)}%  avg ${(rows.reduce((s, x) => s + x.ms, 0) / done / 1000).toFixed(1)}s/photo  elapsed ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  }
}

// ---- report ----
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
const group = (key) => {
  const g = {};
  for (const r of rows) for (const k of [].concat(r[key])) (g[k] ||= []).push(r);
  return Object.entries(g)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, v]) => `  ${k.padEnd(18)} ${String(v.length).padStart(4)}  top-1 ${pct(v.filter((x) => x.top1).length, v.length).padStart(6)}  top-5 ${pct(v.filter((x) => x.top5).length, v.length).padStart(6)}  number read ${pct(v.filter((x) => x.numberOk).length, v.length).padStart(6)}`)
    .join('\n');
};
const n = rows.length;
const summary = {
  photos: n,
  top1: rows.filter((x) => x.top1).length,
  top5: rows.filter((x) => x.top5).length,
  cardFound: rows.filter((x) => x.found).length,
  nameRead: rows.filter((x) => x.nameOk).length,
  numberRead: rows.filter((x) => x.numberOk).length,
  errors: rows.filter((x) => x.error).length,
  avgSeconds: +(rows.reduce((s, x) => s + x.ms, 0) / n / 1000).toFixed(2),
};
console.log(`
=== ACCURACY on ${n} real photos ===
Correct card (1st guess):   ${pct(summary.top1, n)}  (${summary.top1})
Correct card in top 5:      ${pct(summary.top5, n)}  (${summary.top5})
Card outline found:         ${pct(summary.cardFound, n)}
Name read:                  ${pct(summary.nameRead, n)}
Number read:                ${pct(summary.numberRead, n)}
Errors:                     ${summary.errors}
Average time per photo:     ${summary.avgSeconds}s (desktop CPU)

By era:
${group('era')}

By difficulty:
${group('difficulty')}

By condition:
${group('conditions')}
`);
fs.writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 1));
console.log(`details: ${outFile}`);
const errs = h.errors();
if (errs.length) console.log('page errors:\n' + errs.slice(0, 10).join('\n'));
await h.close();
