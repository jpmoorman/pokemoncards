// "Collection" tab: saved cards with a running USD total, price refresh and CSV export.
import { $, el, on, toast, confirmDialog } from './ui.js';
import { formatMoney } from './prices.js';
import { entryKey, refreshEntry, totalUsd, unitUsd, entryNumber } from './entry.js';
import { entryRow } from './components.js';
import { openCard } from './sheet.js';

const KEY = 'collection.v1';

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
    const out = [];
    for (const [n, i] of items.entries()) {
      btn.textContent = `Refreshing ${n + 1}/${items.length}…`;
      out.push(await refreshEntry(i));
    }
    save(out);
    renderCollection();
    btn.disabled = false;
    btn.textContent = 'Refresh prices';
    toast('Prices updated');
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
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'pokemon-collection.csv' });
    document.body.append(a);
    a.click();
    a.remove();
  });

  $('#btn-clear-collection')?.addEventListener('click', async () => {
    if (!loadCollection().length) return;
    if (await confirmDialog('Remove every card from your collection?', 'Remove all')) {
      save([]);
      renderCollection();
    }
  });

  renderCount();
}
