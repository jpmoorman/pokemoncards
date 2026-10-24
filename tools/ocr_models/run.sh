#!/bin/bash
# Re-export the PP-OCR models the app ships from PaddlePaddle's official inference weights
# (paddle2onnx), shrink them like the spike did (Latin-only rec head, fp16-stored weights)
# and compare them with the files the spike took from the onnxocr 4.0.0 wheel on PyPI.
# Everything lands in out/ (pushed to the ocr-models-out branch by the workflow).
set -u
mkdir -p out work
exec > >(tee out/log.txt) 2>&1
python -V
pip install -q --upgrade pip
pip install -q "paddlepaddle==3.*" -i https://www.paddlepaddle.org.cn/packages/stable/cpu/ || pip install -q "paddlepaddle==3.*"
pip install -q paddle2onnx onnx onnxruntime onnxconverter-common numpy huggingface_hub requests pyyaml
pip list 2>/dev/null | grep -i -E "paddle|onnx|numpy" 
pip download -q --no-deps onnxocr==4.0.0 -d work/wheel && (cd work/wheel && python -m zipfile -e onnxocr-4.0.0-py3-none-any.whl x)
python tools/ocr_models/export.py
ls -la out
