// "Batch" tab: take many photos now, identify them later.
// PLACEHOLDER — full implementation pending. Public API (used by app.js):
//   initBatch()                 once at start-up
//   renderBatch()               draw #view-batch
//   enqueueCanvas(canvas)       save a cropped camera frame (Promise)
//   enqueueFiles(files)         save picked photos (Promise)
//   batchCount()                number of saved photos (sync)
// Emits 'batch:changed' when the queue changes.
import { $, el, emit } from './ui.js';

const queue = [];

export function initBatch() {}

export function batchCount() {
  return queue.length;
}

export async function enqueueCanvas(canvas) {
  queue.push({ canvas });
  emit('batch:changed', {});
}

export async function enqueueFiles(files) {
  for (const f of files) queue.push({ file: f });
  emit('batch:changed', {});
}

export function renderBatch() {
  $('#view-batch').replaceChildren(el('p', { class: 'muted' }, `${queue.length} photos saved.`));
}
