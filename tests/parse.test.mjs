// Collector numbers OCR mangled on real photos, read with the help of the printed set sizes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBottomText, parseLabelNumbers } from '../js/parse.js';

// Printed set sizes, as the catalog gives them (a few real ones).
const totals = new Set([64, 82, 88, 95, 101, 102, 111, 123, 165, 197, 203, 236]);
const read = (text) => parseBottomText(text, { totals }).numbers.map((n) => n.text);

test('number with the slash read as 7, or lost, next to a known set size', () => {
  assert.deepEqual(read('G MEW 1837165823'), ['183/165']);
  assert.deepEqual(read('0 _ 1997165) }'), ['199/165']);
  assert.deepEqual(read('SN224723618'), ['224/236']);
  assert.deepEqual(read('©2010 Pokemon 105123 *'), ['105/123']);
  // Without the set sizes none of these is a number.
  assert.equal(parseBottomText('G MEW 1837165823').numbers.length, 0);
});

test('number with letters around it or the rarity mark read as a digit', () => {
  assert.deepEqual(read('IS/111 x'), ['15/111']);
  assert.deepEqual(read('LT CR216/2368 RY'), ['216/236']);
  assert.deepEqual(read('B3E-83J-W7B ©2006 Pokémon 12/1014'), ['12/101']);
});

test('a zero-padded number with its slash read as a comma and a 0 as a letter', () => {
  assert.deepEqual(read('ID Q24, 086 *'), ['024/086']);
  assert.deepEqual(read('J Td 024.088 »'), ['024/088']);
});

test('a known set size comes first', () => {
  // "11/039" is no real number: the mangled one with a real set size goes first.
  assert.deepEqual(read('11/039 kk udo\n1997165'), ['199/165', '11/039']);
});

test('years, Pokédex numbers, levels, HP and weights are no numbers', () => {
  for (const t of [
    '©1795, 96, 98 Nintendo, Creatures',
    'SU975-2000 Nintendo',
    '©1995-2000 Nintendo, Creatures, GAMEFREAK',
    'LV. 55 #157',
    'NO. 0699 Tundra Pokémon HT 8\'10" WT 496.0 lbs.',
    'HP 120',
    'Weight: 175 lbs.',
    '537165053',
    '557165',
  ]) {
    assert.deepEqual(read(t), [], t);
  }
});

test('a 1- or 2-digit number needs its slash read', () => {
  // "41102" may be 4/102 or 41/102: not guessed.
  assert.deepEqual(read('41102 *'), []);
  assert.deepEqual(read('4/102 *'), ['4/102']);
});

test('a number printed zero-padded counts on its own, when nothing else was read', () => {
  // Mega Evolution promos print no set size: "J MEP EN 067".
  assert.deepEqual(read('J MEP ox wiv\n: A 067 ~~'), ['067']);
  assert.deepEqual(read('©2006 Pokémon 0 1 x 000'), []);
  // ...and never before a number with its set size.
  assert.deepEqual(read('067 POR EN 024/088'), ['024/088']);
});

test('slab label numbers', () => {
  assert.deepEqual(parseLabelNumbers('2023 SCARLET & VIOLET 151\n#199 CHARIZARD EXSIR').map((n) => [n.num, n.total]), [[199, null]]);
  assert.deepEqual(parseLabelNumbers('2026 POKEMON PERFECT ORDER\n#024/088\nAURORUS').map((n) => [n.num, n.total]), [[24, 88]]);
  // No year, no label (a misread "HP 330" on a card's name bar).
  assert.deepEqual(parseLabelNumbers('Charizard ex\n#330'), []);
});
