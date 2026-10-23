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
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
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

const cardMem = new Map();
/** Full card details including prices. */
export async function getCard(id) {
  if (cardMem.has(id)) return cardMem.get(id);
  const key = `card:${id}`;
  const cached = await kvGet(key);
  if (cached && Date.now() - cached.t < CARD_MAX_AGE) {
    cardMem.set(id, cached.card);
    return cached.card;
  }
  try {
    const card = await getJSON(`/cards/${encodeURIComponent(id)}`);
    if (card) {
      cardMem.set(id, card);
      kvSet(key, { t: Date.now(), card });
    }
    return card;
  } catch (e) {
    if (cached) return cached.card; // offline: show last known prices
    throw e;
  }
}

/**
 * Official set codes ("OBF", "POR") printed on Scarlet & Violet and newer cards.
 * Only the full set endpoint has them, so fetch modern sets once and cache forever.
 */
export async function getSetAbbreviations(sets) {
  // stored as setId -> { code, t }; sets without a code yet are re-checked weekly
  const stored = (await kvGet('setAbbr')) || {};
  const week = 7 * 24 * 3600 * 1000;
  const todo = sets.filter(
    (s) => /^(sv|me)/i.test(s.id) && !(stored[s.id] && (stored[s.id].code || Date.now() - stored[s.id].t < week)),
  );
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
