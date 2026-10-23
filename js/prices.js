// Turns a full TCGdex card into per-variant price rows plus marketplace links.

const TYPE_LABEL = { normal: 'Normal', holo: 'Holo', reverse: 'Reverse Holo' };

const titleCase = (s) =>
  String(s)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\b1st\b/i, '1st');

/** Human label for a TCGdex variants_detailed entry. */
export function variantLabel(v) {
  const parts = [];
  const stamps = v.stamp || [];
  if (stamps.includes('1st-edition')) parts.push('1st Edition');
  if (v.subtype && v.subtype !== 'unlimited') parts.push(titleCase(v.subtype));
  parts.push(TYPE_LABEL[v.type] || titleCase(v.type || 'Normal'));
  for (const s of stamps) if (s !== '1st-edition') parts.push(`${titleCase(s)} stamp`);
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

/** Pick Cardmarket numbers; Cardmarket stores reverse holo prices in "-holo" fields. */
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
 * Price rows for every printed variant of a card.
 * Returns [{ id, label, type, stamps, size, tcg: {market,low,mid,high,directLow,productId,updated}|null, cm: {...}|null }]
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
      rows.push({ id: 'cm', label: variantLabel(v), type: v.type, stamps: [], size: 'standard', tcgProductId: null, cmProductId: card.pricing.cardmarket.idProduct ?? null, tcg: null, cm: pickCm(card.pricing.cardmarket, v, card) });
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

/** Best single headline value for a row: TCGplayer market (USD), else Cardmarket trend (EUR). */
export function headlinePrice(row) {
  if (!row) return null;
  const usd = row.tcg?.market ?? row.tcg?.mid ?? row.tcg?.low;
  if (usd != null) return { value: usd, currency: 'USD', source: 'TCGplayer market' };
  const eur = row.cm?.trend || row.cm?.avg || row.cm?.low;
  if (eur != null) return { value: eur, currency: 'EUR', source: 'Cardmarket trend' };
  return null;
}

export function formatMoney(value, currency = 'USD') {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

/** Search query used for eBay / PriceCharting: "Charizard ex 125/197 Obsidian Flames". */
export function searchQuery(card, row) {
  const official = card.set?.cardCount?.official;
  const num = /^\d+$/.test(card.localId) && official ? `${card.localId}/${String(official).padStart(String(card.localId).length, '0')}` : card.localId;
  const extras = [];
  if (row?.stamps?.includes('1st-edition')) extras.push('1st Edition');
  if (row?.type === 'reverse') extras.push('Reverse Holo');
  return [card.name, num, card.set?.name, ...extras].filter(Boolean).join(' ');
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
