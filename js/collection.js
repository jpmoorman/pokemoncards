// "Collection" tab: saved cards with a running USD total, price refresh, CSV export, and the
// backup file (Export backup / Import backup) with its Home Screen tips (see backup.js).
import { $, el, on, toast, actionToast, confirmDialog, navigate } from './ui.js';
import { formatMoney } from './prices.js';
import { entryKey, refreshEntry, totalUsd, unitUsd, entryNumber } from './entry.js';
import { getCard, cardFetchedAt } from './api.js';
import { entryRow } from './components.js';
import { openCard } from './sheet.js';
import { appMode, persistStorage, savedTrade, restoreTrade, makeBackup, readBackup, backupFileName, cardCount } from './backup.js';

const KEY = 'collection.v1';
const TIP_KEY = 'tip.homeScreen'; // 'done': the Add to Home Screen tip was dismissed (or a backup exported)
const OFFER_KEY = 'tip.importOffer'; // 'done': the Home Screen app offered the import once

export function loadCollection() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || [];
  } catch {
    return [];
  }
}

function save(items) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    toast('Could not save — phone storage is full');
  }
  renderCount(items);
}

/** Add an entry (merges with an identical card+version by bumping qty). */
export function addToCollection(entry) {
  const items = loadCollection();
  const existing = items.find((i) => entryKey(i) === entryKey(entry));
  if (existing) {
    existing.qty = (existing.qty || 1) + (entry.qty || 1);
    existing.price = entry.price || existing.price;
  } else {
    items.unshift({ ...entry, key: entryKey(entry) });
  }
  save(items);
  if ($('#view-collection').classList.contains('active')) renderCollection();
}

function renderCount(items = loadCollection()) {
  const n = items.reduce((s, i) => s + (i.qty || 1), 0);
  const b = $('#collection-count');
  b.hidden = !n;
  b.textContent = n;
}

export function renderCollection() {
  const items = loadCollection();
  renderCount(items);
  renderTips(items);
  $('#collection-total').textContent = formatMoney(totalUsd(items));
  $('#collection-empty').hidden = !!items.length;
  $('#collection-list').replaceChildren(
    ...items.map((i) =>
      entryRow(i, {
        onOpen: () => openCard(i.id, { preferred: i.variantId || i.variant }),
        onQty: (d) => {
          const all = loadCollection();
          const it = all.find((x) => entryKey(x) === entryKey(i));
          if (!it) return;
          it.qty = (it.qty || 1) + d;
          save(it.qty > 0 ? all : all.filter((x) => x !== it));
          renderCollection();
        },
      }),
    ),
  );
}

export function initCollection() {
  on('card:action', ({ action, entry }) => {
    if (action === 'collection') addToCollection(entry);
  });
  on('fx:ready', () => renderCollection());

  $('#btn-refresh-prices').addEventListener('click', async () => {
    const items = loadCollection();
    if (!items.length) return;
    const btn = $('#btn-refresh-prices');
    btn.disabled = true;
    // Download every card again (once per card), even one looked up minutes ago.
    const started = Date.now();
    const ids = [...new Set(items.map((i) => i.id))];
    for (const [n, id] of ids.entries()) {
      btn.textContent = `Refreshing ${n + 1}/${ids.length}…`;
      await getCard(id, { fresh: true }).catch(() => null);
    }
    // Cards that couldn't be downloaded keep the price they have.
    const prices = new Map();
    for (const i of items) if (cardFetchedAt(i.id) >= started) prices.set(entryKey(i), (await refreshEntry(i)).price);
    // Cards may have been added or changed meanwhile (Batch, a scan, −/+): only update prices.
    const all = loadCollection();
    for (const it of all) if (prices.has(entryKey(it))) it.price = prices.get(entryKey(it));
    save(all);
    renderCollection();
    btn.disabled = false;
    btn.textContent = 'Refresh prices';
    const done = items.filter((i) => prices.has(entryKey(i))).length;
    if (done === items.length) toast('Prices updated');
    else if (done) toast(`Updated ${done} of ${items.length} cards — couldn't reach the price server for the rest`, 4000);
    else toast("Couldn't reach the price server — prices not updated", 4000);
  });

  $('#btn-export').addEventListener('click', () => {
    const items = loadCollection();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Name', 'Set', 'Number', 'Version', 'Qty', 'Unit price (USD)', 'Total (USD)', 'Price source', 'TCGdex id'].map(esc).join(','),
      ...items.map((i) => {
        const unit = unitUsd(i);
        return [i.name, i.setName, entryNumber(i), i.variant, i.qty, unit ?? '', unit != null ? (unit * i.qty).toFixed(2) : '', i.price?.source ?? '', i.id]
          .map(esc)
          .join(',');
      }),
    ];
    download(new Blob([lines.join('\n')], { type: 'text/csv' }), 'pokemon-collection.csv');
  });

  $('#btn-backup-export').addEventListener('click', exportBackup);
  $('#btn-backup-import').addEventListener('click', () => $('#backup-file').click());
  $('#backup-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) importBackup(file);
  });
  $('#tip-home-screen-ok').addEventListener('click', () => {
    remember(TIP_KEY);
    renderTips();
  });

  $('#btn-clear-collection')?.addEventListener('click', async () => {
    if (!loadCollection().length) return;
    if (await confirmDialog('Remove every card from your collection?', 'Remove all')) {
      save([]);
      renderCollection();
    }
  });

  renderCount();

  // Ask the browser to keep the saved cards (when there are some: Firefox would ask the user).
  if (loadCollection().length || savedTrade()) persistStorage();
  on('card:action', ({ action }) => action === 'collection' && persistStorage());
  offerImport();
}

