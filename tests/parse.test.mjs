// Collector numbers OCR mangled on real photos, read with the help of the printed set sizes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBottomText, parseLabelNumbers, pickName } from '../js/parse.js';

// Printed set sizes, as the catalog gives them (a few real ones).
const totals = new Set([20, 64, 82, 88, 95, 101, 102, 111, 123, 165, 197, 203, 236]);
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
  // ...with the rarity mark read as a digit after the set size.
  assert.deepEqual(read('Rw Q24, 0886 *'), ['024/088']);
  // A list of copyright years is no number.
  assert.deepEqual(read('©1995 96.97, 93 Nintendo'), []);
  assert.deepEqual(read('Sugimori 519965. 96. 98 |'), []);
});

test('a number with a stray comma, its set size split, or a dash before it', () => {
  // The slash read as "7," on an italic special-art number.
  assert.deepEqual(read('MEW 1997,165 R25'), ['199/165']);
  // "/203" read as "/20 3": not 189/20 (no number runs 150 past its set size), nor 89/20.
  assert.deepEqual(read('189/20 38 4'), ['189/203']);
  assert.deepEqual(read('189/20 *'), []);
  // The set symbol read as "-8" before the number: a dash only rules out a number without a slash.
  assert.deepEqual(read('Sa 12 -8189/2038'), ['189/203']);
  assert.deepEqual(read('resistance -30 retreat'), []);
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

test('a 1- or 2-digit number with its slash read as 1 or lost needs the rarity mark after it', () => {
  assert.deepEqual(read('4/102 *'), ['4/102']);
  // Older cards print the mark right after the set size ("10/64★").
  assert.deepEqual(read('©1999 Wizards\n10164★'), ['10/64']);
  assert.deepEqual(read('Illus. Ken Sugimori\n1664*'), ['16/64']);
  assert.deepEqual(read('LV. 42 #59\n4102*'), ['4/102']);
  // More than one reading fits: both are given, the name decides.
  assert.deepEqual(read('41102 *'), ['4/102', '41/102']);
  assert.deepEqual(read('1164★'), ['1/64', '11/64']);
  // No mark, a size that doesn't exist, a number past its size: no number.
  assert.deepEqual(read('©1999 Wizards 41102'), []);
  assert.deepEqual(read('7117*'), []);
  assert.deepEqual(read('9520*'), []);
  // ...nor when a number was found the regular way.
  assert.deepEqual(read('15/64 LV.35\n15164★'), ['15/64']);
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

test('the evolves-from line is no name, even with "Evolves" lost', () => {
  const best = (...texts) => pickName(texts.map((text, i) => ({ text, height: 40 - i, conf: 90 }))).best;
  assert.equal(best('rom Charmeleon', 'Charizard'), 'Charizard');
  assert.equal(best('volves from Croconaw'), '');
  assert.equal(best('Gengar Zw plves rom Haunter'), 'Gengar Zw');
  assert.equal(best('Romantic Charizard'), 'Romantic Charizard');
});
