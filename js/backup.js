// Keeping saved cards safe. The collection and the trade live only in this browser's storage
// on this phone, so:
//  - a backup file (Saved tab: Export backup / Import backup) holds both, as JSON. Batch photos
//    aren't in it: they are photos waiting to be identified, not a record, and would make the
//    file many megabytes; identify them (or add them to the collection) before moving;
//  - at start-up the browser is asked to keep this site's storage even when the phone runs low
//    on space (navigator.storage.persist(); Safari and Chrome decide by themselves, no prompt);
//  - Safari can delete a website's storage after about a week without a visit, and an app
//    added to the Home Screen has storage of its own: collection.js shows a one-time tip in a
//    Safari tab, and offers the import once in a Home Screen app that's still empty.
// This module has the file format and those checks; collection.js has the buttons.
import { emit } from './ui.js';

export const BACKUP_APP = 'pokemon-card-scanner';
const BACKUP_VERSION = 1;
const TRADE_KEY = 'trade.v1'; // where trade.js keeps the trade

/** Where the app runs: { iosTab: a Safari tab on iPhone/iPad, standalone: opened from the Home Screen }. */
export function appMode() {
  const standalone = navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)').matches;
  // navigator.standalone exists only in Safari on iPhone and iPad (false in a tab).
  const iosTab = navigator.standalone === false && navigator.maxTouchPoints > 0;
  return { iosTab, standalone };
}

let persisted = null; // what the browser answered, once asked

/**
 * Ask the browser to keep this site's storage, at most once per start (Safari and Chrome
 * decide without asking; Firefox asks the user, so this waits until a card is saved).
 * Resolves true/false.
 */
export async function persistStorage() {
  if (persisted != null) return persisted;
  try {
    persisted = (await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()) || false;
  } catch {
    persisted = false;
  }
  return persisted;
}

/** For diagnostics: { persisted, usage, quota } (bytes), as far as the browser tells. */
export async function storageInfo() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  return { persisted, usage: est?.usage ?? null, quota: est?.quota ?? null, ...appMode() };
}

// ---------- the trade, as trade.js saves it ----------

export function savedTrade() {
  try {
    const t = JSON.parse(localStorage.getItem(TRADE_KEY));
    return t && (t.give?.length || t.get?.length) ? { give: t.give || [], get: t.get || [], rate: t.rate ?? 100, rateSide: t.rateSide || 'give' } : null;
  } catch {
    return null;
  }
}

/** Replace the saved trade; trade.js reloads it ('backup:imported'). */
export function restoreTrade(t) {
  localStorage.setItem(TRADE_KEY, JSON.stringify({ ...t, updated: Date.now() }));
  emit('backup:imported', {});
}

// ---------- the file ----------

/** The backup file's contents for a collection (entries) and a trade (or null). */
export function makeBackup(collection, trade, now = new Date()) {
  return { app: BACKUP_APP, version: BACKUP_VERSION, exported: now.toISOString(), collection, trade: trade || null };
}

export function backupFileName(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return `pokemon-cards-backup-${d}.json`;
}

const str = (v, max = 300) => (v == null ? '' : String(v).slice(0, max));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const url = (v) => (typeof v === 'string' && /^https:\/\//.test(v) ? v.slice(0, 500) : '');

function price(p) {
  if (!p || typeof p !== 'object' || num(p.value) == null) return null;
  const out = { value: p.value, currency: str(p.currency, 8) || 'USD', source: str(p.source, 80), converted: !!p.converted };
  if (p.original && num(p.original.value) != null) out.original = { value: p.original.value, currency: str(p.original.currency, 8) };
  return out;
}

/** One saved card (see entry.js), with only the fields the app uses; null if it isn't one. */
function entry(e) {
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || typeof e.name !== 'string') return null;
  const qty = Math.min(9999, Math.max(1, Math.round(num(e.qty) ?? 1)));
  const out = {
    id: str(e.id, 60),
    name: str(e.name, 120),
    setId: str(e.setId, 60),
    setName: str(e.setName, 120),
    number: str(e.number, 30),
    variant: str(e.variant, 120),
    variantId: str(e.variantId, 120),
    image: url(e.image),
    fallbackImage: url(e.fallbackImage),
    price: price(e.price),
    qty,
    added: num(e.added) ?? Date.now(),
  };
  if (num(e.pricedAt) != null) out.pricedAt = e.pricedAt; // trade lines: when their price was looked up
  return out;
}

const entries = (list) => (Array.isArray(list) ? list.map(entry).filter(Boolean) : []);

/**
 * Check a backup file's parsed JSON. Returns { collection, trade } (trade null when the file has
 * none), keeping only well-formed cards. Throws an Error with a message for the user otherwise.
 */
export function readBackup(data) {
  if (!data || typeof data !== 'object' || data.app !== BACKUP_APP || !Array.isArray(data.collection)) {
    throw new Error("That file isn't a backup from this app.");
  }
  if (data.version > BACKUP_VERSION) throw new Error('That backup is from a newer version of the app. Reload the app to update it, then try again.');
  const collection = entries(data.collection);
  const t = data.trade;
  const trade = t && typeof t === 'object' ? { give: entries(t.give), get: entries(t.get), rate: num(t.rate) ?? 100, rateSide: t.rateSide === 'get' ? 'get' : 'give' } : null;
  return { collection, trade: trade && (trade.give.length || trade.get.length) ? trade : null };
}

/** "1 card", "12 cards" (counting copies). */
export function cardCount(list) {
  const n = (list || []).reduce((s, e) => s + (e.qty || 1), 0);
  return `${n} card${n === 1 ? '' : 's'}`;
}
