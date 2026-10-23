// Daily EUR -> USD rate so Cardmarket prices can be shown in dollars.
// Free sources, no key, CORS-enabled; cached on the device for 12 hours.
import { kvGet, kvSet } from './api.js';
import { FALLBACK_EUR_USD } from './prices.js';

const SOURCES = [
  ['https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD', (j) => [j.rates?.USD, j.date]],
  ['https://open.er-api.com/v6/latest/EUR', (j) => [j.rates?.USD, j.time_last_update_utc]],
];
const MAX_AGE = 12 * 3600 * 1000;

let info = { rate: FALLBACK_EUR_USD, date: null, fallback: true };

/** Current rate info: { rate, date, fallback }. Synchronous; call loadRate() once at startup. */
export function fx() {
  return info;
}

export async function loadRate() {
  const cached = await kvGet('fx');
  if (cached?.rate) info = { rate: cached.rate, date: cached.date, fallback: false };
  if (cached?.rate && Date.now() - cached.t < MAX_AGE) return info;
  for (const [url, read] of SOURCES) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const [rate, date] = read(await res.json());
      if (typeof rate === 'number' && rate > 0.5 && rate < 2) {
        info = { rate, date: date || null, fallback: false };
        kvSet('fx', { rate, date: info.date, t: Date.now() });
        return info;
      }
    } catch {
      /* try the next source */
    }
  }
  return info;
}
