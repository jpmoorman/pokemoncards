// Offline support, the page's side (the service worker is sw.js): register it, have it
// download the big files (js/assets.js) once the app is up, and offer to reload when a newer
// version of the app has come in (it is used from the next start otherwise).
import { on, toast, actionToast } from './ui.js';

const ASSETS_AFTER = 10000; // ms: start the downloads even if the card list never comes (offline first start)
const CHECK_AFTER = 30 * 60 * 1000; // back in the app after this long: look for a newer version
const READY_KEY = 'offline-ready.v1'; // set once "Ready to scan without a connection" was shown

export function startOffline() {
  // Service workers need HTTPS; the offline test (tests/e2e-offline.mjs) sets the flag on http://localhost.
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || window.SERVICE_WORKER_ON_HTTP)) return;
  const sw = navigator.serviceWorker;
  sw.register('sw.js').catch((e) => console.warn('service worker:', e.message || e));
  sw.addEventListener('message', (e) => {
    if (e.data?.type === 'update-ready' || e.data?.updateReady) offerReload();
    // Every big file saved (models, card details): scans work with no connection now.
    if (e.data?.type === 'assets' && e.data.missing?.length === 0) readyOffline();
  });
  // The big files download in the background once the card list is in: on a first visit the
  // card list downloads first.
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    sw.ready.then((reg) => reg.active?.postMessage({ type: 'assets' }));
  };
  on('catalog:ready', send);
  setTimeout(send, ASSETS_AFTER);
  // A phone keeps a Home Screen app open for days: coming back to it, look for a newer version.
  let checked = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || Date.now() - checked < CHECK_AFTER) return;
    checked = Date.now();
    sw.ready.then((reg) => {
      reg.update().catch(() => {});
      reg.active?.postMessage({ type: 'check' });
    });
  });
}

/** Say once (for good) that the app can now scan without a connection. */
function readyOffline() {
  try {
    if (localStorage.getItem(READY_KEY)) return;
    localStorage.setItem(READY_KEY, 'done');
  } catch {
    return; // no storage: it would say so at every start
  }
  toast('Ready to scan without a connection', 3500);
}

let offered = false;
function offerReload() {
  if (offered) return;
  offered = true;
  actionToast('A new version of the app is ready', 'Reload', () => location.reload(), { ms: 12000 });
}
