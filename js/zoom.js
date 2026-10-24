// Zoom: the page itself never zooms (iOS would on a pinch or double-tap, leaving the app half
// zoomed in); a card picture opens full screen instead, where a pinch or double-tap zooms the
// picture and a drag moves it around.
import { el } from './ui.js';

const MAX_SCALE = 5; // furthest zoom in, × the picture's full-screen size
const TAP_SCALE = 2.5; // a double tap zooms this far, on the spot tapped
const DOUBLE_TAP = 300; // ms between two taps for a double tap
const TAP_SLOP = 10; // px a finger may move and still count as a tap

/** Stop pinch zoom on the page. Double-tap zoom is off in the CSS (touch-action), focus zoom in the viewport tag. */
export function blockPageZoom() {
  // Safari's own pinch events: cancelling them keeps the page at its size (they don't stop the viewer's pointer events).
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1 && !e.target.closest?.('.zoom')) e.preventDefault();
    },
    { passive: false },
  );
}

/** Make an <img> open full screen when tapped (its current picture, so a fallback shows too). */
export function zoomable(img) {
  img.classList.add('zoomable');
  img.addEventListener('click', () => openZoom(img.currentSrc || img.src, img.alt));
  return img;
}

/** Show a picture full screen. Closes with ✕, a tap beside the picture or Escape. */
export function openZoom(src, alt = '') {
  if (!src) return null;
  const img = el('img', { class: 'zoom-img', src, alt, draggable: 'false' });
  const wrap = el(
    'div',
    { class: 'zoom', role: 'dialog', 'aria-modal': 'true', 'aria-label': alt || 'Picture' },
    img,
    el('button', { class: 'zoom-close', type: 'button', 'aria-label': 'Close', onclick: () => close() }, '✕'),
    el('p', { class: 'zoom-hint' }, 'Pinch or double-tap to zoom'),
  );

  // The picture is drawn at (centre + t) scaled by s; pointers holds each finger's position.
  let s = 1;
  let t = { x: 0, y: 0 };
  let start = null; // the gesture so far: { s, t, mid, dist }
  let lastTap = null; // { at, x, y }
  let pinched = false; // two fingers were down during this touch: not a tap
  const pointers = new Map();

  const centre = () => ({ x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 });
  // The picture's size on screen at s = 1 (fitted inside, like object-fit: contain).
  const fitted = () => {
    const fit = Math.min(wrap.clientWidth / (img.naturalWidth || 1), wrap.clientHeight / (img.naturalHeight || 1));
    return { w: (img.naturalWidth || 0) * fit, h: (img.naturalHeight || 0) * fit };
  };
  // Keep the picture over the screen: it can't be dragged further than its own edges.
  const clamp = () => {
    const f = fitted();
    const maxX = Math.max(0, (f.w * s - wrap.clientWidth) / 2);
    const maxY = Math.max(0, (f.h * s - wrap.clientHeight) / 2);
    t = { x: Math.min(maxX, Math.max(-maxX, t.x)), y: Math.min(maxY, Math.max(-maxY, t.y)) };
  };
  const onPicture = (at) => {
    const c = centre();
    const f = fitted();
    return Math.abs(at.x - c.x - t.x) <= (f.w * s) / 2 && Math.abs(at.y - c.y - t.y) <= (f.h * s) / 2;
  };
  const draw = (animate = false) => {
    clamp();
    img.style.transition = animate ? 'transform .2s ease-out' : '';
    img.style.transform = `translate(${t.x}px, ${t.y}px) scale(${s})`;
    wrap.classList.toggle('zoomed', s > 1);
  };
  // Zoom to `to`, keeping the picture's point that was under `from` (screen px) under `at`.
  const zoomAbout = (base, from, at, to) => {
    const c = centre();
    s = Math.min(MAX_SCALE, Math.max(1, to));
    t = {
      x: at.x - c.x - (s * (from.x - c.x - base.t.x)) / base.s,
      y: at.y - c.y - (s * (from.y - c.y - base.t.y)) / base.s,
    };
  };
  const gesture = () => {
    const ps = [...pointers.values()];
    const mid = ps.length > 1 ? { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 } : { ...ps[0] };
    const dist = ps.length > 1 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0;
    return { s, t: { ...t }, mid, dist };
  };

  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.zoom-close')) return;
    try {
      wrap.setPointerCapture(e.pointerId); // keeps a drag going when the finger leaves the picture
    } catch {
      // not a live pointer (already lifted): nothing to capture
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, at: e.timeStamp });
    if (pointers.size > 1) pinched = true;
    start = gesture();
  });
  wrap.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const now = gesture();
    if (pointers.size > 1 && start.dist) zoomAbout(start, start.mid, now.mid, (start.s * now.dist) / start.dist);
    else if (s > 1) t = { x: start.t.x + now.mid.x - start.mid.x, y: start.t.y + now.mid.y - start.mid.y };
    draw();
  });
  const lift = (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    pointers.delete(e.pointerId);
    const tap = e.type === 'pointerup' && !pointers.size && !pinched && Math.hypot(p.x - p.x0, p.y - p.y0) < TAP_SLOP;
    if (pointers.size) start = gesture(); // one finger left: it carries on dragging from here
    else pinched = false;
    if (!tap) {
      lastTap = null;
      return;
    }
    const at = { x: p.x, y: p.y };
    if (lastTap && e.timeStamp - lastTap.at < DOUBLE_TAP && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < TAP_SLOP * 3) {
      lastTap = null;
      if (s > 1) {
        s = 1;
        t = { x: 0, y: 0 };
      } else zoomAbout({ s, t }, at, at, TAP_SCALE);
      draw(true);
      return;
    }
    lastTap = { at: e.timeStamp, ...at };
    if (!onPicture(at)) close(); // a tap beside the picture
  };
  wrap.addEventListener('pointerup', lift);
  wrap.addEventListener('pointercancel', lift);

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation(); // only the viewer closes, not the sheet or dialog under it
    close();
  };
  function close() {
    wrap.remove();
    window.removeEventListener('keydown', onKey, true);
  }
  window.addEventListener('keydown', onKey, true);
  document.body.append(wrap);
  return { close };
}
