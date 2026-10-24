// The backup file (js/backup.js): what Export backup writes and what Import backup accepts.
//   node --test tests/backup.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackup, readBackup, backupFileName, cardCount, BACKUP_APP } from '../js/backup.js';

const card = (over = {}) => ({
  id: 'sv03-125', name: 'Charizard ex', setId: 'sv03', setName: 'Obsidian Flames', number: '125/197', variant: 'Holo', variantId: 'holo',
  image: 'https://assets.tcgdex.net/en/sv/sv03/125/high.webp', fallbackImage: 'https://assets.tcgdex.net/en/sv/sv03/125/low.webp',
  price: { value: 5.28, currency: 'USD', source: 'TCGplayer market', converted: false }, qty: 2, added: 1761300000000, ...over,
});

test('a backup reads back as it was written', () => {
  const trade = { give: [card({ pricedAt: 1761300000001 })], get: [card({ id: 'base1-4', name: 'Charizard', qty: 1 })], rate: 90, rateSide: 'give' };
  const file = JSON.parse(JSON.stringify(makeBackup([card(), card({ id: 'me03-024', name: 'Aurorus', price: null, qty: 1 })], trade, new Date('2026-10-24T12:00:00Z'))));
  assert.equal(file.app, BACKUP_APP);
  assert.equal(file.version, 1);
  assert.equal(file.exported, '2026-10-24T12:00:00.000Z');
  const back = readBackup(file);
  assert.deepEqual(back.collection, file.collection);
  assert.deepEqual(back.trade, trade);
});

test('a converted (EUR) price keeps its original', () => {
  const price = { value: 33.6, currency: 'USD', source: 'Cardmarket trend', converted: true, original: { value: 30, currency: 'EUR' } };
  assert.deepEqual(readBackup(makeBackup([card({ price })], null)).collection[0].price, price);
});

test('files that are not backups are refused with a plain message', () => {
  for (const bad of [null, [], 'text', { collection: [] }, { app: 'other', collection: [] }, { app: BACKUP_APP }]) {
    assert.throws(() => readBackup(bad), /isn't a backup from this app/);
  }
  assert.throws(() => readBackup({ app: BACKUP_APP, version: 2, collection: [] }), /newer version of the app/);
});

test('only well-formed cards are kept, cleaned up', () => {
  const back = readBackup({
    app: BACKUP_APP,
    version: 1,
    collection: [
      card({ qty: 0, image: 'javascript:alert(1)', extra: 'dropped', price: { value: 'x' } }),
      card({ qty: 1e9, name: 'N'.repeat(1000) }),
      { name: 'no id' },
      { id: 'x-1' }, // no name
      null,
      'card',
    ],
    trade: { give: [{ id: 5 }], get: [], rate: 'high', rateSide: 'nonsense' },
  });
  assert.equal(back.collection.length, 2);
  const [a, b] = back.collection;
  assert.equal(a.qty, 1);
  assert.equal(a.image, '');
  assert.equal(a.price, null);
  assert.equal(a.extra, undefined);
  assert.equal(b.qty, 9999);
  assert.equal(b.name.length, 120);
  assert.equal(back.trade, null, 'a trade with no valid card is left out');
});

test('file name and card counts', () => {
  assert.match(backupFileName(new Date(2026, 9, 24, 23, 30)), /^pokemon-cards-backup-2026-10-24\.json$/);
  assert.equal(cardCount([card({ qty: 1 })]), '1 card');
  assert.equal(cardCount([card({ qty: 2 }), card({ qty: undefined })]), '3 cards');
  assert.equal(cardCount([]), '0 cards');
});
