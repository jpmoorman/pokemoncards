// Turns a full TCGdex card into per-version price rows (all in USD) plus marketplace links.

const TYPE_LABEL = { normal: 'Normal', holo: 'Holo', reverse: 'Reverse Holo' };

// TCGdex stamp ids -> what's printed on the card.
const STAMP_LABEL = {
  '1st-edition': '1st Edition',
  'set-logo': 'Set Logo Stamp',
  'player-rewards-program': 'Play! Pokémon Stamp',
  prerelease: 'Prerelease Stamp',
  staff: 'Staff Stamp',
  'pokemon-center': 'Pokémon Center Stamp',
};

// Used only if no exchange rate could be downloaded.
export const FALLBACK_EUR_USD = 1.1;

const titleCase = (s) =>
  String(s)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b1st\b/i, '1st');

export function stampLabel(s) {
  return STAMP_LABEL[s] || `${titleCase(s)} Stamp`;
}

/** Human label for a TCGdex variants_detailed entry, e.g. "1st Edition Shadowless Holo", "Cosmos Holo", "Set Logo Stamp". */
export function variantLabel(v) {
  const parts = [];
  const stamps = v.stamp || [];
  if (stamps.includes('1st-edition')) parts.push('1st Edition');
  if (v.subtype && v.subtype !== 'unlimited') parts.push(titleCase(v.subtype));
  if (v.foil) parts.push(titleCase(v.foil));
  const otherStamps = stamps.filter((s) => s !== '1st-edition');
  // TCGdex files most stamped promos as "normal"; the stamp is what identifies them.
  if (!(v.type === 'normal' && otherStamps.length && !v.foil)) parts.push(TYPE_LABEL[v.type] || titleCase(v.type || 'Normal'));
  for (const s of otherStamps) parts.push(stampLabel(s));
  if (v.size && v.size !== 'standard') parts.push(`(${titleCase(v.size)})`);
  return parts.join(' ');
}

const META = new Set(['unit', 'updated']);

/** Pick the TCGplayer price block that matches this variant. */
function pickTcg(tcg, v) {
  if (!tcg) return null;
  const keys = Object.keys(tcg).filter((k) => !META.has(k) && tcg[k]);
  if (!keys.length) return null;
  const first = (v.stamp || []).includes('1st-edition');
  const wanted = {
    normal: first ? ['1st-edition-normal', '1st-edition', 'normal', 'unlimited-normal', 'unlimited'] : ['normal', 'unlimited-normal', 'unlimited'],
    holo: first ? ['1st-edition-holofoil', '1st-edition', 'holofoil', 'unlimited-holofoil'] : ['holofoil', 'unlimited-holofoil', 'holo'],
    reverse: ['reverse-holofoil', 'reverse'],
  }[v.type] || [];
  for (const k of wanted) if (tcg[k]) return { key: k, ...tcg[k], updated: tcg.updated };
  if (keys.length === 1) return { key: keys[0], ...tcg[keys[0]], updated: tcg.updated };
  return null;
}

/** Pick Cardmarket numbers (EUR); Cardmarket stores reverse holo prices in "-holo" fields. */
function pickCm(cm, v, card) {
  if (!cm) return null;
  const useHolo = v.type === 'reverse' && cm['avg-holo'] != null;
  const f = (k) => (useHolo ? cm[`${k}-holo`] : cm[k]);
  const out = { trend: f('trend'), avg: f('avg'), low: f('low'), avg7: f('avg7'), avg30: f('avg30'), idProduct: cm.idProduct, updated: cm.updated };
  // A holo-only card has no separate reverse price; don't invent one.
  if (v.type === 'reverse' && !useHolo && card?.variants?.normal) return null;
  return [out.trend, out.avg, out.low].some((x) => x != null && x > 0) ? out : null;
}

/**
 * Price rows for every printed version of a card.
 * Returns [{ id, label, type, foil, stamps, size, tcgProductId, cmProductId,
 *            tcg: {market,low,mid,high,directLow,productId,updated}|null (USD),
 *            cm: {trend,avg,low,avg7,avg30,idProduct,updated}|null (EUR) }]
 */
