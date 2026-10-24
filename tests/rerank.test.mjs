// Second ranking pass (js/rerank.js): text fingerprint of card details, border and era hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, rankCandidates, confidence, reprintRivals } from '../js/match.js';
import {
  rerank,
  lookupIds,
  readFeatures,
  phraseScore,
  cardDetails,
  detailScore,
  hintScore,
  borderClass,
  copyrightYear,
  setYears,
  isSpecialSet,
  W,
} from '../js/rerank.js';

// A small catalog in release order: Charizard printings that read alike.
const sets = [
  { id: 'base1', name: 'Base Set', cardCount: { total: 102, official: 102 } },
  { id: 'base4', name: 'Base Set 2', cardCount: { total: 130, official: 130 } },
  { id: 'basep', name: 'Wizards Black Star Promos', cardCount: { total: 53, official: 53 } },
  { id: 'swsh9', name: 'Brilliant Stars', cardCount: { total: 186, official: 172 } },
  { id: 'cel25cc', name: 'Celebrations: Classic Collection', cardCount: { total: 25, official: 25 } },
  { id: 'sv01', name: 'Scarlet & Violet', cardCount: { total: 258, official: 198 } },
  { id: 'sv03', name: 'Obsidian Flames', cardCount: { total: 230, official: 197 } },
  { id: 'sv03.5', name: '151', cardCount: { total: 207, official: 165 } },
  { id: '30th-c', name: '30th Classic Collection', cardCount: { total: 30, official: 0 } },
];
const cards = [
  { id: 'base1-4', localId: '4', name: 'Charizard' },
  { id: 'base4-4', localId: '4', name: 'Charizard' },
  { id: 'basep-1', localId: '1', name: 'Pikachu' },
  { id: 'base1-58', localId: '58', name: 'Pikachu' },
  { id: 'swsh9-18', localId: '018', name: 'Charizard V' },
  { id: 'cel25cc-CC002', localId: 'CC002', name: 'Charizard' },
  { id: 'sv03-125', localId: '125', name: 'Charizard ex' },
  { id: 'sv03.5-006', localId: '006', name: 'Charizard ex' },
  { id: 'sv03.5-199', localId: '199', name: 'Charizard ex' },
  { id: '30th-c-001', localId: '001', name: 'Charizard' },
];
const index = buildIndex(cards, sets);

// Details as the catalog snapshot has them (attack names only)…
const vintage = { hp: 120, stage: 'Stage2', attacks: ['Fire Spin'], abilities: ['Energy Burn'], illustrator: 'Mitsuhiro Arita', rarity: 'Rare', regulationMark: null };
const sv151 = { hp: 330, stage: 'Stage2', attacks: ['Brave Wing', 'Explosive Vortex'], abilities: [], illustrator: 'PLANETA Mochizuki', rarity: 'Double rare', regulationMark: 'G' };
const details = {
  'base1-4': vintage,
  'base4-4': vintage,
  'cel25cc-CC002': { ...vintage, rarity: 'Classic Collection' },
  '30th-c-001': vintage,
  'swsh9-18': { hp: 220, stage: 'Basic', attacks: ['Claw Slash', 'Fire Spin'], abilities: [], illustrator: '5ban Graphics', rarity: 'Holo Rare V', regulationMark: 'F' },
  'sv03-125': { hp: 330, stage: 'Stage2', attacks: ['Burning Darkness'], abilities: ['Infernal Reign'], illustrator: 'PLANETA Mochizuki', rarity: 'Double rare', regulationMark: 'G' },
  'sv03.5-006': sv151,
  'sv03.5-199': { ...sv151, illustrator: 'miki kudo', rarity: 'Special illustration rare' },
};
// …and as the TCGdex API sends them (api.getCard).
const apiCard = (id) => {
  const d = details[id];
  return d && { id, ...d, attacks: d.attacks.map((name) => ({ name, cost: ['Fire'], damage: 100 })), abilities: d.abilities.map((name) => ({ type: 'Pokemon Power', name })) };
};

