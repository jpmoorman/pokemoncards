# Models

Files the app downloads once and keeps. Each folder name carries a version: a changed model goes
in a new folder (`ppocr-v6tiny-2/` and so on), never over an old file. The service worker can then
keep these files for good, and an app update never downloads them again.

## `ppocr-v6tiny-1/`: text reading (PaddleOCR PP-OCRv6 tiny)

`js/ocr-worker.js` runs these files on onnxruntime-web (`vendor/onnxruntime-web-1.30.0/`, MIT).

| File | What it is | Bytes | gzip | sha256 |
|---|---|---|---|---|
| `det.onnx` | Text detector, PP-OCRv6_tiny_det: finds the lines of text | 988,784 | 826,096 | `26bc3ea4cbbe44a5063b984d2b34ea6abe85208359a6b048d1511f69cbb946f6` |
| `rec.onnx` | Text recognizer, PP-OCRv6_tiny_rec, cut down to Latin letters: reads one line | 1,146,762 | 1,054,270 | `c62bcba6fc6dce9cad9a7ab933e3c5503b63f7f34c66e896d3ab65272dd6009d` |
| `dict.txt` | The recognizer's 126 characters, one per line (class 0 is "blank", the last is a space) | 295 | 259 | `5d35f53aa94e8db26662ad5218440eccc7cb162df801c6db2fe5e2931ca125c4` |

**Source.** PaddlePaddle's official inference weights:
- [huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det), revision `d3177d4e5551463292a61e27cfca2b53e7c3fe9d`
- [huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec), revision `0736086f72f666350ebcdc0c3a504eeac89cdfad`

**Licence.** Apache License 2.0: both model cards say `license: apache-2.0`, as does PaddleOCR
itself. The licence text is in `ppocr-v6tiny-1/LICENSE`. These files are modified versions of the
models: see the next paragraph for what was changed.

**How the files were made.** A GitHub Actions job ran `tools/ocr_models/run.sh` (with
`export.py`; the job lives in the private test-photo repo, but the scripts only download the
public weights above and are in this repo). It used paddlepaddle 3.4.0, paddle2onnx 2.1.0, onnx
1.17.0 and onnxruntime 1.31.0. It now also keeps the model cards and logs the revision of the
weights: run again on 2026-10-24, from the revisions above, it gave exactly the files here (same
SHA-256). The steps:
1. Download the weights above.
2. Convert them with `paddle2onnx`: opset 14 for the detector, 11 for the recognizer.
3. Shrink them, as `shrink.py` in the review's spike did:
   - **Recognizer:** keep only the output classes for Latin text. That is blank, printable ASCII,
     a few accented letters and card symbols (`©®°·ÀÂÉ×àáäçèéíñóöúüδ–—‘’“”•★☆♀♂`) and space: 6,906
     classes become 128. The dictionary is written to match.
   - **Both models:** store every weight of 256 values or more as 16-bit floats, cast back to
     32-bit floats when the model loads. The download halves, and the model still computes in 32
     bits, so the browser needs no 16-bit support.

**Checks.**
- The official export of the recognizer is byte-identical to the file the architecture spike used
  (from the `onnxocr` 4.0.0 wheel on PyPI, also Apache-2.0). The shrunk recognizer and the
  dictionary are byte-identical too.
- The official detector gives exactly the same output as the spike's file (largest difference 0 on
  test inputs). Its file is laid out a little differently and is 49 KB bigger.
- `js/ppocr.js` run in Node with these files gives the same lines on 67 dev crops (every 4th) as
  with the spike's files. It matched all 2,370 lines: the same text, scores and boxes.

**Settings the app uses** (see `js/ppocr.js`):
- Input: blue, green and red planes, each pixel `(v / 255 - 0.5) / 0.5`.
- The detector looks for text at most 960 px on the long side, in sizes that are multiples of 32.
  Its threshold is 0.3, it keeps boxes that score 0.5 or more, and it grows them by a factor of 1.6
  (unclip).
- The recognizer reads lines 48 px tall and at least 320 px wide, 6 at a time.

These are RapidOCR's defaults, with which the spike measured the accuracy (dev 252 of 268).

Not used: the 0/180 text-direction classifier (`ch_ppocr_mobile_v2.0_cls`, 0.58 MB). The app tells
which way up a card is from what it reads: a collector number, or a clearly read card name.
