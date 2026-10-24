# Making the text-reading models

`run.sh` (with `export.py`) makes the files in `models/ppocr-v6tiny-1/` from PaddlePaddle's
official PP-OCRv6 tiny weights on Hugging Face: it converts them with paddle2onnx, keeps only the
recognizer's classes for Latin text, stores the weights as 16-bit floats, and checks them against
the files the architecture review's spike used. See `models/README.md` for the details, the
revisions and the expected SHA-256 of each file.

It needs Linux, Python 3.12 and an internet connection (it installs paddlepaddle, paddle2onnx,
onnx and onnxruntime with pip). From the repo root:

```bash
bash tools/ocr_models/run.sh   # writes out/: report.txt, the model cards, the exported files
```

The files to ship are `out/det_w16.onnx` (as `det.onnx`), `out/rec_latin_w16.onnx` (as
`rec.onnx`) and `out/latin_dict.txt` (as `dict.txt`). A changed model goes in a new folder
(`models/ppocr-v6tiny-2/`), then `node tools/assets.mjs`.
