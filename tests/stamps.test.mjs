import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectStamps, findStamps, findPhrase, findWord, pickVariant, chooseVariant } from '../js/stamps.js';
import { variantPrices } from '../js/prices.js';

const fx = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const aurorus = fx('card-me03-024.json'); // Perfect Order: Holo, Reverse Holo, Set Logo Stamp, Cosmos Holo
const baseCharizard = fx('card-base1-4.json'); // Unlimited, 1st Edition Shadowless, Shadowless, 1999-2000
const charizardEx = fx('card-sv03-125.json'); // Holo, Jumbo, Play! Pokémon stamp
const label = (card, artText, extra = {}) => {
  const rows = variantPrices(card);
  return rows[chooseVariant(rows, { card, clues: artText == null ? null : { artText }, ...extra })]?.label;
};

// What Tesseract read on the artwork of the user's real photo (toploader, $25 sticker),
// at different scales / polarities. The stylized "O" of ORDER often reads as "D" or vanishes.
const REAL_READS = [
  '*\n1,4\naaa\n-y\na 2/\nI\nay)\nAN\n1.4\nYou\noP\nPERFECT\nPa\nDER\nJ. 8 J\nSIE Tundra Wall\nJ —',
  'CA habia Meaddhh ae\n1\nowt\nI\n<\nER\nny\nnr 4\n-\na\noN ’\nsf\npas \\\n- WM\nNL\n1.8%.\ny./\nPERFEC\nX\nDER\n.\nAy!',
  '»\nWe\nBs 2/\n»\noN\n=).\nVa\n—\nh Na\nPERFECT,\n"ED\nRDER"\nJ 8 J\nIED) Tundra Wall\nag wie',
  'AL LS |\n=m\nPERFECT / B\n, DRDER~_88\nwy -            - Si',
  'ame\n-y\nwg\noN\nay)\npr\nsd\nYe\nVW .\nPERFECT,\n—\n4\nDRDE\n——\nJ 810\nSEE Tundra of',
  'gl a xf -y oN 1; sa ~~ * a , / <8\nPERFECT,\nRR\nJ 8 iu SIE) Tundra Wall',
  'rg, ho >, Ew MIRA Fv \\ PERFECT / \' £4 sol Ia Nai ti), 8 0 pe Wall',
];

test('reads the Perfect Order set-logo stamp from noisy OCR', () => {
  for (const t of REAL_READS) assert.deepEqual(detectStamps(t, aurorus), ['set-logo'], t);
  for (const t of ['PERFECT ORDER', 'MEGA EVOLUTION\nPERFECT ORDER', 'PERFFCT ORDFR', 'PERFECT\n0RDER', 'PERFECT DRDER', 'mega evolutiom\nPERFECT\nORDER']) {
    assert.deepEqual(detectStamps(t, aurorus), ['set-logo'], t);
  }
  const [hit] = findStamps('xx\nPERFECT\nDRDER\nyy', aurorus);
  assert.equal(hit.label, 'Perfect Order set logo');
  assert.equal(hit.read, 'PERFECT DRDER');
});

test('no stamp from ordinary card text or artwork noise', () => {
  const ordinary = [
    'Evolves from Amaura',
    'NO. 0699 Tundra Pokémon HT: 8\'10" WT: 496 lbs.',
    'Tundra Wall\nAll of your Pokémon that have any Energy attached take 50 less damage',
    'Perfect Order', // mixed case: card text, not a stamp
    'The perfect order of things', // a sentence
    'IMPERFECT', // a longer word
    'PERFEC', // too little of it
    'PERF ORD',
    'ORDER', // the short word alone
    'Once during your turn, you may play a Pokémon. 1st Edition',
    'Discard 2 Energy attached to this Pokémon in order to use this attack.',
    'CA habia Meaddhh ae\n1\nowt\nI\n<\nER\nny\nnr 4\nNL\n1.8%.\ny./\nAy!\nai HB AG Wl dvb',
    'EE 2 a\nWo ae\nSEE\nAAAA\nIIIII\nMMMM',
  ];
  for (const t of ordinary) assert.deepEqual(detectStamps(t, aurorus), [], t);
  assert.deepEqual(detectStamps('', aurorus), []);
  assert.deepEqual(detectStamps(null, aurorus), []);
});