function download(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------------- backup file ----------------

const seen = (key) => {
  try {
    return localStorage.getItem(key) === 'done';
  } catch {
    return true; // no storage: no tips either
  }
};
const remember = (key) => {
  try {
    localStorage.setItem(key, 'done');
  } catch {
    /* storage full */
  }
};

async function exportBackup() {
  const items = loadCollection();
  const trade = savedTrade();
  if (!items.length && !trade) {
    toast('Nothing saved yet');
    return;
  }
  const name = backupFileName();
  const file = new File([JSON.stringify(makeBackup(items, trade), null, 1)], name, { type: 'application/json' });
  remember(TIP_KEY); // the tip's advice was taken
  renderTips(items);
  // A Home Screen app on iPhone can't always save a download: the share sheet has "Save to Files".
  if (appMode().standalone && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Card Scanner backup' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // closed the share sheet
    }
  }
  download(file, name);
}

async function importBackup(file) {
  let data;
  try {
    data = readBackup(JSON.parse(await file.text()));
  } catch (e) {
    toast(e instanceof SyntaxError ? "That file isn't a backup from this app." : e.message, 4500);
    return;
  }
  const items = loadCollection();
  const trade = savedTrade();
  const takesTrade = !!data.trade;
  if (!data.collection.length && !takesTrade) {
    toast('That backup has no saved cards.', 4000);
    return;
  }
  // Anything saved here is replaced (not merged): ask first.
  const replaces = [items.length && `the ${cardCount(items)} saved here`, takesTrade && trade && 'your current trade'].filter(Boolean);
  if (replaces.length) {
    const what = [data.collection.length && cardCount(data.collection), takesTrade && 'a trade'].filter(Boolean).join(' and ');
    if (!(await confirmDialog(`Replace ${replaces.join(' and ')} with the backup's ${what}?`, 'Replace'))) return;
  }
  save(data.collection.map((e) => ({ ...e, key: entryKey(e) })));
  if (takesTrade) restoreTrade(data.trade);
  renderCollection();
  toast(`Imported ${cardCount(data.collection)}${takesTrade ? ' and your trade' : ''}`, 3000);
  persistStorage();
}

/** Home Screen tips: in a Safari tab with saved cards, add to Home Screen (once); in the Home Screen app, still empty: import. */
function renderTips(items = loadCollection()) {
  const { iosTab, standalone } = appMode();
  $('#tip-home-screen').hidden = !(iosTab && items.length && !seen(TIP_KEY));
  $('#import-hint').hidden = !(standalone && !items.length);
}

/** Once, in a Home Screen app that has nothing saved yet: offer to bring the cards over from Safari. */
function offerImport() {
  if (!appMode().standalone || seen(OFFER_KEY) || loadCollection().length || savedTrade()) return;
  remember(OFFER_KEY);
  setTimeout(() => {
    actionToast('Moving from Safari? Import your backup', 'Import', () => {
      navigate('collection');
      $('#backup-file').click();
    }, { ms: 10000 });
  }, 1500);
}
