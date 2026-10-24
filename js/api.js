// TCGdex API access (free, no key, CORS-enabled) with on-device caching.
// https://tcgdex.dev — card data plus TCGplayer (USD) and Cardmarket (EUR) prices.

const BASE = 'https://api.tcgdex.net/v2/en';
const ASSETS = 'https://assets.tcgdex.net/en/';
const INDEX_MAX_AGE = 3 * 24 * 3600 * 1000; // refresh card list every 3 days (new sets)
const CARD_MAX_AGE = 12 * 3600 * 1000; // prices update daily

// ---------- tiny IndexedDB key/value store ----------
let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('pokecard-scanner', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return dbPromise;
}

export async function kvGet(key) {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    const req = d.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

export async function kvSet(key, value) {
  const d = await db();
  if (!d) return;
  return new Promise((resolve) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function getJSON(path, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(path.startsWith('http') ? path : BASE + path);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

// Pokémon TCG Pocket (the mobile game) sets use ids like "A1", "B2a", "P-A".
const isPocketSet = (id) => /^[A-Z]/.test(id);

/**
 * Load the list of every card + every set. Cached in IndexedDB.
 * Returns { cards: [{id, localId, name, image}], sets: [...] , updated }.
 */
export async function loadCatalog({ force = false, onStatus } = {}) {
  const cached = await kvGet('catalog');
  const fresh = cached && Date.now() - cached.updated < INDEX_MAX_AGE;
  if (cached && !force) {
    if (!fresh) refreshCatalog().catch(() => {}); // stale-while-revalidate
    return expand(cached);
  }
  onStatus?.('Downloading card database (first time only)…');
  return expand(await refreshCatalog());
}

async function refreshCatalog() {
  const [sets, cards] = await Promise.all([getJSON('/sets'), getJSON('/cards')]);
  const keepSets = sets.filter((s) => !isPocketSet(s.id));
  const keepIds = new Set(keepSets.map((s) => s.id));
  // Store compactly: [id, localId, name, imagePath]
  const rows = [];
  for (const c of cards) {
    const setId = c.id.slice(0, c.id.length - String(c.localId).length - 1);
    if (!keepIds.has(setId)) continue;
    rows.push([c.id, c.localId, c.name, c.image ? c.image.replace(ASSETS, '') : '']);
  }
  const catalog = { updated: Date.now(), sets: keepSets, rows };
  await kvSet('catalog', catalog);
  return catalog;
}

function expand(catalog) {
  const cards = catalog.rows.map(([id, localId, name, img]) => ({
    id,
    localId,
    name,
    image: img ? (img.startsWith('http') ? img : ASSETS + img) : '',
  }));
  return { cards, sets: catalog.sets, updated: catalog.updated };
}

const cardMem = new Map(); // id -> { t, card }, same as the IndexedDB copy
const cardLoads = new Map(); // id -> { load, retries }: download in progress, shared by everyone asking meanwhile
// Cards only looked up to rank a scan (lookupCard): kept in memory, the latest LOOKED_MAX of
// them, and saved on the device only once shown (getCard).
const looked = new Map(); // id -> { t, card }
const LOOKED_MAX = 200;
// Lookups that failed lately (server unreachable): not asked again for a minute, so a scan
// asks for each card once however many times the ranking wants it.
const missed = new Map(); // id -> when
const MISS_MS = 60 * 1000;

/**
 * Download a card's details once, however many callers ask while it's on its way.
 * Resolves to { t, card }, or null if there's no such card. A caller wanting more tries than
 * the download in progress makes starts its own when that one fails.
 */
function downloadCard(id, retries) {
  const shared = cardLoads.get(id);
  if (shared) return shared.retries >= retries ? shared.load : shared.load.catch(() => downloadCard(id, retries));
  const load = getJSON(`/cards/${encodeURIComponent(id)}`, { retries })
    .then((card) => card && { t: Date.now(), card })
    .finally(() => cardLoads.get(id)?.load === load && cardLoads.delete(id));
  cardLoads.set(id, { load, retries });
  return load;
}

/** Keep a copy shown to the user, in memory and on the device. */
function keep(id, copy) {
  cardMem.set(id, copy);
  looked.delete(id);
  missed.delete(id);
  kvSet(`card:${id}`, copy);
  return copy.card;
}

/**
 * Full card details including prices, kept for 12 hours.
 * { fresh: true } downloads them again (Refresh prices); offline it still falls back to the saved copy.
 * Callers asking for the same card at the same time share one download (identify.js looks up
 * the best few matches; the result sheet or batch queue then asks for the one shown).
 */
export async function getCard(id, { fresh = false } = {}) {
  const key = `card:${id}`;
  const cached = cardMem.get(id) || (await kvGet(key));
  if (!fresh && cached && Date.now() - cached.t < CARD_MAX_AGE) {
    cardMem.set(id, cached);
    return cached.card;
  }
  // Looked up moments ago to rank the scan.
  const seen = looked.get(id);
  if (!fresh && seen && Date.now() - seen.t < CARD_MAX_AGE) return keep(id, seen);
  try {
    const copy = await downloadCard(id, 2);
    return copy ? keep(id, copy) : null;
  } catch (e) {
    if (!cached) throw e;
    cardMem.set(id, cached);
    return cached.card; // offline: show last known prices
  }
}

/**
 * A card's details to rank a scan with (rerank.js): HP, attacks, illustrator… don't change, so
 * any saved copy will do. Otherwise one download, not retried, kept in memory only (getCard
 * saves it once the card is shown). Offline it sends nothing. Resolves to the card or null.
 */
export async function lookupCard(id) {
  const mem = cardMem.get(id) || looked.get(id) || (await kvGet(`card:${id}`));
  if (mem) return mem.card;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  if (Date.now() - (missed.get(id) || 0) < MISS_MS) return null;
  let copy;
  try {
    copy = await downloadCard(id, 0);
  } catch {
    remember(missed, id, Date.now());
    return null;
  }
  if (copy && !cardMem.has(id)) remember(looked, id, copy);
  return copy?.card ?? null;
}

/** Add to a map that keeps only its latest LOOKED_MAX entries. */
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > LOOKED_MAX) map.delete(map.keys().next().value);
}

/** When the copy of a card that getCard last returned was downloaded (ms since epoch), 0 if never. */
export function cardFetchedAt(id) {
  return cardMem.get(id)?.t || 0;
}

/**
 * Official set codes ("OBF", "POR", "30C") printed on Scarlet & Violet and newer cards.
 * Only the full set endpoint has them, so fetch modern sets once and cache them.
 */
export async function getSetAbbreviations(sets) {
  // stored as setId -> { code, t }; sets without a code yet are re-checked weekly
  const stored = (await kvGet('setAbbr')) || {};
  const week = 7 * 24 * 3600 * 1000;
  // `sets` is in release order; codes are printed from Scarlet & Violet (sv01) onward,
  // including sets with ids like "30th" that don't follow the sv/me naming.
  const firstModern = sets.findIndex((s) => s.id === 'sv01');
  const modern = ( firstModern >= 0 ? sets.slice(firstModern) : sets.filter((s) => /^(sv|me)/i.test(s.id))).filter((s) => !isPocketSet(s.id));
  const todo = modern.filter((s) => !(stored[s.id] && (stored[s.id].code || Date.now() - stored[s.id].t < week)));
  if (todo.length) {
    const queue = [...todo];
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try {
          const full = await getJSON(`/sets/${encodeURIComponent(s.id)}`, { retries: 1 });
          stored[s.id] = { code: full?.abbreviation?.official || null, t: Date.now() };
        } catch {
          /* try again next launch */
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    await kvSet('setAbbr', stored);
  }
  const map = {};
  for (const [id, v] of Object.entries(stored)) if (v?.code) map[id] = v.code.toUpperCase();
  return map;
}

export function cardImage(card, quality = 'low') {
  return card?.image ? `${card.image}/${quality}.webp` : '';
}

export function setSymbol(set) {
  return set?.symbol ? `${set.symbol}.webp` : '';
}