test('the set name only counts for cards of that set', () => {
  // A Perfect Order stamp read on an Obsidian Flames card is not its set logo.
  assert.deepEqual(detectStamps('PERFECT ORDER', charizardEx), []);
  assert.deepEqual(detectStamps('OBSIDIAN FLAMES', charizardEx), ['set-logo']);
  // Mega Evolution card text mentions the set name, in mixed case.
  const me01 = { set: { id: 'me01', name: 'Mega Evolution' } };
  assert.deepEqual(detectStamps('When your Mega Evolution Pokémon ex is Knocked Out', me01), []);
  assert.deepEqual(detectStamps('MEGA EVOLUTION', me01), ['set-logo']);
  // Short or common-word set names.
  assert.deepEqual(detectStamps('151 151', { set: { name: '151' } }), []);
  assert.deepEqual(detectStamps('In the jungle', { set: { name: 'Jungle' } }), []);
  assert.deepEqual(detectStamps('Evolves from Charmeleon', { set: { name: 'Evolutions' } }), []);
  assert.deepEqual(detectStamps('EVOLUTI0NS', { set: { name: 'Evolutions' } }), ['set-logo']);
});

test('other stamps: 1st Edition, prerelease, staff, Pokémon Center, Play! Pokémon', () => {
  assert.deepEqual(detectStamps('1 EDITION', baseCharizard), ['1st-edition']);
  assert.deepEqual(detectStamps('lst EDlTION', baseCharizard), ['1st-edition']);
  assert.deepEqual(detectStamps('Edition', baseCharizard), []);
  assert.deepEqual(detectStamps('PRERELEASE', baseCharizard), ['prerelease']);
  assert.deepEqual(detectStamps('PRE-RELEASE', baseCharizard), ['prerelease']);
  assert.deepEqual(detectStamps('STAFF', baseCharizard), ['staff']);
  assert.deepEqual(detectStamps('Staff of the gym', baseCharizard), []);
  assert.deepEqual(detectStamps('STAF', baseCharizard), []);
  assert.deepEqual(detectStamps('POKEMON CENTER', baseCharizard), ['pokemon-center']);
  assert.deepEqual(detectStamps('PLAY!\nPOKEMON', charizardEx), ['player-rewards-program']);
  assert.deepEqual(detectStamps('PLAY! POKéMON', charizardEx), ['player-rewards-program']);
  // Card text: "When you play this Pokémon from your hand to evolve…"
  assert.deepEqual(detectStamps('When you play this Pokémon from your hand', charizardEx), []);
  assert.deepEqual(detectStamps('you may play Pokémon', charizardEx), []);
});

test('findWord / findPhrase report what was read', () => {
  assert.deepEqual(findWord('xx EDITI0N yy', 'EDITION'), { edits: 0, read: 'EDITI0N' });
  assert.equal(findWord('STAFFS', 'STAFF'), null);
  assert.deepEqual(findPhrase('a PERFECT\n\nORDER b', 'Perfect Order'), { edits: 0, read: 'PERFECT ORDER' });
  assert.equal(findPhrase('Perfect order', 'Perfect Order'), null);
});

