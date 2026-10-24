// Offline support, and quick starts on a bad connection. Three kinds of files from this site:
//  - Big files under models/, vendor/ and data/ (the text-recognition models and runtime, the
//    card details). Their names carry a version and never change once published (a new
//    version gets a new name), so once downloaded they are served straight from their own
//    cache, which app updates never empty. They download in the background once the app is
//    open (see syncAssets: retried, and checked against the size and hash that js/assets.js
//    in the saved shell lists before they are kept); saved ones no longer listed are deleted.
//    Installing the service worker never waits for them.
//  - The app shell (SHELL: the page, scripts, styles, icons), kept as one complete copy of
//    one version so a page never runs a mix of old and new scripts. Each start checks for a
//    newer version, for up to SHELL_WAIT: on a slow or flaky connection the saved copy opens
//    instead, and the newer one is used from a later start, once the big files it lists are
//    saved too (that start may have no connection); the page then offers to reload.
//  - Anything else: the network first (for up to SHELL_WAIT), else the last copy saved.
// Requests to other sites (TCGdex card data and pictures, exchange rates, the OCR library on
// its CDN) are left to the browser, as before: the app caches their data itself.
const SHELL = [
  'index.html', 'manifest.webmanifest',
  'css/styles.css', 'css/batch.css', 'css/trade.css',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/api.js', 'js/app.js', 'js/assets.js', 'js/backup.js', 'js/batch.js', 'js/catalog.js', 'js/collection.js', 'js/components.js',
  'js/details.js', 'js/detect.js', 'js/entry.js', 'js/fx.js', 'js/identify.js', 'js/match.js', 'js/ocr.js', 'js/ocr-tesseract.js',
  'js/ocr-worker.js', 'js/offline.js', 'js/parse.js', 'js/ppocr.js', 'js/prices.js', 'js/rerank.js', 'js/setcodes.js', 'js/setpicker.js',
  'js/sheet.js', 'js/stamps.js', 'js/trade.js', 'js/ui.js',
];
const SHELL_WAIT = 2000; // ms a start waits for the network before opening the saved copy
const CHECK_LIMIT = 30 * 1000; // ms a check for a newer shell may take in the background at most
const ASSET_DIRS = ['models/', 'vendor/', 'data/'];
const ASSET_TRIES = 3;
const ASSET_LIMIT = 5 * 60 * 1000; // ms one download of a big file may take at most (a stalled connection)
const ASSET_CACHE = 'card-scanner-assets'; // never deleted by an update
const SHELL_CACHE = 'card-scanner-shell-'; // + a time: one complete copy of the shell each
const FILE_CACHE = 'card-scanner-files'; // anything else from this site
const META_CACHE = 'card-scanner-meta'; // which shell copy is in use; the app's lists of big files
const BASE = self.registration.scope; // the app's folder, ending in "/"
const LATE = Symbol('late');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * fetch that gives up after ms (a connection that stalls would otherwise hold things up for
 * good), or when `stop` (an AbortController) is aborted. Resolves to { res, body }.
 */
