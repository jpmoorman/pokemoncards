// The benches' printing-level score (tests/printing.mjs): which printed version the result
// sheet shows first, what a photo's labelled version asks for, and the dev / holdout split.
//   node --test tests/printing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { half, splitOf, sheetCard, chosenPrinting, wantedPrinting, scorePrinting, printingSummary } from './printing.mjs';

// A slice of the bench's catalog snapshot (cards.json, sets.json, details.json.gz).
const cards = [
  { id: 'base1-4', localId: '4', name: 'Charizard' },
  { id: 'sv08-072', localId: '072', name: 'Pikachu' },
  { id: 'ex15-28', localId: '28', name: 'Seadra' },
  { id: 'mep-070', localId: '070', name: 'Pikachu' },
  { id: 'sv03.5-199', localId: '199', name: 'Charizard ex' },
];
const sets = [
  { id: 'base1', name: 'Base Set', cardCount: { official: 102 } },
  { id: 'sv08', name: 'Surging Sparks', cardCount: { official: 191 } },
  { id: 'ex15', name: 'Dragon Frontiers', cardCount: { official: 101 } },
  { id: 'mep', name: 'MEP Black Star Promos', cardCount: { official: 100 } },
  { id: 'sv03.5', name: '151', cardCount: { official: 165 } },
];
const details = {
  'base1-4': { variants: [{ type: 'holo', subtype: 'unlimited', size: 'standard' }, { type: 'holo', subtype: 'shadowless', stamp: ['1st-edition'], size: 'standard' }, { type: 'holo', subtype: 'shadowless', size: 'standard' }] },
  'sv08-072': { variants: [{ type: 'normal', size: 'standard' }, { type: 'reverse', size: 'standard' }] },
  'ex15-28': { variants: [{ type: 'normal', size: 'standard' }, { type: 'normal', stamp: ['set-logo'], size: 'standard' }] },
  'mep-070': { variants: [{ type: 'holo', size: 'standard' }, { type: 'holo', stamp: ['pokemon-center'], size: 'standard' }] },
  'sv03.5-199': { variants: [{ type: 'holo', size: 'standard' }, { type: 'holo', size: 'jumbo' }] },
};
const snap = { cardById: new Map(cards.map((c) => [c.id, c])), setById: new Map(sets.map((s) => [s.id, s])), details };
const card = (id) => sheetCard(id, snap);
const label = (version, extra = {}) => ({ version, versionAgreed: true, versionAlt: null, notes: '', ...extra });

test('the version shown first: the plain one, unless a stamp the card comes with was read', () => {
  assert.equal(card('base1-4').set.name, 'Base Set');
  assert.equal(chosenPrinting(card('base1-4'), { artText: '' }).label, 'Holo'); // unlimited
  assert.equal(chosenPrinting(card('base1-4'), { artText: 'Flame Pokémon\n1 EDITION' }).label, '1st Edition Shadowless Holo');
  // A set logo is read as the set's name in capitals.
  assert.equal(chosenPrinting(card('ex15-28'), { artText: 'DRAGON FRONTIERS' }).label, 'Set Logo Stamp');
  assert.equal(chosenPrinting(card('ex15-28'), null).label, 'Normal');
  // Holo vs reverse holo can't be told from text: never guessed.
  assert.equal(chosenPrinting(card('sv08-072'), { artText: '' }).label, 'Normal');
  assert.equal(chosenPrinting(null, {}), null);
});