test('picks the stamped version when its stamp is read', () => {
  assert.equal(label(aurorus, 'xx\nPERFECT\nPa\nDER'), 'Set Logo Stamp');
  assert.equal(label(baseCharizard, '1 EDITION'), '1st Edition Shadowless Holo');
  assert.equal(label(charizardEx, 'PLAY! POKEMON'), 'Holo Play! Pokémon Stamp');
  const rows = variantPrices(aurorus);
  const pick = pickVariant(rows, { card: aurorus, clues: { artText: 'PERFECT DRDER' } });
  assert.equal(rows[pick.index].label, 'Set Logo Stamp');
  assert.deepEqual(pick.stamps.map((s) => s.stamp), ['set-logo']);
  assert.match(pick.reason, /Perfect Order set logo stamp/);
  assert.match(pick.reason, /Set Logo Stamp version/);
});

test('keeps the plain version without a stamp, and never guesses holo / reverse / cosmos', () => {
  assert.equal(label(aurorus, ''), 'Holo');
  assert.equal(label(aurorus, null), 'Holo');
  assert.equal(label(aurorus, 'REVERSE HOLO COSMOS'), 'Holo');
  assert.equal(label(baseCharizard, ''), 'Holo'); // unlimited
  assert.equal(label(charizardEx, ''), 'Holo');
  // A stamp this card isn't printed with is ignored (a misread).
  assert.equal(label(aurorus, '1 EDITION'), 'Holo');
  assert.equal(label(charizardEx, 'STAFF'), 'Holo');
});

test('without a stamp, an unstamped version beats a stamped one listed first', () => {
  const rows = [
    { id: 'a', label: 'Holo Staff Stamp', size: 'standard', stamps: ['staff'], cm: { trend: 9 } },
    { id: 'b', label: 'Jumbo', size: 'jumbo', stamps: [], cm: { trend: 1 } },
    { id: 'c', label: 'Holo', size: 'standard', stamps: [], tcg: { market: 1 } },
  ];
  assert.equal(chooseVariant(rows, {}), 2);
  assert.equal(chooseVariant(rows, { clues: { artText: 'STAFF' } }), 0);
  assert.equal(chooseVariant([], {}), 0);
  // Nothing priced: the first standard unstamped version.
  assert.equal(chooseVariant(rows.map((r) => ({ ...r, tcg: null, cm: null })), {}), 2);
});

test('tells the user about stamped versions it did not see', () => {
  const rows = variantPrices(aurorus);
  const pick = pickVariant(rows, { card: aurorus, clues: { artText: 'nothing here' } });
  assert.equal(rows[pick.index].label, 'Holo');
  assert.deepEqual(pick.stamps, []);
  assert.match(pick.reason, /also comes as Set Logo Stamp/);
  // No stamped versions: nothing to say.
  const plain = { set: { name: 'Plain' }, variants_detailed: [{ type: 'holo', size: 'standard', pricing: { tcgplayer: { holofoil: { marketPrice: 1 } } } }] };
  assert.equal(pickVariant(variantPrices(plain), { card: plain, clues: { artText: '' } }).reason, null);
});

test('a saved version wins; the explanation stays only if it matches the scan', () => {
  const rows = variantPrices(aurorus);
  const reverse = rows.find((r) => r.type === 'reverse');
  const stampRow = rows.find((r) => r.stamps.includes('set-logo'));
  assert.equal(rows[chooseVariant(rows, { card: aurorus, clues: { artText: 'PERFECT ORDER' }, preferred: reverse.id })], reverse);
  assert.equal(rows[chooseVariant(rows, { card: aurorus, preferred: 'Reverse Holo' })], reverse);
  assert.equal(pickVariant(rows, { card: aurorus, preferred: reverse.id }).reason, null);
  const same = pickVariant(rows, { card: aurorus, clues: { artText: 'PERFECT ORDER' }, preferred: stampRow.id });
  assert.equal(rows[same.index], stampRow);
  assert.match(same.reason, /Spotted a Perfect Order set logo stamp/);
  // Unknown saved id: fall back to the scan.
  assert.equal(rows[chooseVariant(rows, { card: aurorus, clues: { artText: 'PERFECT ORDER' }, preferred: 'gone' })], stampRow);
});
