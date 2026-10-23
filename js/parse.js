// Turns raw OCR text from a card photo into structured clues:
// collector number(s), printed set total, set code (e.g. "OBF") and a name guess.

// Characters OCR commonly confuses with digits.
const DIGIT_FIX = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', i: '1', '|': '1', L: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' };

function fixDigits(s) {
  let out = '';
  for (const ch of s) out += /\d/.test(ch) ? ch : (DIGIT_FIX[ch] ?? '');
  return out;
}

function hasDigit(s) {
  return /\d/.test(s);
}

// Words printed on the card frame that are never part of a card name
// (only dropped when they make up a whole line, so "Item Finder" survives).
const FRAME_WORDS = new Set([
  'basic', 'stage', 'stage1', 'stage2', 'stage 1', 'stage 2', 'trainer', 'item', 'supporter',
  'stadium', 'tool', 'pokemon tool', 'energy', 'special energy', 'basic energy', 'restored',
  'level up', 'break', 'vmax', 'vstar', 'tera', 'ace spec', 'pokemon', 'trainer item',
  'trainer supporter', 'trainer stadium', 'basic pokemon', 'evolves', 'put',
]);

const PROMO_PREFIXES = ['SWSH', 'HGSS', 'SVP', 'MEP', 'SM', 'XY', 'BW', 'DP', 'SV', 'ME'];
const SUBSET_PREFIXES = ['TG', 'GG', 'SV', 'RC', 'H'];

/**
 * Extract collector numbers and set codes from the text found near the
 * bottom of a card (or the whole card when that's all we have).
 * Returns { numbers: [{prefix, num, total}], setCodes: [string] }.
 */
export function parseBottomText(text) {
  const t = (text || '').replace(/[–—−]/g, '-').replace(/[⁄∕]/g, '/');
  const numbers = [];
  const seen = new Set();
  const push = (prefix, rawNum, rawTotal) => {
    const num = parseInt(fixDigits(rawNum), 10);
    const total = rawTotal == null ? null : parseInt(fixDigits(rawTotal), 10);
    if (!Number.isFinite(num) || num <= 0 || num > 999) return;
    if (total != null && (!Number.isFinite(total) || total < 5 || num > total + 150)) return;
    const key = `${prefix}|${num}|${total}`;
    if (seen.has(key)) return;
    seen.add(key);
    numbers.push({ prefix: prefix || '', num, total });
  };

  // Subset numbers like TG05/TG30, GG12/GG70, SV045/SV122, RC5/RC32.
  const subsetRe = new RegExp(
    `\\b(${SUBSET_PREFIXES.join('|')})\\s*([0-9OIl]{1,3})\\s*[/\\\\|]\\s*(?:${SUBSET_PREFIXES.join('|')})?\\s*([0-9OIl]{1,3})\\b`,
    'gi',
  );
  for (const m of t.matchAll(subsetRe)) {
    if (hasDigit(m[2]) && hasDigit(m[3])) push(m[1].toUpperCase(), m[2], m[3]);
  }

  // Standard "125/197". Allows a few letters OCR mistakes for digits.
  const stdRe = /(?<![0-9A-Za-z])([0-9OIlSBD]{1,3})\s*\/\s*([0-9OIlSBD]{2,3})(?![0-9])/g;
  for (const m of t.matchAll(stdRe)) {
    if (hasDigit(m[1]) && hasDigit(m[2])) push('', m[1], m[2]);
  }

  // Slash misread as "1", "l" or "|" ("1251197"): only try when nothing else matched.
  if (!numbers.length) {
    const looseRe = /(?<![0-9])(\d{1,3})\s*[|\\lI]\s*(\d{2,3})(?![0-9])/g;
    for (const m of t.matchAll(looseRe)) push('', m[1], m[2]);
  }

  // Set codes printed on Scarlet & Violet / Mega Evolution era cards: "OBF EN".
  const setCodes = [];
  for (const m of t.matchAll(/\b([A-Z0-9]{3})\s*[·•.:\-]?\s*EN\b/g)) {
    const code = m[1].toUpperCase();
    if (/[A-Z]/.test(code) && !setCodes.includes(code)) setCodes.push(code);
  }

  // Promos without a total: "SWSH050", "SM210", "SVP EN 045", "MEP 012".
  if (!numbers.some((n) => n.total)) {
    const promoRe = new RegExp(`\\b(${PROMO_PREFIXES.join('|')})\\s*(?:EN)?\\s*[-:#]?\\s*(\\d{1,3})\\b`, 'g');
    for (const m of t.matchAll(promoRe)) push(m[1].toUpperCase(), m[2], null);
    // Number right after a set code: "OBF EN 125" when the "/197" got lost.
    for (const m of t.matchAll(/\b[A-Z]{3}\s*EN\s*(\d{1,3})\b/g)) push('', m[1], null);
  }

  // Loose 3-letter uppercase tokens; matched against known set codes later.
  const codeCandidates = [];
  for (const m of t.matchAll(/\b([A-Z0-9]{3})\b/g)) {
    if (/[A-Z]/.test(m[1]) && !setCodes.includes(m[1]) && !codeCandidates.includes(m[1])) codeCandidates.push(m[1]);
  }

  return { numbers, setCodes, codeCandidates };
}

/** Lowercase, strip accents and punctuation. "Pokémon Catcher!" -> "pokemon catcher" */
export function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Remove HP values, evolution text and frame labels from one OCR line. */
export function cleanNameLine(line) {
  let s = (line || '')
    .replace(/\bHP\s*[0-9OIlSB]{2,3}\b/gi, ' ')
    .replace(/\b[0-9OIlSB]{2,3}\s*HP\b/gi, ' ')
    .replace(/\bevol\w*\s+from\b.*$/i, ' ')
    .replace(/\bput\s+.*\bon the\b.*$/i, ' ')
    .replace(/\bstage\s*[12]\b/gi, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^A-Za-zÀ-ÿ'’.\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const n = normalize(s);
  if (!n || FRAME_WORDS.has(n)) return '';
  // Needs at least one real word; artwork often reads as junk like "EE a".
  if (!/[a-z]{3,}/i.test(s)) return '';
  // Strip leading frame labels glued to the name ("BASIC Pikachu"). Labels are
  // printed in capitals, which keeps names like "Item Finder" intact.
  s = s.replace(/^(BASIC|STAGE|TRAINER|SUPPORTER|ITEM|STADIUM)\s+/, '');
  return s;
}

/**
 * Pick the most likely name text from OCR lines of the top of the card.
 * lines: [{ text, height, conf? }]. The card name is printed in the biggest font;
 * OCR confidence (0-100) damps tall-but-garbled reads of the artwork.
 * Returns { best, all } where `all` joins every cleaned line.
 */
export function pickName(lines) {
  const cleaned = (lines || [])
    .map((l) => {
      const conf = l.conf == null ? 100 : l.conf;
      return { text: cleanNameLine(l.text), score: (l.height || 0) * Math.min(1, Math.max(0.2, conf / 90)) };
    })
    .filter((l) => l.text);
  if (!cleaned.length) return { best: '', all: '' };
  const tallest = [...cleaned].sort((a, b) => b.score - a.score)[0];
  return { best: tallest.text, all: cleaned.map((l) => l.text).join(' ') };
}
