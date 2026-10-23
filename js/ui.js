// Small DOM helpers and an app-wide event bus shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el('div', { class: 'x', onclick: fn }, child, 'text', [more]) */
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}

export function toast(msg, ms = 2200) {
  // One message at a time: a new toast replaces the previous plain one.
  document.querySelectorAll('.toast[data-plain]').forEach((n) => n.remove());
  const t = el('div', { class: 'toast', role: 'status', 'data-plain': true }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

/** A toast with one button (Undo, View…). onEnd(tapped) runs once its time is up, even if a newer toast replaced it. */
export function actionToast(msg, label, onAction, { ms = 5000, onEnd } = {}) {
  document.querySelectorAll('.toast[data-plain]').forEach((n) => n.remove());
  let tapped = false;
  const onclick = () => {
    tapped = true;
    t.remove();
    onAction();
  };
  const t = el('div', { class: 'toast toast-action', role: 'status', 'data-plain': true }, el('span', {}, msg), el('button', { type: 'button', onclick }, label));
  document.body.append(t);
  setTimeout(() => {
    t.remove();
    onEnd?.(tapped);
  }, ms);
}

export function setStatus(target, msg, isError = false) {
  const s = typeof target === 'string' ? $(target) : target;
  if (!s) return;
  s.textContent = msg || '';
  s.classList.toggle('error', !!isError);
}

// ---- event bus ----
// 'card:action'  detail: { action: 'collection' | 'trade-give' | 'trade-get', card, row, entry, owner? }
//                 owner is the opts.owner the sheet was opened with (see sheet.js showResults)
// 'app:navigate' detail: { view: 'scan' | 'batch' | 'trade' | 'search' | 'collection', tradeSide?: 'give' | 'get', batchMode?: true }
//                 navigate('scan', { tradeSide: 'give' }) opens the scanner in "adding cards to You give" mode;
//                 navigate('scan', { batchMode: true }) opens it with Batch mode switched on;
//                 navigate('search', { tradeSide: 'get' }) does the same for Search.
// 'batch:changed' detail: {}  (queue size changed)
// 'sheet:closed'  detail: { owner? }
// 'catalog:ready' detail: {}
// 'fx:ready'     detail: { rate, date, fallback }
export function emit(name, detail) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, fn) {
  const h = (e) => fn(e.detail);
  document.addEventListener(name, h);
  return () => document.removeEventListener(name, h);
}

export function navigate(view, extra = {}) {
  emit('app:navigate', { view, ...extra });
}

/** Simple confirm sheet that works the same on iOS and Android. Resolves true/false. */
export function confirmDialog(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    const done = (v) => {
      wrap.remove();
      resolve(v);
    };
    const wrap = el(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'modal-backdrop', onclick: () => done(false) }),
      el(
        'div',
        { class: 'modal-panel' },
        el('p', {}, message),
        el(
          'div',
          { class: 'row modal-actions' },
          el('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
          el('button', { class: 'btn primary', type: 'button', onclick: () => done(true) }, okLabel),
        ),
      ),
    );
    document.body.append(wrap);
  });
}
