# Vendored libraries

Third-party code the app serves itself instead of loading from a CDN. It works offline once
cached, and nothing loads from another site on every visit. Each folder name carries the exact
version. An update goes in a new folder, so the service worker can keep these files for good.

## `onnxruntime-web-1.30.0/`

[ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.30.0 (MIT, see `LICENSE`). It runs
the text-reading models in `models/` (see `js/ocr-worker.js`), on WebAssembly with one thread, so
it needs no cross-origin isolation. It needs WebAssembly SIMD: Safari from iOS 16.4, or any current
Chrome. Phones without it read with Tesseract.js instead (`js/ocr-tesseract.js`).

The app uses only the WebAssembly build. Copy these files from the pinned dev dependency
(`npm install`):

```
cp node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs \
   node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm \
   vendor/onnxruntime-web-1.30.0/
```

| File | Bytes | gzip |
|---|---|---|
| `ort.wasm.bundle.min.mjs` | 73,054 | 24,635 |
| `ort-wasm-simd-threaded.wasm` | 14,239,897 | 3,678,426 |