async function fetchWithin(ms, url, opts = {}, stop = new AbortController()) {
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: stop.signal });
    return { res, body: await res.arrayBuffer() };
  } finally {
    clearTimeout(timer);
  }
}
/** Path of a URL inside the app ("js/app.js", "" for the app's folder), or null for another site. */
const pathOf = (url) => (url.startsWith(BASE) ? url.slice(BASE.length).split(/[?#]/)[0] : null);
const isAsset = (path) => ASSET_DIRS.some((d) => path.startsWith(d));
const sameBytes = (a, b) => {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};
/** Headers worth keeping with a saved copy (the body is saved decompressed). */
const keepHeaders = (h) => {
  const out = new Headers();
  for (const k of ['content-type', 'last-modified', 'etag']) if (h.get(k)) out.set(k, h.get(k));
  return out;
};

// ---------- small saved state (META_CACHE) ----------
const mem = {};
async function meta(key, value) {
  const c = await caches.open(META_CACHE);
  if (value === undefined) {
    if (!(key in mem)) mem[key] = await c.match(`${BASE}__${key}`).then((r) => (r ? r.json() : null), () => null);
    return mem[key];
  }
  mem[key] = value;
  await c.put(`${BASE}__${key}`, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
}
/** { live: shell copy in use, next: a newer complete copy to switch to at the next start }. */
const shellState = async () => (await meta('shell')) || { live: null, next: null };
/** The same, read from storage: another instance of this worker (an update) may have moved on. */
const freshShellState = () => {
  delete mem.shell;
  return shellState();
};

async function tellPages(msg) {
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage(msg);
}

// ---------- the app shell ----------

let checking = null; // { run, started, stop }: the check under way
/**
 * Download the whole shell from the server (checking with it even if the browser has a copy).
 * Resolves to the name of a new complete shell copy if anything changed since the one in use,
 * null if nothing did (or a newer check took over); rejects if any file can't be had (the copy
 * in use stays). A start joins a check begun moments ago; an older one is stopped and replaced,
 * so a check that began before a new version was published can't hide or undo it.
 */
function checkShell() {
  if (checking && Date.now() - checking.started < SHELL_WAIT) return checking.run;
  checking?.stop.abort();
  const me = { started: Date.now(), stop: new AbortController() };
  const current = () => checking === me;
  me.run = (async () => {
    const files = await Promise.all(
      SHELL.map(async (path) => {
        const { res, body } = await fetchWithin(CHECK_LIMIT, BASE + path, { cache: 'no-cache' }, me.stop);
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return { path, body, headers: keepHeaders(res.headers) };
      }),
    );
    if (!current()) return null;
    const live = await liveShell();
    if (live) {
      const c = await caches.open(live);
      let same = true;
      for (const f of files) {
        const old = await c.match(BASE + f.path);
        if (!old || !sameBytes(await old.arrayBuffer(), f.body)) {
          same = false;
          break;
        }
      }
      if (same || !current()) return null;
    }
    const name = SHELL_CACHE + Date.now();
    const c = await caches.open(name);
    await Promise.all(files.map((f) => c.put(BASE + f.path, new Response(f.body, { headers: f.headers }))));
    await c.put(`${BASE}__complete`, new Response('1')); // last: a copy cut short isn't used
    if (current()) return name;
    await caches.delete(name);
    return null;
  })().finally(() => current() && (checking = null));
  checking = me;
  return me.run;
}

const isComplete = async (name) => !!name && (await caches.has(name)) && !!(await (await caches.open(name)).match(`${BASE}__complete`));
/** When a shell copy was made (from its name), 0 for none. */
const madeAt = (name) => (name ? +name.slice(SHELL_CACHE.length) || 0 : 0);

// The shell copy in use only ever moves to a newer one: two instances of this worker (during
// an update) or two checks that cross can't bring back an older copy or lose the newest.

/** Start using a shell copy, unless a newer one is in use already; delete older copies. */
async function useShell(name) {
  const s = await freshShellState();
  if (madeAt(s.live) > madeAt(name)) return;
  await meta('shell', { live: name, next: madeAt(s.next) > madeAt(name) ? s.next : null });
  for (const k of await caches.keys()) {
    if (!k.startsWith(SHELL_CACHE) || k === name) continue;
    // Older copies go; so do newer ones a check left unfinished.
    if (madeAt(k) < madeAt(name) || (Date.now() - madeAt(k) > CHECK_LIMIT && !(await isComplete(k)))) await caches.delete(k);
  }
}

/**
 * Keep a newer complete shell copy for the next start (used once the big files it lists are
 * saved too, see openApp and prepareNext). Returns false if it isn't the newest.
 */
async function keepForNext(name) {
  const s = await freshShellState();
  if (madeAt(name) <= Math.max(madeAt(s.live), madeAt(s.next))) return false;
  await meta('shell', { ...s, next: name });
  return true;
}

/** Download the big files a shell copy kept for the next start lists; once all are saved, the page offers to reload. */
async function prepareNext(name) {
  if (await saveAssets(await shellAssets(name))) await tellPages({ type: 'update-ready' });
}

/** The shell copy in use. If it's gone (storage cleared), the newest complete copy takes over. */
async function liveShell() {
  const { live } = await shellState();
  if (live && (await caches.has(live))) return live;
  const copies = (await caches.keys()).filter((k) => k.startsWith(SHELL_CACHE)).sort((a, b) => madeAt(b) - madeAt(a));
  for (const k of copies) {
    if (await isComplete(k)) {
      await meta('shell', { live: k, next: null });
      return k;
    }
  }
  return null;
}

async function fromShell(path) {
  const live = await liveShell();
  return live ? (await caches.open(live)).match(BASE + path) : undefined;
}

/**
 * Opening the app: the newest shell if it can be had within SHELL_WAIT, else the saved one.
 * Returns { response, background } (background: the check still going on).
 */
async function openApp(e) {
  const s = await freshShellState();
  // A newer version came in after the last start: used once the big files it lists are saved
  // too (this start may have no connection). Until then the copy in use opens.
  if (s.next && !(await isComplete(s.next))) await meta('shell', { ...s, next: null });
  else if (await nextReady(s)) await useShell(s.next);
  const saved = await fromShell('index.html');
  if (!saved) return { response: await network(e.request) }; // first visit, or the saved copy was cleared
  if (self.navigator.onLine === false) return { response: saved };
  let late = false;
  const check = checkShell().then(async (name) => {
    // Too late for this start: kept for a later one, which uses it once its big files are
    // saved; they download now (in the background: this start has opened the saved copy).
    if (name && late && (await keepForNext(name))) await prepareNext(name).catch(() => {});
    return name;
  });
  const background = check.catch(() => {});
  const name = await Promise.race([check, sleep(SHELL_WAIT).then(() => ((late = true), LATE))]).catch(() => null);
  if (name && name !== LATE) {
    await useShell(name);
    return { response: (await fromShell('index.html')) || saved, background };
  }
  return { response: saved, background };
}

// ---------- other files from this site ----------

/** The network for up to SHELL_WAIT, else the last saved copy; nothing saved: wait for the network. */
async function network(req) {
  const net = fetch(req).then((res) => {
    if (res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      caches.open(FILE_CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
  const quick = await Promise.race([net.catch(() => null), sleep(SHELL_WAIT).then(() => null)]);
  if (quick) return quick;
  return (await (await caches.open(FILE_CACHE)).match(req, { ignoreSearch: true })) || net;
}

// ---------- big files (models/, vendor/, data/) ----------

/**
 * The big files a shell copy lists (its js/assets.js: path -> { bytes, integrity, lazy }), or
 * null: the copy in use, or the one named.
 */
async function shellAssets(name) {
  const res = name ? await caches.open(name).then((c) => c.match(`${BASE}js/assets.js`)) : await fromShell('js/assets.js');
  if (!res) return null;
  try {
    const text = await res.text();
    const at = text.indexOf('ASSETS = ');
    return JSON.parse(text.slice(at + 'ASSETS = '.length, text.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

/**
 * The lists of big files: { current, previous } (path -> { bytes, integrity, lazy }). current is
 * the saved shell's; previous, the one before it (a page of that version may still be open).
 */
async function assetLists() {
  const lists = (await meta('assets')) || { current: {}, previous: {} };
  const list = await shellAssets();
  if (!list || JSON.stringify(list) === JSON.stringify(lists.current)) return lists;
  const next = { current: list, previous: lists.current };
  await meta('assets', next);
  return next;
}

/** Are all the big files of a list (path -> { bytes, integrity, lazy }) saved, lazy ones aside? */
async function allSaved(list) {
  const cache = await caches.open(ASSET_CACHE);
  for (const path of Object.keys(list || {})) if (!list[path].lazy && !(await cache.match(BASE + path))) return false;
  return true;
}

/** A newer shell copy kept for the next start (state s) is complete and its big files are saved. */
async function nextReady(s) {
  return !!s.next && (await isComplete(s.next)) && allSaved(await shellAssets(s.next));
}

/**
 * Download the big files of a list (path -> { bytes, integrity, lazy }) that aren't saved yet,
 * one at a time (lazy ones only when asked for). Resolves to true once they all are saved.
 */
async function saveAssets(list) {
  if (!list) return true;
  const cache = await caches.open(ASSET_CACHE);
  for (const [path, a] of Object.entries(list)) {
    // Checked just before: the page may have had it downloaded meanwhile.
    if (a.lazy || unsaved.has(path) || (await cache.match(BASE + path))) continue;
    await download(path, a).catch(() => {}); // tried again at the next start
  }
  return allSaved(list);
}

async function sha256(body) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  let s = '';
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s);
}

/** Why a download isn't the file listed (null if it is): its size and SHA-256 must match. */
async function badDownload(body, want, res) {
  if (want.bytes != null && body.byteLength !== want.bytes) return `${body.byteLength} bytes, not ${want.bytes}`;
  const sri = /sha256-([A-Za-z0-9+/=]+)/.exec(want.integrity || '');
  if (sri && (await sha256(body)) !== sri[1]) return 'hash differs';
  // Not listed (yet): at least the whole file came, when the server said how big it is.
  const len = res.headers.get('content-length');
  if (!sri && want.bytes == null && len && !res.headers.get('content-encoding') && +len !== body.byteLength) return 'cut short';
  return null;
}

const loading = new Map(); // path -> download in progress, shared by the page and syncAssets
// Files that downloaded fine but couldn't be saved (storage full): not tried again while this
// service worker runs (a page asking for one still gets it, downloaded each time).
const unsaved = new Set();
/**
 * Download a big file, retried, and keep it once checked against `want` ({ bytes, integrity }:
 * by default what the shell in use lists). Resolves to { status, body, headers }.
 */
function download(path, want) {
  if (!loading.has(path)) loading.set(path, fetchAsset(path, want).finally(() => loading.delete(path)));
  return loading.get(path);
}

async function fetchAsset(path, want) {
  want ||= (await assetLists()).current[path] || {};
  let got = null;
  let error = null;
  for (let i = 0; i < ASSET_TRIES; i++) {
    if (i) await sleep(1000 * 2 ** (i - 1));
    try {
      // A retry skips the browser's own copy, in case that is what is broken.
      const { res, body } = await fetchWithin(ASSET_LIMIT, BASE + path, { cache: i ? 'reload' : 'default' });
      if (res.status === 404 || res.status === 410) return { status: res.status, body: null, headers: keepHeaders(res.headers) };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      got = { status: 200, body, headers: keepHeaders(res.headers) };
      const bad = await badDownload(body, want, res);
      if (bad) {
        error = new Error(`${path}: ${bad}`);
        continue;
      }
      // The right file: passed on even if it can't be kept (no need to download it again now).
      await (await caches.open(ASSET_CACHE)).put(BASE + path, new Response(body, { headers: got.headers })).catch((e) => {
        unsaved.add(path);
        console.warn(`could not save ${path}:`, e?.message || e);
      });
      return got;
    } catch (e) {
      error = e;
    }
  }
  console.warn('download failed:', error?.message || error);
  // The server keeps sending something other than the file listed: pass it on, never keep it.
  if (got) return got;
  throw error;
}

async function asset(req, path) {
  const hit = await (await caches.open(ASSET_CACHE)).match(BASE + path);
  if (hit) return hit;
  const listed = (await assetLists()).current[path] || {};
  const f = await download(path, { ...listed, ...(req.integrity && { integrity: req.integrity }) });
  return new Response(f.body, { status: f.status, headers: f.headers });
}

/**
 * Once the app is open (the page asks): download the big files the saved shell lists that
 * aren't saved yet, in the background and one at a time (lazy ones only when asked for), then
 * those of a newer version kept for the next start, and delete saved ones that neither these
 * lists nor the one before have. Answers the page { type: 'assets', missing: [paths of the
 * version in use still not saved], updateReady (the next start opens a newer version) }.
 */
async function syncAssets(client) {
  if (!(await shellAssets())) return; // no list to go by: delete nothing, download nothing
  const { current, previous } = await assetLists();
  const s = await freshShellState();
  const next = (s.next && (await shellAssets(s.next))) || {};
  const cache = await caches.open(ASSET_CACHE);
  for (const req of await cache.keys()) {
    const path = pathOf(req.url);
    if (path == null || !(path in current || path in previous || path in next)) await cache.delete(req);
  }
  await saveAssets(current);
  const now = new Set((await cache.keys()).map((r) => pathOf(r.url)));
  const missing = Object.keys(current).filter((p) => !current[p].lazy && !now.has(p));
  if (s.next) await saveAssets(next);
  client?.postMessage({ type: 'assets', missing, updateReady: await nextReady(await freshShellState()) });
}

// ---------- events ----------

self.addEventListener('install', (e) => {
  // Only the shell (a few hundred KB); the big files download later, in the background.
  e.waitUntil(
    (async () => {
      const name = await checkShell();
      if (name) {
        if (await isComplete((await freshShellState()).live)) await keepForNext(name);
        else await useShell(name); // first install (or the saved copy is gone)
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const s = await freshShellState();
      // Older versions of this service worker kept a single cache ('card-scanner-v4'); shell
      // copies older than the one in use are left over. The big files stay.
      for (const k of await caches.keys()) {
        if (/^card-scanner-v\d+$/.test(k) || (k.startsWith(SHELL_CACHE) && s.live && madeAt(k) < madeAt(s.live))) await caches.delete(k);
      }
      await self.clients.claim();
      // A newer version kept for the next start (install): its big files download now, without
      // holding up this activation (a page's requests wait for it); then the page offers to
      // reload. Should this be cut short, syncAssets downloads them at the next start.
      if (s.next) prepareNext(s.next).catch(() => {});
    })(),
  );
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'assets') e.waitUntil(syncAssets(e.source));
  // The page came back after a long time: look for a newer shell now, used from a later start
  // once its big files are saved (prepareNext downloads them, then offers to reload).
  if (e.data?.type === 'check') {
    e.waitUntil(
      checkShell()
        .then(async (name) => name && (await keepForNext(name)) && (await prepareNext(name)))
        .catch(() => {}),
    );
  }
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const path = req.method === 'GET' && !req.headers.has('range') ? pathOf(req.url) : null;
  if (path == null) return; // another site, or not a plain download: the browser handles it
  if (req.mode === 'navigate' && (path === '' || path === 'index.html')) {
    const opened = openApp(e);
    // Should anything here fail or stall, any saved copy of the page, else the network:
    // the app must never be left blank.
    const rescue = async () => (await caches.match(`${BASE}index.html`)) || fetch(req);
    e.respondWith(Promise.race([opened.then((o) => o.response), sleep(SHELL_WAIT + 3000).then(rescue)]).catch(rescue));
    e.waitUntil(opened.then((o) => o.background).catch(() => {}));
    return;
  }
  if (isAsset(path)) {
    e.respondWith(asset(req, path));
    return;
  }
  e.respondWith(fromShell(path).then((hit) => hit || network(req), () => network(req)));
});