test('what a label asks for', () => {
  assert.deepEqual(wantedPrinting(card('base1-4'), label('1st-edition')), { rows: ['v-1'] });
  assert.deepEqual(wantedPrinting(card('base1-4'), label('shadowless')), { rows: ['v-2'] });
  assert.deepEqual(wantedPrinting(card('base1-4'), label('unlimited')), { rows: ['v-0'] });
  // "holo" on a Base Set card: the unlimited print (not the shadowless one).
  assert.deepEqual(wantedPrinting(card('base1-4'), label('holo')), { rows: ['v-0'] });
  assert.deepEqual(wantedPrinting(card('sv08-072'), label('reverse-holo')), { rows: ['v-1'] });
  // One standard-size printing: the card is the printing (a jumbo one doesn't count).
  assert.deepEqual(wantedPrinting(card('sv03.5-199'), label('full-art/special')), { implied: true });
  // Labels that say nothing, or two labellers who disagree, aren't scored.
  assert.equal(wantedPrinting(card('base1-4'), label('unknown')).why, 'label names no printing');
  assert.equal(wantedPrinting(card('base1-4'), label('holo', { versionAgreed: false, versionAlt: 'shadowless' })).why, 'labellers disagree');
  assert.equal(wantedPrinting(card('base1-4'), label('holo', { versionAgreed: false, versionAlt: null })).why, 'labellers disagree');
  assert.equal(wantedPrinting(card('sv08-072'), label('unknown', { versionAgreed: false, versionAlt: 'reverse-holo' })).why, 'labellers disagree');
  // ...unless both name the same printing: an EX-era reverse holo is TCGdex's set-logo print.
  assert.deepEqual(wantedPrinting(card('ex15-28'), label('reverse-holo', { versionAgreed: false, versionAlt: 'set-logo-stamp' })), { rows: ['v-1'] });
  assert.equal(wantedPrinting(card('ex15-28'), label('reverse-holo')).why, 'printing not in TCGdex');
  // "other-stamp": the stamp the notes name.
  assert.deepEqual(wantedPrinting(card('mep-070'), label('other-stamp', { notes: "A 'Pokémon Center' stamp in the art" })), { rows: ['v-1'] });
  assert.equal(wantedPrinting(null, label('holo')).why, 'no printings in the snapshot');
});

test('scoring a scan: right card and the version shown first', () => {
  const first = label('1st-edition');
  assert.deepEqual(scorePrinting('base1-4', card('base1-4'), { artText: '' }, first), { ok: false, printing: 'Holo', wanted: ['1st Edition Shadowless Holo'], why: '' });
  assert.equal(scorePrinting('base1-4', card('base1-4'), { artText: '1 EDITION' }, first).ok, true);
  assert.equal(scorePrinting('base4-4', card('base1-4'), { artText: '1 EDITION' }, first).why, 'wrong card');
  assert.equal(scorePrinting('base4-4', card('base1-4'), {}, first).ok, false);
  assert.equal(scorePrinting('sv03.5-199', card('sv03.5-199'), {}, label('holo')).ok, true);
  assert.equal(scorePrinting('base1-4', card('base1-4'), {}, label('unknown')).ok, null);
  const sum = printingSummary([
    { version: '1st-edition', score: scorePrinting('base1-4', card('base1-4'), { artText: '1 EDITION' }, first) },
    { version: '1st-edition', score: scorePrinting('base1-4', card('base1-4'), {}, first) },
    { version: 'holo', score: scorePrinting('sv03.5-199', card('sv03.5-199'), {}, label('holo')) },
    { version: 'unknown', score: scorePrinting('base1-4', card('base1-4'), {}, label('unknown')) },
  ]);
  assert.deepEqual(sum.all, { photos: 4, scored: 3, card: 3, printing: 2, choice: 2, choiceRight: 1 });
  assert.deepEqual(sum.byVersion['1st-edition'], { photos: 2, scored: 2, card: 2, printing: 1, choice: 2, choiceRight: 1 });
});

test('dev / holdout split: by photo as before, or every photo of a card in the same half', () => {
  // The split every number so far used: FNV-1a of the photo id, odd = holdout.
  const old = (id) => {
    let h = 2166136261;
    for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return (h >>> 0) % 2 ? 'holdout' : 'dev';
  };
  for (const id of ['photo-1', 'photo-2', 'photo-3', 'photo-4', 'x']) {
    assert.equal(half(id), old(id));
    assert.equal(splitOf({ id, tcgdexId: 'base1-4' }), old(id));
    assert.equal(splitOf({ id, truth: 'base1-4' }, 'photo'), old(id));
  }
  const byCard = (id, card) => splitOf({ id, tcgdexId: card }, 'card');
  assert.equal(byCard('a', 'base1-4'), byCard('b', 'base1-4'));
  assert.equal(splitOf({ id: 'a', truth: 'base1-4' }, 'card'), byCard('z', 'base1-4'));
  // Both halves get cards.
  const halves = new Set(['base1-4', 'base1-2', 'sv03-125', 'swsh4-25', 'dp1-1', 'xy1-1'].map((c) => byCard('a', c)));
  assert.deepEqual([...halves].sort(), ['dev', 'holdout']);
  assert.throws(() => splitOf({ id: 'a' }, 'set'), /photo or card/);
});
