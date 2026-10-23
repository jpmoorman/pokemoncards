import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBottomText, pickName, cleanNameLine } from '../js/parse.js';
import { buildIndex, rankCandidates, partialSimilarity, parseLocalId, manualSearch, confidence } from '../js/match.js';
import { variantPrices, headlinePrice, marketLinks, searchQuery, printedNumber, variantImage, eurToUsd, priceInUsd, variantLabel } from '../js/prices.js';

const fx = (f) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const catalog = fx('catalog.json');
const index = buildIndex(catalog.cards, catalog.sets);
const num = (n) => n && { prefix: n.prefix, num: n.num, total: n.total };
const top = (clues) => rankCandidates(index, { nameBest: '', nameAll: '', numbers: [], setCodes: [], codeCandidates: [], ...clues }, catalog.abbr)[0]?.card.id;

test('number keeps printed zeros', () => {
  assert.equal(parseBottomText('POR EN 024/088').numbers[0].text, '024/088');
  assert.equal(parseBottomText('4/102').numbers[0].text, '4/102');
  assert.equal(parseBottomText('TG05/TG30').numbers[0].text, 'TG05/TG30');
});

test('parses modern bottom line with set code', () => {
  const r = parseBottomText('G OBF EN 125/197 ★\nIllus. 5ban Graphics');
  assert.deepEqual(num(r.numbers[0]), { prefix: '', num: 125, total: 197 });
  assert.deepEqual(r.setCodes, ['OBF']);
});

test('parses vintage number and OCR digit confusions', () => {
  assert.deepEqual(num(parseBottomText('Illus. Mitsuhiro Arita  4/102 ●').numbers[0]), { prefix: '', num: 4, total: 102 });
  assert.deepEqual(num(parseBottomText('l25/I97').numbers[0]), { prefix: '', num: 125, total: 197 });
  assert.deepEqual(num(parseBottomText('125 / 197').numbers[0]), { prefix: '', num: 125, total: 197 });
});

test('ignores copyright years and attack text', () => {
  const r = parseBottomText('©2023 Pokémon/Nintendo/Creatures/GAME FREAK weakness ×2 resistance -30 retreat');
  assert.equal(r.numbers.length, 0);
});

test('parses trainer gallery and promo numbers', () => {
  assert.deepEqual(num(parseBottomText('TG05/TG30').numbers[0]), { prefix: 'TG', num: 5, total: 30 });
  assert.deepEqual(num(parseBottomText('SWSH050').numbers[0]), { prefix: 'SWSH', num: 50, total: null });
});

test('cleans name lines', () => {
  assert.equal(cleanNameLine('STAGE 2 Charizard ex HP330'), 'Charizard ex');
  assert.equal(cleanNameLine('Charizard 120 HP'), 'Charizard');
  assert.equal(cleanNameLine('TRAINER'), '');
  assert.equal(cleanNameLine('Evolves from Charmeleon'), '');
  assert.equal(cleanNameLine('Item Finder'), 'Item Finder');
  const n = pickName([{ text: 'STAGE2', height: 20 }, { text: 'Charizard ex HP 330', height: 60 }, { text: 'Evolves from Charmeleon', height: 14 }]);
  assert.equal(n.best, 'Charizard ex');
  // Artwork junk read as big letters loses to the real name.
  assert.equal(pickName([{ text: 'Mewtwo ex', height: 50, conf: 92 }, { text: 'EE 2 a', height: 70, conf: 40 }]).best, 'Mewtwo ex');
  assert.equal(pickName([{ text: 'Mewtwo ex', height: 50, conf: 92 }, { text: 'Wo ae', height: 80, conf: 35 }]).best, 'Mewtwo ex');
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
  assert.ok(rows.some((r) => r.label === 'Holo Play! Pokémon Stamp'));
  assert.deepEqual(headlinePrice(rows[0], 1.12), { value: 5.28, currency: 'USD', source: 'TCGplayer market', converted: false });
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
  assert.equal(headlinePrice(rows[0], 1.12).value, 954.65);
  // Cardmarket-only versions are converted to USD.
  assert.deepEqual(headlinePrice(rows[1], 1.12), { value: 3730.4, currency: 'USD', source: 'Cardmarket trend', converted: true, original: { value: 3330.71, currency: 'EUR' } });
  assert.equal(headlinePrice(rows[3], 1.12), null);
  assert.equal(searchQuery(card, rows[1]), 'Charizard 4/102 Base Set 1st Edition');
  const links = marketLinks(card, rows[0]);
  assert.equal(links.tcgplayer, 'https://www.tcgplayer.com/product/42382');
  assert.match(links.ebaySold, /LH_Sold=1/);
});

test('search query pads number like the card print', () => {
  const card = fx('card-sv03-001.json');
  assert.equal(searchQuery(card, variantPrices(card)[0]), 'Oddish 001/197 Obsidian Flames');
});

test('30th Celebration: digit set code, OCR O/0 mix-up', () => {
  const r = parseBottomText('I 30C EN 157/128 ★');
  assert.deepEqual(r.setCodes, ['30C']);
  assert.deepEqual(num(r.numbers[0]), { prefix: '', num: 157, total: 128 });
  assert.equal(top({ nameBest: 'Mewtwo ex', numbers: [{ prefix: '', num: 157, total: 128 }], setCodes: ['3OC'] }), '30th-157');
  assert.equal(top({ numbers: [{ prefix: '', num: 157, total: null }], setCodes: ['30C'] }), '30th-157');
});