export function variantPrices(card) {
  const rows = [];
  const detailed = card.variants_detailed || [];
  if (detailed.length) {
    detailed.forEach((v, i) => {
      const tcg = pickTcg(v.pricing?.tcgplayer, v);
      const cm = pickCm(v.pricing?.cardmarket, v, card);
      rows.push({
        id: `${v.variantId || 'v'}-${i}`,
        label: variantLabel(v),
        type: v.type,
        foil: v.foil || null,
        stamps: v.stamp || [],
        size: v.size || 'standard',
        tcgProductId: v.thirdParty?.tcgplayer ?? tcg?.productId ?? null,
        cmProductId: v.thirdParty?.cardmarket ?? cm?.idProduct ?? null,
        tcg: tcg && normTcg(tcg),
        cm,
      });
    });
  } else if (card.pricing) {
    // Older response shape: one pricing block for the whole card.
    const tcg = card.pricing.tcgplayer;
    const keys = tcg ? Object.keys(tcg).filter((k) => !META.has(k) && tcg[k]) : [];
    for (const k of keys) {
      const type = k.includes('reverse') ? 'reverse' : k.includes('holo') ? 'holo' : 'normal';
      const v = { type, stamp: k.startsWith('1st') ? ['1st-edition'] : [] };
      rows.push({
        id: k,
        label: variantLabel(v),
        type,
        foil: null,
        stamps: v.stamp,
        size: 'standard',
        tcgProductId: tcg[k].productId ?? null,
        cmProductId: card.pricing.cardmarket?.idProduct ?? null,
        tcg: normTcg({ ...tcg[k], updated: tcg.updated }),
        cm: pickCm(card.pricing.cardmarket, v, card),
      });
    }
    if (!keys.length && card.pricing.cardmarket) {
      const v = { type: card.variants?.holo && !card.variants?.normal ? 'holo' : 'normal' };
      rows.push({ id: 'cm', label: variantLabel(v), type: v.type, foil: null, stamps: [], size: 'standard', tcgProductId: null, cmProductId: card.pricing.cardmarket.idProduct ?? null, tcg: null, cm: pickCm(card.pricing.cardmarket, v, card) });
    }
  }
  // Standard-size cards first; jumbo oversize promos last.
  return rows.sort((a, b) => (a.size === 'standard' ? 0 : 1) - (b.size === 'standard' ? 0 : 1));
}

function normTcg(t) {
  return {
    market: t.marketPrice ?? null,
    low: t.lowPrice ?? null,
    mid: t.midPrice ?? null,
    high: t.highPrice ?? null,
    directLow: t.directLowPrice ?? null,
    productId: t.productId ?? null,
    updated: t.updated ?? null,
  };
}

/** Convert a Cardmarket (EUR) number to USD. */
export function eurToUsd(value, eurUsd = FALLBACK_EUR_USD) {
  return value == null ? null : Math.round(value * eurUsd * 100) / 100;
}

/**
 * Best single value for a row, always in USD:
 * TCGplayer market, else Cardmarket trend converted from EUR.
 * Returns { value, currency: 'USD', source, converted, original?: { value, currency: 'EUR' } } or null.
 */
export function headlinePrice(row, eurUsd = FALLBACK_EUR_USD) {
  if (!row) return null;
  const usd = row.tcg?.market ?? row.tcg?.mid ?? row.tcg?.low;
  if (usd != null) return { value: usd, currency: 'USD', source: 'TCGplayer market', converted: false };
  const eur = row.cm?.trend || row.cm?.avg || row.cm?.low;
  if (eur != null) {
    return { value: eurToUsd(eur, eurUsd), currency: 'USD', source: 'Cardmarket trend', converted: true, original: { value: eur, currency: 'EUR' } };
  }
  return null;
}

/** Bring a stored price (possibly saved in EUR by an older version) to USD. */
export function priceInUsd(price, eurUsd = FALLBACK_EUR_USD) {
  if (!price || price.value == null) return null;
  if (price.currency === 'EUR') return eurToUsd(price.value, eurUsd);
  return price.value;
}

export function formatMoney(value, currency = 'USD') {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

/**
 * Collector number the way it's printed on the card: "024/088", "125/197", "4/102", "TG05".
 * Modern cards pad the set size to the same width as the card number.
 */
export function printedNumber(card) {
  const official = card?.set?.cardCount?.official ?? card?.official;
  const id = String(card?.localId ?? card?.number ?? '');
  if (!/^\d+$/.test(id) || !official) return id;
  return `${id}/${String(official).padStart(id.length, '0')}`;
}

/** Marketplace photo of this exact printing (stamped/cosmos versions differ), else the TCGdex scan. */
export function variantImage(card, row) {
  if (row?.tcgProductId) return { src: `https://tcgplayer-cdn.tcgplayer.com/product/${row.tcgProductId}_in_1000x1000.jpg`, source: 'tcgplayer' };
  if (card?.image) return { src: `${card.image}/high.webp`, source: 'tcgdex' };
  return null;
}

/** Search query used for eBay / PriceCharting: "Charizard ex 125/197 Obsidian Flames". */
export function searchQuery(card, row) {
  const extras = [];
  if (row?.stamps?.includes('1st-edition')) extras.push('1st Edition');
  if (row?.foil) extras.push(titleCase(row.foil));
  if (row?.type === 'reverse') extras.push('Reverse Holo');
  if (row?.stamps?.some((s) => s !== '1st-edition')) extras.push('Stamped');
  return [card.name, printedNumber(card), card.set?.name, ...extras].filter(Boolean).join(' ');
}

export function marketLinks(card, row) {
  const q = searchQuery(card, row);
  const enc = encodeURIComponent;
  const tcgId = row?.tcgProductId;
  return {
    tcgplayer: tcgId
      ? `https://www.tcgplayer.com/product/${tcgId}`
      : `https://www.tcgplayer.com/search/pokemon/product?productLineName=pokemon&q=${enc(`${card.name} ${card.set?.name || ''}`)}`,
    ebaySold: `https://www.ebay.com/sch/i.html?_nkw=${enc(q)}&LH_Sold=1&LH_Complete=1&_sop=13`,
    ebayActive: `https://www.ebay.com/sch/i.html?_nkw=${enc(q)}&_sop=15`,
    cardmarket: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${enc(card.name)}`,
    pricecharting: `https://www.pricecharting.com/search-products?type=prices&q=${enc(q)}`,
  };
}