const clues = (o = {}) => ({ nameBest: '', nameAll: '', numbers: [], setCodes: [], codeCandidates: [], artText: '', ...o });
const first = (c) => rankCandidates(index, c, {}, 150);
const ids = (ranked) => ranked.map((r) => r.card.id);
const YELLOW = [188, 156, 87];
const SILVER = [130, 126, 114];

// A Base Set Charizard read without its number (it often isn't): name, HP, Pokémon Power,
// attack, illustrator and copyright are what tells the printing.
const baseRead = {
  clues: clues({ nameBest: 'Charizard', nameAll: 'Charizard' }),
  debug: {
    name: 'Evolves from Charmeleon Put Charizard\n\nCharizard\n\n120 HP',
    bottom: 'unintentionally cause forest fires. LV.76 #6\nIllus. Mitsuhiro Arita ©1995, 96, 98 Nintendo, Creatures, GAMEFREAK. ©1999 Wizards.',
    full: 'Pokémon Power: Energy Burn As often as you like during your turn\nFire Spin Discard 2 Energy cards attached to Charizard 100',
    art: '',
  },
  border: YELLOW,
};
// A 151 Charizard ex read as "Charizard" (the "ex" logo is often lost).
const exRead = (illus) => ({
  clues: clues({ nameBest: 'Charizard', nameAll: 'Charizard' }),
  debug: {
    name: 'Stage 2 Evolves from Charmeleon\nCharizard HP 330',
    bottom: `Pokémon ex rule When your Pokémon ex is Knocked Out, your opponent takes 2 Prize cards.\nIllus. ${illus}`,
    full: 'Brave Wing 60+ Explosive Vortex 330',
    art: '',
  },
  border: SILVER,
});

test('border colour: yellow, silver, or unknown', () => {
  assert.equal(borderClass(YELLOW), 'yellow');
  assert.equal(borderClass([144, 111, 26]), 'yellow');
  assert.equal(borderClass(SILVER), 'silver');
  assert.equal(borderClass([212, 212, 214]), 'silver');
  assert.equal(borderClass([69, 160, 208]), null); // blue sleeve
  assert.equal(borderClass([44, 44, 39]), null); // too dark to tell
  assert.equal(borderClass(null), null);
});

test('copyright year: the latest year of the copyright line', () => {
  assert.equal(copyrightYear('Illus. Mitsuhiro Arita ©1995, 96, 98 Nintendo, Creatures, GAMEFREAK. ©1999 Wizards.'), 1999);
  assert.equal(copyrightYear('©1995, 96, 98 Nintendo, Creatures,'), 1998);
  assert.equal(copyrightYear('©1995-2000 Nintendo, Creatures, GAMEFREAK'), 2000);
  assert.equal(copyrightYear('©2023 Pokémon / Nintendo / Creatures / GAME FREAK'), 2023);
  assert.equal(copyrightYear('Arita ©1595, 96, 98 Nintendo'), null); // misread year
  assert.equal(copyrightYear('G OBF EN 125/197\nIllus. 5ban Graphics'), null);
});

test('set years follow release order; promos and reprint collections span years', () => {
  const y = setYears(index);
  assert.deepEqual(y.get('base1'), [1999, 1999]);
  assert.deepEqual(y.get('base4'), [2000, 2000]);
  assert.deepEqual(y.get('basep'), [1999, 2003]);
  assert.deepEqual(y.get('sv03.5'), [2023, 2023]);
  assert.deepEqual(y.get('30th-c'), [1999, 2026]);
});

test('read features: HP, rule box, era wording, regulation mark', () => {
  const f = readFeatures(baseRead);
  assert.ok(f.hpExact.has(120));
  assert.equal(f.year, 1999);
  assert.equal(f.border, 'yellow');
  assert.ok(f.eras.length >= 2); // "Wizards", "Pokémon Power", "LV.76 #6"
  const g = readFeatures(exRead('miki kudo'));
  assert.ok(g.hpExact.has(330));
  assert.ok(g.marks.has('ex'));
  assert.equal(g.prizes, 2);
  // A lost digit is no HP ("33" for 330) and is kept as a partial read.
  const h = readFeatures({ clues: clues(), debug: { name: 'Charizard 33 HP\nG MEW EN' } });
  assert.equal(h.hpExact.size, 0);
  assert.ok(h.hpPart.has('33'));
  assert.equal(readFeatures({ clues: clues(), debug: { bottom: 'G MEW EN 199/165' } }).regMark, 'G');
  assert.ok(readFeatures({ clues: clues(), debug: { full: 'TAG TEAM rule When your TAG TEAM is Knocked Out' } }).marks.has('&'));
});

