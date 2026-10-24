# Vendored libraries

Third-party code the app serves itself instead of loading from a CDN. It works offline once
cached, and nothing loads from another site on every visit. Each folder name carries the exact
version. An update goes in a new folder, so the service worker can keep these files for good.

## `onnxruntime-web-1.30.0/`

[ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.30.0 (MIT, see `LICENSE`; the
third-party code built into its WebAssembly file is listed in `ThirdPartyNotices.txt`, from the
`v1.30.0` tag of the onnxruntime repo, which the npm package doesn't include). It runs the
text-reading models in `models/` (see `js/ocr-worker.js`), on WebAssembly with one thread, so it
needs no cross-origin isolation. It needs WebAssembly SIMD: Safari from iOS 16.4 (which the app
needs anyway), or any current Chrome. Where it can't start, the app reads with Tesseract.js instead
(`js/ocr-tesseract.js`) and says so.

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
