// Type-to-filter set picker. Type a set code ("P" → PAL, PAR, POR…; "PO" → POR · Perfect Order)
// or part of a set name ("jung" → Jungle). The chosen set id lives in a hidden input
// (#q-set, #clue-set) so the rest of the app just reads its .value.
//
// Markup (see index.html):
//   <div class="setpick"><input class="setpick-input"><button class="setpick-clear"></button>
//     <input type="hidden" id="…"><ul class="setpick-list"></ul></div>
import { el } from './ui.js';
import { catalog } from './catalog.js';
import { SET_CODES } from './setcodes.js';

const MAX_SHOWN = 60;

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Every set, newest first: { id, name, code }. Codes printed on modern cards come from the API; older ones are bundled. */
export function setList() {
  const sets = [...(catalog.index?.setsById.values() || [])].sort((a, b) => b.order - a.order);
  return sets.map((s) => ({ id: s.id, name: s.name, code: String(catalog.setAbbr[s.id] || SET_CODES[s.id] || '').toUpperCase() }));
}

export function setLabel(s) {
  return s ? (s.code ? `${s.code} · ${s.name}` : s.name) : '';
}

/** Sets matching what was typed, best first: exact code, code prefix, a name word prefix, then anywhere. */
export function filterSets(list, query) {
  const q = norm(query);
  if (!q) return list;
  const qc = q.replace(/ /g, '');
  const out = [];
  for (const s of list) {
    const code = s.code.toLowerCase();
    const name = norm(s.name);
    let rank = -1;
    if (code && code === qc) rank = 0;
    else if (code && code.startsWith(qc)) rank = 1;
    else if (name.startsWith(q)) rank = 2;
    else if (name.split(' ').some((w) => w.startsWith(q))) rank = 3;
    else if (name.includes(q) || name.replace(/ /g, '').includes(qc)) rank = 4;
    else if (code && code.includes(qc)) rank = 5;
    if (rank >= 0) out.push([rank, s]);
  }
  // sort is stable, so newest-first order is kept within each rank
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

const pickers = new Map(); // root element -> api

/** Wire up one picker. Returns { get value(), set(id) }. */
export function mountSetPicker(root) {
  if (pickers.has(root)) return pickers.get(root);
  const input = root.querySelector('.setpick-input');
  const hidden = root.querySelector('input[type=hidden]');
  const list = root.querySelector('.setpick-list');
  const clear = root.querySelector('.setpick-clear');
  let shown = [];
  let active = 0;

  const current = () => setList().find((s) => s.id === hidden.value) || null;
  const showValue = () => {
    input.value = setLabel(current());
    clear.hidden = !hidden.value;
  };
  const choose = (id) => {
    const changed = hidden.value !== (id || '');
    hidden.value = id || '';
    showValue();
    close();
    if (changed) hidden.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };
  const render = () => {
    const all = setList();
    const typed = input.value === setLabel(current()) ? '' : input.value;
    shown = filterSets(all, typed);
    active = 0;
    const items = shown.slice(0, MAX_SHOWN).map((s, i) =>
      el(
        'li',
        { role: 'option', 'data-id': s.id, class: i === active ? 'active' : '', 'aria-selected': s.id === hidden.value ? 'true' : 'false' },
        s.code ? el('b', { class: 'setpick-code' }, s.code) : null,
        el('span', {}, s.name),
      ),
    );
    if (!shown.length) items.push(el('li', { class: 'setpick-none' }, all.length ? 'No set matches — try the set name' : 'Loading sets…'));
    else if (shown.length > MAX_SHOWN) items.push(el('li', { class: 'setpick-none' }, `${shown.length - MAX_SHOWN} more — keep typing to narrow`));
    list.replaceChildren(...items);
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const highlight = (i) => {
    const lis = [...list.querySelectorAll('li[data-id]')];
    if (!lis.length) return;
    active = (i + lis.length) % lis.length;
    lis.forEach((li, k) => li.classList.toggle('active', k === active));
    lis[active].scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('focus', () => {
    input.select();
    render();
  });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') highlight(active + 1);
    else if (e.key === 'ArrowUp') highlight(active - 1);
    else if (e.key === 'Escape') {
      showValue();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!input.value.trim()) choose('');
      else if (shown[active]) choose(shown[active].id);
      input.blur();
    } else return;
    e.preventDefault();
  });
  input.addEventListener('blur', () => {
    // Let a tap on the list land first.
    setTimeout(() => {
      if (!input.value.trim()) choose('');
      else {
        // An exact code typed and left ("POR") counts as choosing it.
        const exact = filterSets(setList(), input.value).find((s) => s.code && s.code.toLowerCase() === norm(input.value).replace(/ /g, ''));
        if (exact && input.value !== setLabel(current())) choose(exact.id);
        else showValue();
      }
      close();
    }, 150);
  });
  // pointerdown + preventDefault keeps the input focused, so the blur handler doesn't race the tap.
  list.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const li = e.target.closest('li[data-id]');
    if (li) {
      choose(li.dataset.id);
      input.blur();
    }
  });
  clear.addEventListener('click', () => {
    choose('');
    input.focus();
  });

  const api = {
    get value() {
      return hidden.value;
    },
    set(id) {
      hidden.value = id || '';
      showValue();
    },
    refresh: showValue,
  };
  pickers.set(root, api);
  showValue();
  return api;
}

/** Set a picker's value by the id of its hidden input ('q-set', 'clue-set'). */
export function setPickerValue(hiddenId, setId) {
  const hidden = document.getElementById(hiddenId);
  const root = hidden?.closest('.setpick');
  if (root) mountSetPicker(root).set(setId);
}
