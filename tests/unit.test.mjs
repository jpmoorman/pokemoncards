import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBottomText, pickName, cleanNameLine } from '../js/parse.js';
import { buildIndex, rankCandidates, partialSimilarity, parseLocalId, manualSearch, confidence } from '../js/match.js';
import { variantPrices, headlinePrice, marketLinks, searchQuery } from '../js/prices.js';

const fx = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const catalog = fx('catalog.json');
const index = buildIndex(catalog.cards, catalog.sets);
const top = (clues) => rankCandidates(index, { nameBest: '', nameAll: '', numbers: [], setCodes: [], codeCandidates: [], ...clues }, catalog.abbr)[0]?.card.id;

test('parses modern bottom line with set code', () => {
  const r = parseBottomText('G OBF EN 125/197 ★\nIllus. 5ban Graphics');
  assert.deepEqual(r.numbers[0], { prefix: '', num: 125, total: 197 });
  assert.deepEqual(r.setCodes, ['OBF']);
});

test('parses vintage number and OCR digit confusions', () => {
  assert.deepEqual(parseBottomText('Illus. Mitsuhiro Arita  4/102 ●').numbers[0], { prefix: '', num: 4, total: 102 });
  assert.deepEqual(parseBottomText('l25/I97').numbers[0], { prefix: '', num: 125, total: 197 });
  assert.deepEqual(parseBottomText('125 / 197').numbers[0], { prefix: '', num: 125, total: 197 });
});

test('ignores copyright years and attack text', () => {
  const r = parseBottomText('©2023 Pokémon/Nintendo/Creatures/GAME FREAK weakness ×2 resistance -30 retreat');
  assert.equal(r.numbers.length, 0);
});

test('parses trainer gallery and promo numbers', () => {
  assert.deepEqual(parseBottomText('TG05/TG30').numbers[0], { prefix: 'TG', num: 5, total: 30 });
  assert.deepEqual(parseBottomText('SWSH050').numbers[0], { prefix: 'SWSH', num: 50, total: null });
});

test('cleans name lines', () => {
  assert.equal(cleanNameLine('STAGE 2 Charizard ex HP330'), 'Charizard ex');
  assert.equal(cleanNameLine('Charizard 120 HP'), 'Charizard');
  assert.equal(cleanNameLine('TRAINER'), '');
  assert.equal(cleanNameLine('Evolves from Charmeleon'), '');
  assert.equal(cleanNameLine('Item Finder'), 'Item Finder');
  const n = pickName([{ text: 'STAGE2', height: 20 }, { text: 'Charizard ex HP 330', height: 60 }, { text: 'Evolves from Charmeleon', height: 14 }]);
  assert.equal(n.best, 'Charizard ex');
});

test('similarity tolerates OCR noise', () => {
  assert.equal(partialSimilarity('Charizard ex', 'xx Charizardex yy'), 1);
  assert.ok(partialSimilarity('Charizard ex', 'Charlzard ex') > 0.75);
  assert.ok(partialSimilarity('Pikachu', 'Charizard ex') < 0.3);
});

test('localId parsing', () => {
  assert.deepEqual(parseLocalId('TG05'), { prefix: 'TG', num: 5 });
  assert.deepEqual(parseLocalId('001'), { prefix: '', num: 1 });
  assert.equal(parseLocalId('?'), null);
});

test('Pocket sets are excluded', () => {
  assert.ok(!index.entries.some((e) => e.setId === 'A1'));
});

test('number + total + name picks the exact printing', () => {
  assert.equal(top({ nameBest: 'Charizard ex', numbers: [{ prefix: '', num: 125, total: 197 }] }), 'sv03-125');
  // Same number in three sets; the set code decides.
  assert.equal(top({ numbers: [{ prefix: '', num: 125, total: null }], setCodes: ['OBF'] }), 'sv03-125');
  assert.equal(top({ nameBest: 'Mega Charizard X ex', numbers: [{ prefix: '', num: 125, total: 94 }] }), 'me02-125');
});

