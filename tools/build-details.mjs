// Builds the card details file the app ships, data/details-<hash>.json (see js/details.js),
// from a snapshot of every English card's details on TCGdex.
//
//   node tools/build-details.mjs <snapshot.json.gz | snapshot.json>
//
// The snapshot is catalog/details.json.gz in the private test-photo repo, made by its
// tools/snapshot_details.py ("Snapshot card details" Action), which downloads each card from
// the TCGdex API. It holds only public TCGdex card data, nothing from the photos:
//   { "<card id>": { hp, stage, attacks: [name], abilities: [name], effect, illustrator,
//                    rarity, regulationMark, variants: [{ type, subtype, stamp, foil, size }], … } }
// The file is named after a hash of its contents, so an unchanged snapshot gives the same file
// (phones don't download it again). Older details files are deleted and js/assets.js is
// updated (tools/assets.mjs). Commit data/ and js/assets.js together.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { packDetails, readDetails } from '../js/details.js';
import { cardDetails } from '../js/rerank.js';
import { root, listAssets, renderAssets } from './assets.mjs';

/** Pack a snapshot; returns { name: 'details-<hash>.json', text, cards }. */
export function buildDetails(snapshot) {
  const packed = packDetails(snapshot);
  const text = JSON.stringify(packed);
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);
  return { name: `details-${hash}.json`, text, cards: packed.cards.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: node tools/build-details.mjs <snapshot.json.gz | snapshot.json>');
    process.exit(2);
  }
  const raw = fs.readFileSync(src);
  const snapshot = JSON.parse(src.endsWith('.gz') ? zlib.gunzipSync(raw) : raw);
  // Pokémon TCG Pocket cards (ids like "A1-001") aren't in the app's card list.
  for (const id of Object.keys(snapshot)) if (/^[A-Z]/.test(id)) delete snapshot[id];
  const { name, text, cards } = buildDetails(snapshot);

  // Check every card reads back with the details the ranking uses unchanged (the trainer text
  // is cut to the part it compares) and all its versions.
  const back = readDetails(JSON.parse(text));
  const ranked = (d) => ({ ...cardDetails(d), effect: (d.effect || '').split(/[.!]/)[0].slice(0, 60) });
  for (const id of Object.keys(snapshot)) {
    const c = back.card(id);
    const d = snapshot[id];
    const same = c && JSON.stringify(ranked(c)) === JSON.stringify(ranked(d)) && c.variants_detailed.length === (d.variants || []).filter((v) => v?.type).length;
    if (!same) throw new Error(`card ${id} doesn't read back the same: ${JSON.stringify(ranked(c || {}))} vs ${JSON.stringify(ranked(d))}`);
  }

  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^details-.*\.json$/.test(f) && f !== name) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, name), text);
  fs.writeFileSync(path.join(root, 'js/assets.js'), renderAssets(listAssets()));
  const kb = (n) => `${Math.round(n / 1000)} KB`;
  console.log(`data/${name}: ${cards} cards, ${kb(text.length)} (gzip ${kb(zlib.gzipSync(text, { level: 9 }).length)}); js/assets.js updated`);
}
