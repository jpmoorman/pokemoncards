// The card details file shipped with the app (js/details.js, tools/build-details.mjs):
// packing and reading back, and that the shipped file is the one js/assets.js lists.
//   node --test tests/details.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { packDetails, readDetails, FORMAT } from '../js/details.js';
import { cardDetails } from '../js/rerank.js';
import { buildDetails } from '../tools/build-details.mjs';
import { root } from '../tools/assets.mjs';
import { ASSETS } from '../js/assets.js';

const SNAP = {
  'base1-4': { hp: 120, types: ['Fire'], stage: 'Stage2', category: 'Pokemon', attacks: ['Fire Spin'], abilities: ['Energy Burn'], effect: '', illustrator: 'Mitsuhiro Arita', rarity: 'Rare', regulationMark: null, variants: [{ type: 'holo', size: 'standard' }, { type: 'holo', stamp: ['1st-edition'], size: 'standard' }, { type: 'holo', subtype: 'shadowless', size: 'standard' }] },
  'sv03-125': { hp: 330, stage: 'Stage2', attacks: [{ name: 'Burning Darkness' }], abilities: [{ name: 'Infernal Reign' }], illustrator: '5ban Graphics', rarity: 'Double rare', regulationMark: 'G', variants: [{ type: 'holo', size: 'standard' }] },
  'sm9-144': { hp: null, stage: null, attacks: [], abilities: [], effect: 'Look at the top card of your deck, and then choose 1:\n\n• Discard it. Or something!', illustrator: 'None', rarity: 'None', regulationMark: 'None', variants: [{ type: 'normal', size: 'standard' }, { type: 'reverse', foil: 'cosmos', size: 'jumbo' }] },
  'odd|id~x': { hp: 60, attacks: ['A|B', 'C~D'], illustrator: 'X|Y', rarity: 'Rare', variants: [] },
  'a-1': {},
};

test('packed details read back with everything the ranking uses', () => {
  const file = readDetails(JSON.parse(JSON.stringify(packDetails(SNAP))));
  assert.equal(file.size, 5);
  const c = file.card('base1-4');
  assert.deepEqual(cardDetails(c), cardDetails(SNAP['base1-4']));
  assert.equal(c.hp, 120);
  assert.deepEqual(c.attacks, [{ name: 'Fire Spin' }]);
  assert.deepEqual(c.abilities, [{ type: 'Ability', name: 'Energy Burn' }]);
  assert.deepEqual(c.variants, { normal: false, reverse: false, holo: true, firstEdition: true });
  assert.deepEqual(c.variants_detailed, [{ type: 'holo', size: 'standard' }, { type: 'holo', stamp: ['1st-edition'], size: 'standard' }, { type: 'holo', subtype: 'shadowless', size: 'standard' }]);
  // TCGdex's own shape (attacks [{ name }]) packs the same.
  assert.deepEqual(cardDetails(file.card('sv03-125')), cardDetails(SNAP['sv03-125']));
  assert.equal(file.card('sv03-125').regulationMark, 'G');
});

test('missing values, "None" and the trainer text', () => {
  const file = readDetails(packDetails(SNAP));
  const c = file.card('sm9-144');
  assert.equal(c.hp, undefined);
  assert.equal(c.illustrator, undefined);
  assert.equal(c.rarity, undefined);
  assert.equal(c.regulationMark, undefined);
  // Only the part rerank.js compares: the first sentence, up to 60 characters.
  assert.equal(c.effect, 'Look at the top card of your deck, and then choose 1:\n\n• Dis');
  assert.deepEqual(c.variants_detailed[1], { type: 'reverse', foil: 'cosmos', size: 'jumbo' });
  assert.deepEqual(cardDetails(c), { ...cardDetails(SNAP['sm9-144']), effect: c.effect });
  const empty = file.card('a-1');
  assert.deepEqual(empty.attacks, []);
  assert.deepEqual(empty.variants_detailed, []);
});

test('separator characters in names are replaced, not mistaken for fields', () => {
  const file = readDetails(packDetails(SNAP));
  assert.equal(file.card('odd|id~x'), null); // an id can't hold them (none does)
  const all = packDetails(SNAP).cards.join('\n');
  assert.ok(all.includes('A B~C D'));
  assert.ok(packDetails(SNAP).illustrators.includes('X Y'));
});

test('lookups: every card found, unknown ids and other formats give null', () => {
  const ids = Array.from({ length: 500 }, (_, i) => `set${i % 7}-${i}`);
  const snap = Object.fromEntries(ids.map((id, i) => [id, { hp: 10 + i, attacks: [`Attack ${i}`] }]));
  const file = readDetails(packDetails(snap));
  for (const [i, id] of ids.entries()) assert.equal(file.card(id)?.hp, 10 + i, id);
  assert.equal(file.card('nope-1'), null);
  assert.equal(file.card(''), null);
  assert.equal(readDetails({ format: 'card-details-0', cards: [] }), null);
  assert.equal(readDetails(null), null);
});

test('the same snapshot always builds the same file name', () => {
  const a = buildDetails(SNAP);
  const b = buildDetails(JSON.parse(JSON.stringify(SNAP)));
  assert.equal(a.name, b.name);
  assert.match(a.name, /^details-[0-9a-f]{10}\.json$/);
  assert.notEqual(buildDetails({ ...SNAP, 'x-1': { hp: 1 } }).name, a.name);
});

test('the shipped details file is listed in js/assets.js and reads', () => {
  const listed = Object.keys(ASSETS).filter((p) => /^data\/details-[\w-]+\.json$/.test(p));
  assert.equal(listed.length, 1, 'exactly one details file');
  const file = readDetails(JSON.parse(fs.readFileSync(path.join(root, listed[0]))));
  assert.ok(file, `${listed[0]} is in format ${FORMAT}`);
  assert.ok(file.size > 20000, `${file.size} cards`);
  assert.equal(file.card('base1-4').hp, 120);
});

// With the private test-photo repo next to this one: the shipped file gives the ranking exactly
// what the snapshot it was built from gives, for every card.
const snapshotFile = path.resolve(root, '../pokemoncards-testphotos/catalog/details.json.gz');
test('every card ranks the same from the shipped file as from the snapshot', { skip: !fs.existsSync(snapshotFile) && 'no snapshot here' }, () => {
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(snapshotFile)));
  const built = buildDetails(snap);
  const listed = Object.keys(ASSETS).find((p) => p.startsWith('data/details-'));
  if (listed !== `data/${built.name}`) return; // the shipped file comes from another snapshot
  const file = readDetails(JSON.parse(built.text));
  const cut = (d) => ({ ...cardDetails(d), effect: (d.effect || '').split(/[.!]/)[0].slice(0, 60) });
  let n = 0;
  for (const [id, d] of Object.entries(snap)) {
    assert.deepEqual(cut(file.card(id)), cut(d), id);
    n++;
  }
  assert.ok(n > 20000);
});