test('phrases are found despite OCR noise, short ones only exactly', () => {
  const f = readFeatures({ clues: clues(), debug: { full: 'okémon Power: Energy Bum As often\ne) ry) Fire Spin Discard 2', bottom: 'lus, Mitsuhiro Arita ©1995' } });
  assert.equal(phraseScore(f, 'Fire Spin'), 1);
  assert.ok(phraseScore(f, 'Energy Burn') >= 0.8);
  assert.ok(phraseScore(f, 'Mitsuhiro Arita') >= 0.9);
  assert.ok(phraseScore(f, 'Explosive Vortex') < W.phraseMin);
  assert.equal(phraseScore(f, 'Fire'), 1);
  assert.equal(phraseScore(f, 'Fira'), 0); // short ones must be exact
  assert.equal(phraseScore(f, 'Spi'), 0); // too short to tell
});

test('card details: API card and catalog snapshot give the same features', () => {
  assert.deepEqual(cardDetails(apiCard('sv03.5-006')), cardDetails(details['sv03.5-006']));
  assert.deepEqual(cardDetails(details['base1-4']).abilities, ['Energy Burn']);
  assert.equal(cardDetails({ illustrator: 'null', rarity: 'None' }).illustrator, '');
  assert.equal(cardDetails(null), null);
});

test('the printing whose HP and attacks were read scores higher', () => {
  const f = readFeatures(baseRead);
  const base = detailScore(f, cardDetails(details['base1-4']));
  const v = detailScore(f, cardDetails(details['swsh9-18']));
  const ex = detailScore(f, cardDetails(details['sv03.5-006']), true);
  assert.ok(base.score > v.score, `${base.score} > ${v.score}`);
  assert.ok(v.score > ex.score);
  assert.ok(base.reasons.includes('Fire Spin') && base.reasons.includes('Energy Burn'));
  assert.ok(base.reasons.includes('HP 120'));
});

test('hints: yellow border and old copyright rule out Scarlet & Violet, not its classic reprints', () => {
  const f = readFeatures(baseRead);
  const card = (id) => index.entries.find((e) => e.id === id);
  assert.ok(hintScore(f, card('base1-4'), index).score > hintScore(f, card('sv03.5-006'), index).score);
  assert.ok(hintScore(f, card('30th-c-001'), index).score > hintScore(f, card('sv03.5-006'), index).score);
  // The rule box says the name has the "ex" mark.
  const g = readFeatures(exRead(''));
  assert.ok(hintScore(g, card('sv03.5-006'), index).score > hintScore(g, card('base1-4'), index).score);
});

test('vintage card without its number: the original printing wins', async () => {
  const ranked = await rerank(first(baseRead.clues), baseRead, { index, getCard: (id) => details[id] });
  assert.equal(ranked[0].card.id, 'base1-4');
  // Reprints with the same text follow; Scarlet & Violet cards are far behind.
  assert.ok(ids(ranked).indexOf('base1-4') < ids(ranked).indexOf('cel25cc-CC002'));
  assert.ok(ids(ranked).indexOf('cel25cc-CC002') < ids(ranked).indexOf('sv03.5-006'));
  assert.ok(ranked[0].score > ranked[0].base);
});

test('"ex" lost from the name: rule box, HP and attacks pick the 151 card; the illustrator the version', async () => {
  const getCard = (id) => Promise.resolve(apiCard(id));
  const a = await rerank(first(exRead('PLANETA Mochizuki').clues), exRead('PLANETA Mochizuki'), { index, getCard });
  assert.equal(a[0].card.id, 'sv03.5-006');
  const b = await rerank(first(exRead('miki kudo').clues), exRead('miki kudo'), { index, getCard });
  assert.equal(b[0].card.id, 'sv03.5-199');
});

