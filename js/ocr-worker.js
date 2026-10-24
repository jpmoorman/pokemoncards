// Text reading off the page: a module worker that owns the ONNX runtime (onnxruntime-web,
// WebAssembly, one thread: no cross-origin isolation needed) and the PP-OCR models, and reads
// areas of the pictures ocr.js sends it (see ppocr.js). One read at a time, in the order asked.
//   { id, type: 'init' }                          -> { id, ok: { ms } }       (loads everything)
//   { id, type: 'read', image, areas }            -> { id, ok: [{ lines, ms }] }
//   { id, type: 'stats' }                         -> { id, ok: { wasmBytes } }
// `image` is { width, height, data } (RGBA, its buffer handed over), `areas` see ppocr.read.
// A job that fails answers { id, error, stage }: stage 'download' (a file didn't come) or
// 'runtime' (it can't run here, e.g. out of memory).
// While loading it posts { progress: 0..1 } (first time only: later the files come from the
// browser's cache), then { loaded: true } once every file is in.
import { createReader, parseDict } from './ppocr.js';
import { ASSETS } from './assets.js';

// Versioned paths: a new version gets a new folder, so cached copies never go stale.
const ORT_DIR = 'vendor/onnxruntime-web-1.30.0/';
const MODEL_DIR = 'models/ppocr-v6tiny-1/';
// File sizes from the list of big files (js/assets.js), for the loading progress
// (decompressed bytes as they arrive).
const FILES = [
  `${ORT_DIR}ort-wasm-simd-threaded.wasm`,
  `${ORT_DIR}ort.wasm.bundle.min.mjs`,
  `${MODEL_DIR}det.onnx`,
  `${MODEL_DIR}rec.onnx`,
  `${MODEL_DIR}dict.txt`,
].map((p) => ({ url: new URL(`../${p}`, import.meta.url), bytes: ASSETS[p]?.bytes || 0 }));

// The runtime's WebAssembly memory, for the memory figure in `stats` (it only grows: the
// page stops this worker when idle to give it back).
let memory = null;
for (const k of ['instantiate', 'instantiateStreaming']) {
  const f = WebAssembly[k];
  if (!f) continue;
  WebAssembly[k] = async (...args) => {
    const res = await f.apply(WebAssembly, args);
    const inst = res.instance || res;
    // Exported, or (this build) made by its JavaScript and handed in.
    const found = [...Object.values(inst.exports || {}), ...Object.values(args[1] || {}).flatMap((m) => Object.values(m || {}))];
    memory ||= found.find((e) => e instanceof WebAssembly.Memory) || null;
    return res;
  };
}

async function download(files) {
  const total = files.reduce((s, f) => s + f.bytes, 0);
  let got = 0;
  let shown = 0;
  return Promise.all(
    files.map(async (f) => {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`${f.url.pathname}: HTTP ${res.status}`);
      if (!res.body?.getReader) return new Uint8Array(await res.arrayBuffer());
      const parts = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        const p = Math.min(0.99, got / total);
        if (p - shown >= 0.02) postMessage({ progress: (shown = p) });
      }
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return out;
    }),
  );
}

let ready = null;
function init() {
  ready ||= (async () => {
    const t0 = performance.now();
    // Everything is fetched first (the runtime's module too: imported below, it then comes
    // from the cache), so a failed download (offline on the first visit) is told apart from
    // a runtime that can't run here.
    let files;
    try {
      files = await download(FILES);
    } catch (e) {
      e.stage = 'download';
      throw e;
    }
    postMessage({ loaded: true });
    const [wasm, , det, rec, dict] = files;
    const ort = await import(FILES[1].url.href);
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmBinary = wasm.buffer;
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const sessions = { det: await ort.InferenceSession.create(det, opts), rec: await ort.InferenceSession.create(rec, opts) };
    ort.env.wasm.wasmBinary = undefined; // compiled now: let the 14 MB file go
    const run = async (model, data, dims) => {
      const s = sessions[model];
      const input = new ort.Tensor('float32', data, dims);
      const res = await s.run({ [s.inputNames[0]]: input });
      const out = res[s.outputNames[0]];
      const r = { data: out.data, dims: out.dims };
      input.dispose?.();
      out.dispose?.();
      return r;
    };
    const reader = createReader(run, parseDict(new TextDecoder().decode(dict)));
    // A tiny read, so the first real one doesn't pay for setting up the runtime's kernels.
    await reader.read({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) }, [{ x: 0, y: 0, w: 1, h: 1 }]);
    await run('rec', new Float32Array(3 * 48 * 64), [1, 3, 48, 64]);
    return { reader, ms: Math.round(performance.now() - t0) };
  })();
  ready.catch(() => (ready = null));
  return ready;
}

const jobs = {
  async init() {
    return { ms: (await init()).ms };
  },
  async read({ image, areas }) {
    const { reader } = await init();
    return reader.read(image, areas);
  },
  async stats() {
    return { wasmBytes: memory?.buffer.byteLength ?? null };
  },
};

// One job at a time: the runtime runs one model at a time anyway.
let turn = Promise.resolve();
self.onmessage = (e) => {
  const { id, type } = e.data;
  turn = turn.then(async () => {
    try {
      postMessage({ id, ok: await jobs[type](e.data) });
    } catch (err) {
      postMessage({ id, error: String(err?.message || err), stage: err?.stage || 'runtime' });
    }
  });
};
