// Ranks cards from the local card index against clues parsed from OCR.
import { normalize } from './parse.js';

const compact = (s) => normalize(s).replace(/ /g, '');

function bigrams(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity on character bigrams, 0..1. */
export function dice(a, b) {
  if (a === b) return a ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  let inter = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = A.get(g);
    if (c) {
      inter++;
      A.set(g, c - 1);
    }
  }
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/**
 * How well `name` appears somewhere inside noisy OCR `text`, 0..1.
 * Spaces are ignored because OCR often drops or adds them.
 */
export function partialSimilarity(name, text) {
  const n = compact(name);
  const t = compact(text);
  if (!n || !t) return 0;
  if (t.includes(n)) return 1;
  if (n.length >= t.length) return dice(n, t);
  let best = 0;
  for (let w = Math.max(2, n.length - 1); w <= n.length + 1; w++) {
    for (let i = 0; i + w <= t.length; i++) {
      const d = dice(n, t.slice(i, i + w));
      if (d > best) best = d;
    }
  }
  return best;
}

/** "TG05" -> { prefix: "TG", num: 5 }, "125" -> { prefix: "", num: 125 }. */
export function parseLocalId(localId) {
  const m = /^([A-Za-z]*)\s*0*(\d+)[a-z]?$/.exec(String(localId || '').trim());
  if (!m) return null;
  return { prefix: m[1].toUpperCase(), num: parseInt(m[2], 10) };
}

/**
 * Build the in-memory search index.
 * cards: [{ id, localId, name, image? }], sets: [{ id, name, cardCount: {official,total}, ... }]
 */
export function buildIndex(cards, sets) {
  const setsById = new Map();
  // Pokémon TCG Pocket (the mobile game) sets use ids like "A1", "B2a", "P-A"; skip them.
  sets.forEach((s, i) => !/^[A-Z]/.test(s.id) && setsById.set(s.id, { ...s, order: i }));
  const entries = [];
  const byNum = new Map();
  const byName = new Map();
  for (const c of cards) {
    const setId = c.id.slice(0, c.id.length - String(c.localId).length - 1);
    if (!setsById.has(setId)) continue;
    const parsed = parseLocalId(c.localId);
    const e = { ...c, setId, prefix: parsed?.prefix ?? '', num: parsed?.num ?? null };
    entries.push(e);
    if (e.num != null) {
      if (!byNum.has(e.num)) byNum.set(e.num, []);
      byNum.get(e.num).push(e);
    }
    const key = compact(c.name);
    if (!byName.has(key)) byName.set(key, { name: c.name, cards: [] });
    byName.get(key).cards.push(e);
  }
  return { entries, byNum, byName, setsById };
}

/**
 * Rank candidate cards.
 * clues: { nameBest, nameAll, numbers: [{prefix,num,total}], setCodes: [], codeCandidates: [] }
 * setAbbr: Map/obj setId -> official code ("OBF")
 * Returns [{ card, set, score, reasons }] best first.
 */
// OCR mixes up O and 0 ("3OC" for "30C"), so compare codes with both folded to 0.
const codeKey = (c) => String(c || '').toUpperCase().replace(/O/g, '0');

export function rankCandidates(index, clues, setAbbr = {}, limit = 40) {
  const abbrOf = (setId) => (setAbbr instanceof Map ? setAbbr.get(setId) : setAbbr[setId]) || null;
  const codes = new Set((clues.setCodes || []).map(codeKey));
  const looseCodes = new Set((clues.codeCandidates || []).map(codeKey));
  const nameBest = clues.nameBest || '';
  const nameAll = clues.nameAll || '';
  const hasName = !!(nameBest || nameAll);
  const nameCache = new Map();
  const nameScore = (card) => {
    if (!hasName) return 0;
    if (nameCache.has(card.name)) return nameCache.get(card.name);
    const s = Math.max(
      nameBest ? partialSimilarity(card.name, nameBest) : 0,
      nameAll ? 0.85 * partialSimilarity(card.name, nameAll) : 0,
    );
    nameCache.set(card.name, s);
    return s;
  };
  const setBonus = (card, total, reasons) => {
    const set = index.setsById.get(card.setId);
    let s = 0;
    const abbr = abbrOf(card.setId);
    if (abbr && codes.has(codeKey(abbr))) {
      s += 4;
      reasons.push(`set code ${abbr}`);
    } else if (abbr && looseCodes.has(codeKey(abbr))) {
      s += 2;
      reasons.push(`set code ${abbr}?`);
    }
    if (total) {
      if (set.cardCount?.official === total) {
        s += 2.5;
        reasons.push(`set size ${total}`);
      } else if (set.cardCount?.total === total) {
        s += 1.5;
        reasons.push(`set size ${total}`);
      } else {
        s -= 1;
      }
    }
    return s;
  };

  const results = new Map();
  const add = (card, score, reasons) => {
    const prev = results.get(card.id);
    if (!prev || prev.score < score) {
      results.set(card.id, { card, set: index.setsById.get(card.setId), score, reasons });
    }
  };

  for (const n of clues.numbers || []) {
    for (const card of index.byNum.get(n.num) || []) {
      const reasons = [`#${card.localId}`];
      let s = 3;
      if (n.prefix || card.prefix) {
        if (n.prefix === card.prefix) s += 1;
        else if (n.prefix && card.prefix) continue;
        else s -= 1.5;
      }
      s += setBonus(card, n.total, reasons);
      const ns = nameScore(card);
      if (ns > 0.5) reasons.push(`name ${Math.round(ns * 100)}%`);
      s += 5 * ns;
      add(card, s, reasons);
    }
  }

  // Name-driven search: always run when we have a name, so a misread number
  // can't hide the right card.
  if (hasName) {
    const textBigrams = new Set();
    const t = compact(`${nameBest} ${nameAll}`);
    for (let i = 0; i < t.length - 1; i++) textBigrams.add(t.slice(i, i + 2));
    for (const [key, group] of index.byName) {
      if (key.length < 3) continue;
      // Cheap prefilter: most of the name's bigrams must appear in the text.
      let hit = 0;
      for (let i = 0; i < key.length - 1; i++) if (textBigrams.has(key.slice(i, i + 2))) hit++;
      if (hit / Math.max(1, key.length - 1) < 0.5) continue;
      const ns = nameScore(group.cards[0]);
      if (ns < 0.6) continue;
      for (const card of group.cards) {
        const reasons = [`name ${Math.round(ns * 100)}%`];
        let s = 5 * ns;
        const total = (clues.numbers || []).find((n) => n.total)?.total;
        s += Math.max(0, setBonus(card, total, reasons));
        // Slight preference for longer names when equally similar ("Charizard ex" over "Charizard").
        s += Math.min(key.length, 20) / 200;
        add(card, s, reasons);
      }
    }
  }

  return [...results.values()]
    .sort((a, b) => b.score - a.score || b.set.order - a.set.order)
    .slice(0, limit);
}

/** Rough confidence label for the top result. */
export function confidence(ranked) {
  if (!ranked.length) return 'none';
  const [a, b] = ranked;
  const gap = b ? a.score - b.score : a.score;
  if (a.score >= 8 && gap >= 1.5) return 'high';
  if (a.score >= 6) return 'medium';
  return 'low';
}

/** Manual search: name text and/or number like "125", "125/197", "TG05". */
export function manualSearch(index, nameQuery, numberQuery, setAbbr = {}) {
  const clues = { nameBest: nameQuery || '', nameAll: '', numbers: [], setCodes: [], codeCandidates: [] };
  const q = (numberQuery || '').trim().toUpperCase();
  if (q) {
    const m = /^([A-Z]*)\s*(\d{1,3})\s*(?:\/\s*[A-Z]*\s*(\d{1,3}))?$/.exec(q);
    if (m) clues.numbers.push({ prefix: m[1], num: parseInt(m[2], 10), total: m[3] ? parseInt(m[3], 10) : null });
  }
  let ranked = rankCandidates(index, clues, setAbbr, 200);
  if (nameQuery) {
    // Plain substring matches the fuzzy matcher might rank low ("pika" -> every Pikachu).
    const nq = compact(nameQuery);
    if (nq.length >= 2) {
      const have = new Set(ranked.map((r) => r.card.id));
      for (const [key, group] of index.byName) {
        if (!key.includes(nq)) continue;
        for (const card of group.cards) {
          if (have.has(card.id)) continue;
          if (clues.numbers.length && !clues.numbers.some((n) => n.num === card.num)) continue;
          ranked.push({ card, set: index.setsById.get(card.setId), score: 2 + nq.length / key.length, reasons: ['name contains'] });
        }
      }
    }
    if (clues.numbers.length) ranked = ranked.filter((r) => clues.numbers.some((n) => n.num === r.card.num));
    ranked.sort((a, b) => b.score - a.score || b.set.order - a.set.order);
  }
  return ranked.slice(0, 120);
}