test('offline: no details, the hints alone still order the printings', async () => {
  const ranked = await rerank(first(baseRead.clues), baseRead, { index });
  assert.equal(ranked[0].card.id, 'base1-4');
  const ex = await rerank(first(exRead('').clues), exRead(''), { index });
  assert.equal(ex[0].card.name, 'Charizard ex');
});

test('details that fail or come too late are skipped', async () => {
  const failing = await rerank(first(baseRead.clues), baseRead, { index, getCard: () => Promise.reject(new Error('offline')) });
  assert.equal(failing[0].card.id, 'base1-4');
  const t0 = Date.now();
  const hanging = await rerank(first(exRead('miki kudo').clues), exRead('miki kudo'), { index, getCard: () => new Promise(() => {}), timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(hanging[0].card.name, 'Charizard ex');
  // Only what came in time counts, and a card whose details came can't jump ahead of one
  // whose details didn't: the order stays as without details.
  const read = exRead('miki kudo');
  const offline = await rerank(first(read.clues), read, { index });
  const some = await rerank(first(read.clues), read, {
    index,
    getCard: (id) => (id === 'sv03.5-199' ? apiCard(id) : new Promise(() => {})),
    timeoutMs: 50,
  });
  assert.deepEqual(ids(some), ids(offline));
  assert.ok(some.find((r) => r.card.id === 'sv03.5-199').reasons.includes('illus. miki kudo'));
  assert.ok(some.find((r) => r.card.id === 'sv03.5-006').unchecked);
});

test('details that come only partly: never worse than none, and never "high"', async () => {
  // Base Charizard read without its number: base1-4 is right without details. Only the
  // Base Set 2 copy's details come (same text); before, that alone put it on top.
  const offline = await rerank(first(baseRead.clues), baseRead, { index });
  const some = await rerank(first(baseRead.clues), baseRead, { index, getCard: (id) => (id === 'base4-4' ? details[id] : Promise.reject(new Error('offline'))) });
  assert.equal(offline[0].card.id, 'base1-4');
  assert.equal(some[0].card.id, 'base1-4');
  assert.ok(some[0].unchecked && some[0].hinted === offline[0].score);
  assert.notEqual(confidence(some), 'high');
  // The ones whose details came are still put in order among themselves.
  const read = exRead('miki kudo');
  const two = await rerank(first(read.clues), read, { index, getCard: (id) => (id.startsWith('sv03.5') ? apiCard(id) : Promise.reject(new Error('offline'))) });
  const order = ids(two);
  assert.ok(order.indexOf('sv03.5-199') < order.indexOf('sv03.5-006'));
  // Everything came: the details decide.
  const all = await rerank(first(read.clues), read, { index, getCard: (id) => apiCard(id) });
  assert.equal(all[0].card.id, 'sv03.5-199');
});

test('confidence with partly-arrived details: "high" only if just as clear without them', () => {
  const card = (id) => ({ card: index.entries.find((e) => e.id === id), set: {} });
  const clear = [{ ...card('sv03-125'), score: 13, hinted: 11 }, { ...card('sv03.5-006'), score: 9, hinted: 9, unchecked: true }];
  assert.equal(confidence(clear), 'high');
  const unclear = [{ ...card('sv03-125'), score: 13, hinted: 10 }, { ...card('sv03.5-006'), score: 9, hinted: 9.5, unchecked: true }];
  assert.equal(confidence(unclear), 'medium');
  // All details came: the scores alone count.
  assert.equal(confidence(unclear.map(({ unchecked, ...r }) => r)), 'high');
});

test('reprint collections print the original number: found by it, ranked after the original, never a silent pick', async () => {
  const cc = index.entries.find((e) => e.id === 'cel25cc-CC002');
  assert.equal(cc.reprintOf, 'base1-4');
  assert.deepEqual(cc.printed, { prefix: '', num: 4, total: 102, setId: 'base1' });
  // "4/102" read: both reprints score like the original; the original comes first.
  const read = { ...baseRead, clues: clues({ nameBest: 'Charizard', numbers: [{ prefix: '', num: 4, total: 102 }] }) };
  read.debug = { ...read.debug, bottom: 'Illus. Mitsuhiro Arita ©1995, 96, 98 Nintendo, Creatures, GAMEFREAK. 4/102' };
  const firstPass = first(read.clues);
  const score = (list, id) => list.find((r) => r.card.id === id).score;
  assert.equal(score(firstPass, 'cel25cc-CC002'), score(firstPass, 'base1-4'));
  assert.equal(firstPass[0].card.id, 'base1-4');
  const ranked = await rerank(firstPass, read, { index, getCard: (id) => details[id] });
  assert.equal(ranked[0].card.id, 'base1-4');
  assert.deepEqual(reprintRivals(ranked).map((r) => r.card.id).sort(), ['30th-c-001', 'cel25cc-CC002']);
  assert.equal(confidence(ranked), 'medium');
  // Shown the reprint, the original is its rival.
  const flipped = [ranked.find((r) => r.card.id === 'cel25cc-CC002'), ...ranked.filter((r) => r.card.id !== 'cel25cc-CC002')];
  assert.deepEqual(reprintRivals(flipped).map((r) => r.card.id).sort(), ['30th-c-001', 'base1-4']);
  // Only the reprint's own number typed in full finds it by number; a lone "1" doesn't.
  assert.equal(first(clues({ numbers: [{ prefix: 'CC', num: 2, total: null }] }))[0].card.id, 'cel25cc-CC002');
  assert.ok(!first(clues({ numbers: [{ prefix: '', num: 1, total: null }] })).some((r) => r.card.id === '30th-c-001'));
});

test('"Wizards" in the copyright line rules the reprints out', async () => {
  const read = { ...baseRead, clues: clues({ nameBest: 'Charizard', numbers: [{ prefix: '', num: 4, total: 102 }] }) };
  assert.ok(readFeatures(read).wizards);
  assert.ok(readFeatures({ clues: clues(), debug: { bottom: 'GAMEFREAK O19 Wiards. 4/102' } }).wizards);
  assert.ok(!readFeatures({ clues: clues(), debug: { bottom: 'GAMEFREAK. 4/102 wards' } }).wizards);
  const ranked = await rerank(first(read.clues), read, { index, getCard: (id) => details[id] });
  assert.equal(ranked[0].card.id, 'base1-4');
  assert.deepEqual(reprintRivals(ranked), []);
  assert.equal(confidence(ranked), 'high');
});

test('only the best few are looked up', () => {
  const asked = lookupIds(first(exRead('').clues), exRead(''), { index, fetch: 3 });
  assert.ok(asked.length >= 1 && asked.length <= 3);
  // Candidates far behind the best are not worth a download.
  const r = first(clues({ nameBest: 'Charizard ex', numbers: [{ prefix: '', num: 125, total: 197 }], setCodes: ['OBF'] }));
  const few = lookupIds(r, { clues: clues(), debug: {} }, { index });
  assert.deepEqual(few, ['sv03-125']);
  assert.deepEqual(lookupIds([], baseRead, { index }), []);
});

test('ties: main expansion first, then the original printing, then the regular number', async () => {
  assert.ok(isSpecialSet('basep') && isSpecialSet('cel25cc') && isSpecialSet('swsh9tg') && isSpecialSet('2021swsh'));
  assert.ok(!isSpecialSet('base1') && !isSpecialSet('sv03.5') && !isSpecialSet('swsh9'));
  const bare = { clues: clues({ nameBest: 'Pikachu' }), debug: {} };
  const p = await rerank(first(bare.clues), bare, { index });
  assert.deepEqual(ids(p).slice(0, 2), ['base1-58', 'basep-1']);
  const c = { clues: clues({ nameBest: 'Charizard ex' }), debug: {}, border: SILVER };
  const ranked = await rerank(first(c.clues), c, { index });
  assert.deepEqual(ids(ranked).slice(0, 3), ['sv03-125', 'sv03.5-006', 'sv03.5-199']);
});
