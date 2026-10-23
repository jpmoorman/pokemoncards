// The local card index (every English card) plus set codes, shared by all views.
import { loadCatalog, getSetAbbreviations } from './api.js';
import { buildIndex } from './match.js';

export const catalog = { index: null, sets: [], setAbbr: {} };

let readyP = null;
let abbrP = Promise.resolve({});

export function initCatalog(onStatus) {
  if (!readyP) {
    readyP = loadCatalog({ onStatus }).then(({ cards, sets }) => {
      catalog.index = buildIndex(cards, sets);
      catalog.sets = sets;
      abbrP = getSetAbbreviations(sets)
        .then((m) => (catalog.setAbbr = m))
        .catch(() => catalog.setAbbr);
      return catalog;
    });
    readyP.catch(() => {
      readyP = null; // allow a retry
    });
  }
  return readyP;
}

/** Resolves once the card list is loaded. */
export function catalogReady() {
  return readyP || initCatalog();
}

/** Resolves once set codes (OBF, POR, …) are known too. */
export function abbrReady() {
  return catalogReady().then(() => abbrP);
}

/**
 * Sets for the set picker, newest first:
 * { coded: [{ id, code, name }], older: [{ id, name }] }
 * `coded` are sets whose cards print a set code; `older` only print a symbol.
 */
export function setOptions() {
  const coded = [];
  const older = [];
  for (const s of [...catalog.index?.setsById.values() || []].sort((a, b) => b.order - a.order)) {
    const code = catalog.setAbbr[s.id];
    if (code) coded.push({ id: s.id, code, name: s.name });
    else older.push({ id: s.id, name: s.name });
  }
  return { coded, older };
}

export function setById(id) {
  return catalog.index?.setsById.get(id) || null;
}