test('vintage card without set code: number/total + name', () => {
  assert.equal(top({ nameBest: 'Charizard', numbers: [{ prefix: '', num: 4, total: 102 }] }), 'base1-4');
  assert.equal(top({ nameBest: 'Jolteon', numbers: [{ prefix: '', num: 4, total: 64 }] }), 'base2-4');
});

test('misread number still finds the card by name', () => {
  const r = rankCandidates(index, { nameBest: 'Charizard ex', nameAll: '', numbers: [{ prefix: '', num: 126, total: 197 }], setCodes: ['OBF'], codeCandidates: [] }, catalog.abbr);
  assert.equal(r[0].card.name, 'Charizard ex');
  assert.equal(r[0].set.id, 'sv03');
});

test('secret rare number above set size', () => {
  assert.equal(top({ nameBest: 'Charizard ex', numbers: [{ prefix: '', num: 223, total: 197 }] }), 'sv03-223');
});

test('trainer gallery prefix', () => {
  assert.equal(top({ nameBest: 'Pikachu', numbers: [{ prefix: 'TG', num: 5, total: 30 }] }), 'swsh9tg-TG05');
});

test('name only returns all printings', () => {
  const r = rankCandidates(index, { nameBest: 'Charizard ex', nameAll: '', numbers: [], setCodes: [], codeCandidates: [] }, catalog.abbr);
  assert.ok(r.filter((x) => x.card.name === 'Charizard ex').length >= 8);
  assert.notEqual(confidence(r), 'high');
});

test('confidence is high for a clean scan', () => {
  const r = rankCandidates(index, { nameBest: 'Charizard ex', nameAll: '', numbers: [{ prefix: '', num: 125, total: 197 }], setCodes: ['OBF'], codeCandidates: [] }, catalog.abbr);
  assert.equal(confidence(r), 'high');
});

test('manual search', () => {
  assert.equal(manualSearch(index, 'pika', '')[0].card.name, 'Pikachu');
  assert.deepEqual(manualSearch(index, 'charizard', '125/197').map((r) => r.card.id)[0], 'sv03-125');
  assert.ok(manualSearch(index, 'pokemon catcher', '').some((r) => r.card.id === 'me03-082'));
});

test('variant prices: holo-only modern card', () => {
  const rows = variantPrices(fx('card-sv03-125.json'));
  assert.equal(rows[0].label, 'Holo');
  assert.equal(rows[0].tcg.market, 5.28);
  assert.equal(rows.at(-1).size, 'jumbo');
  assert.ok(rows.some((r) => r.label === 'Holo Player Rewards Program stamp'));
  assert.deepEqual(headlinePrice(rows[0]), { value: 5.28, currency: 'USD', source: 'TCGplayer market' });
});

test('variant prices: normal vs reverse holo', () => {
  const rows = variantPrices(fx('card-sv03-001.json'));
  const normal = rows.find((r) => r.type === 'normal');
  const reverse = rows.find((r) => r.type === 'reverse');
  assert.equal(normal.tcg.market, 0.16);
  assert.equal(reverse.tcg.market, 0.23);
  assert.equal(reverse.cm.trend, 0.13);
  assert.equal(normal.cm.trend, 0.03);
});

test('variant prices: 1st edition / shadowless base set', () => {
  const card = fx('card-base1-4.json');
  const rows = variantPrices(card);
  assert.deepEqual(rows.map((r) => r.label), ['Holo', '1st Edition Shadowless Holo', 'Shadowless Holo', '1999 2000 Copyright Holo']);
  assert.equal(headlinePrice(rows[0]).value, 954.65);
  assert.deepEqual(headlinePrice(rows[1]), { value: 3330.71, currency: 'EUR', source: 'Cardmarket trend' });
  assert.equal(headlinePrice(rows[3]), null);
  assert.equal(searchQuery(card, rows[1]), 'Charizard 4/102 Base Set 1st Edition');
  const links = marketLinks(card, rows[0]);
  assert.equal(links.tcgplayer, 'https://www.tcgplayer.com/product/42382');
  assert.match(links.ebaySold, /LH_Sold=1/);
});

test('search query pads number like the card print', () => {
  const card = fx('card-sv03-001.json');
  assert.equal(searchQuery(card, variantPrices(card)[0]), 'Oddish 001/197 Obsidian Flames');
});