test('newest Mega Evolution sets match by code', () => {
  assert.equal(top({ numbers: [{ prefix: '', num: 120, total: 84 }], setCodes: ['PBL'] }), 'me05-120');
  assert.equal(top({ numbers: [{ prefix: '', num: 122, total: 86 }], setCodes: ['CRI'] }), 'me04-122');
});

test('brand-new card without prices yet', () => {
  const rows = variantPrices(fx('card-30th-157.json'));
  assert.equal(rows.length, 1);
  assert.equal(headlinePrice(rows[0]), null);
  assert.match(marketLinks(fx('card-30th-157.json'), rows[0]).ebaySold, /Mewtwo%20ex%20157%2F128%2030th%20Celebration/);
});

test('Perfect Order Aurorus: stamped and cosmos versions', () => {
  const card = fx('card-me03-024.json');
  const rows = variantPrices(card);
  assert.deepEqual(rows.map((r) => r.label), ['Holo', 'Reverse Holo', 'Set Logo Stamp', 'Cosmos Holo']);
  assert.equal(headlinePrice(rows[0], 1.12).value, 0.15);
  assert.equal(headlinePrice(rows[1], 1.12).value, 0.24);
  assert.equal(headlinePrice(rows[2], 1.12).value, 32.04); // €28.61 trend
  assert.equal(headlinePrice(rows[3], 1.12).value, 28); // €25 trend
  // Each version shows its own marketplace photo.
  assert.equal(variantImage(card, rows[2]).src, 'https://tcgplayer-cdn.tcgplayer.com/product/685559_in_1000x1000.jpg');
  assert.equal(variantImage(card, rows[3]).src, 'https://tcgplayer-cdn.tcgplayer.com/product/709694_in_1000x1000.jpg');
  assert.equal(variantImage(card, { tcgProductId: null }).src, 'https://assets.tcgdex.net/en/me/me03/024/high.webp');
  assert.equal(searchQuery(card, rows[2]), 'Aurorus 024/088 Perfect Order Stamped');
  assert.equal(marketLinks(card, rows[2]).tcgplayer, 'https://www.tcgplayer.com/product/685559');
});

test('printed number matches the card', () => {
  assert.equal(printedNumber(fx('card-me03-024.json')), '024/088');
  assert.equal(printedNumber(fx('card-base1-4.json')), '4/102');
  assert.equal(printedNumber({ localId: 'TG05', official: 30 }), 'TG05');
  assert.equal(printedNumber({ localId: '157', set: { cardCount: { official: 128 } } }), '157/128');
});

test('currency helpers', () => {
  assert.equal(eurToUsd(25, 1.12), 28);
  assert.equal(priceInUsd({ value: 10, currency: 'EUR' }, 1.1), 11);
  assert.equal(priceInUsd({ value: 10, currency: 'USD' }, 1.1), 10);
  assert.equal(priceInUsd(null), null);
  assert.equal(variantLabel({ type: 'normal', stamp: ['prerelease'] }), 'Prerelease Stamp');
  assert.equal(variantLabel({ type: 'holo', stamp: ['set-logo'] }), 'Holo Set Logo Stamp');
});

test('explicit set choice limits results', () => {
  const r = rankCandidates(index, { nameBest: 'Charizard ex', nameAll: '', numbers: [], setCodes: [], codeCandidates: [], setIds: ['sv03.5'] }, catalog.abbr);
  assert.ok(r.length >= 2 && r.every((x) => x.card.setId === 'sv03.5'));
  const all = rankCandidates(index, { nameBest: '', nameAll: '', numbers: [], setCodes: [], codeCandidates: [], setIds: ['me03'] }, catalog.abbr);
  assert.equal(all[0].card.id, 'me03-012');
  assert.ok(all.every((x) => x.card.setId === 'me03'));
  assert.equal(manualSearch(index, '', '24', catalog.abbr, 'me03')[0].card.id, 'me03-024');
});

test('Aurorus from the real photo clues', () => {
  assert.equal(top({ nameBest: 'Aurorus', numbers: [{ prefix: '', num: 24, total: 88 }], setCodes: ['POR'] }), 'me03-024');
  // "024/O88" style misread still works through digit fixing.
  assert.deepEqual(num(parseBottomText('J POR EN 024/O88 ★').numbers[0]), { prefix: '', num: 24, total: 88 });
});

test('card details: callers asking at once share one download', async () => {
  // No IndexedDB in Node: api.js runs without its on-device copy.
  const { getCard } = await import('../js/api.js');
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    await new Promise((r) => setTimeout(r, 30));
    return new Response(JSON.stringify({ id: 'xx1-7', name: 'Test card' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    // identify() starts the download for its best match; the result sheet then asks too.
    const [a, b] = await Promise.all([getCard('xx1-7'), getCard('xx1-7')]);
    assert.equal(asked.length, 1);
    assert.equal(a.name, 'Test card');
    assert.equal(b, a);
    // Done downloading: kept, and Refresh prices downloads again.
    assert.equal(await getCard('xx1-7'), a);
    await getCard('xx1-7', { fresh: true });
    assert.equal(asked.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
