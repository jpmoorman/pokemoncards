# See run.sh. Writes out/report.txt plus the exported and shrunk models.
import os, sys, glob, json, hashlib, subprocess, tarfile, shutil, traceback
import numpy as np
import onnx
from onnx import numpy_helper
import onnxruntime as ort

W = 'work'
OUT = 'out'
WHEEL = 'work/wheel/x/onnxocr/models'
report = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    report.append(s)


def sha(f):
    return hashlib.sha256(open(f, 'rb').read()).hexdigest()


def fetch(url, dst):
    import requests
    r = requests.get(url, timeout=120)
    if r.status_code != 200:
        return False
    open(dst, 'wb').write(r.content)
    return True


def official(name):
    """Directory with the official Paddle inference model `name` (inference.json/pdmodel + pdiparams)."""
    d = os.path.join(W, name)
    if glob.glob(d + '/**/*.pdiparams', recursive=True):
        return d
    # 1) Hugging Face (PaddlePaddle org)
    try:
        from huggingface_hub import snapshot_download
        p = snapshot_download(repo_id=f'PaddlePaddle/{name}', local_dir=d)
        if glob.glob(d + '/**/*.pdiparams', recursive=True):
            log('source', name, f'huggingface.co/PaddlePaddle/{name}')
            model_card(name, d)
            return d
    except Exception as e:
        log('hf failed', name, repr(e)[:200])
    # 2) PaddleX official model store (BOS)
    for pv in ['paddle3.0.0', 'paddle3.1.0', 'paddle3.2.0', 'paddle3.3.0', 'paddle3.4.0']:
        url = f'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/{pv}/{name}_infer.tar'
        tar = os.path.join(W, f'{name}.tar')
        if fetch(url, tar):
            os.makedirs(d, exist_ok=True)
            tarfile.open(tar).extractall(d)
            log('source', name, url)
            return d
    # 3) PaddleOCR 2.x dygraph releases (the classifier)
    for url in [f'https://paddleocr.bj.bcebos.com/dygraph_v2.0/ch/{name}_infer.tar']:
        tar = os.path.join(W, f'{name}.tar')
        if fetch(url, tar):
            os.makedirs(d, exist_ok=True)
            tarfile.open(tar).extractall(d)
            log('source', name, url)
            return d
    log('NOT FOUND', name)
    return None


def model_card(name, d):
    """Keep the model card (its licence) and log the revision the weights came from."""
    try:
        from huggingface_hub import model_info
        info = model_info(f'PaddlePaddle/{name}')
        log('revision', name, info.sha, 'licence', getattr(info.card_data, 'license', None) if info.card_data else None)
    except Exception as e:
        log('model info failed', name, repr(e)[:200])
    card = os.path.join(d, 'README.md')
    if os.path.exists(card):
        shutil.copy(card, os.path.join(OUT, f'{name}.model-card.md'))


def to_onnx(src, dst, opset):
    pd = glob.glob(src + '/**/*.pdiparams', recursive=True)[0]
    mdir = os.path.dirname(pd)
    files = os.listdir(mdir)
    log('files', name_of(src), sorted(files))
    model = 'inference.json' if 'inference.json' in files else [f for f in files if f.endswith('.pdmodel')][0]
    cmd = ['paddle2onnx', '--model_dir', mdir, '--model_filename', model, '--params_filename', os.path.basename(pd), '--save_file', dst, '--opset_version', str(opset), '--enable_onnx_checker', 'True']
    r = subprocess.run(cmd, capture_output=True, text=True)
    log('paddle2onnx', os.path.basename(dst), 'rc', r.returncode, (r.stdout + r.stderr)[-600:].replace('\n', ' | '))
    for f in glob.glob(mdir + '/*.yml'):
        shutil.copy(f, os.path.join(OUT, os.path.basename(dst).replace('.onnx', '.inference.yml')))
    return r.returncode == 0 and os.path.exists(dst)


def name_of(p):
    return os.path.basename(p.rstrip('/'))


def run(f, x):
    s = ort.InferenceSession(f, providers=['CPUExecutionProvider'])
    return s.run(None, {s.get_inputs()[0].name: x})[0]


def compare(a, b, shapes, what):
    rs = np.random.RandomState(0)
    worst = 0
    for shp in shapes:
        x = (rs.rand(*shp).astype(np.float32) * 2 - 1)
        ya, yb = run(a, x), run(b, x)
        if ya.shape != yb.shape:
            log(what, 'SHAPE DIFF', shp, ya.shape, yb.shape)
            return None
        d = float(np.abs(ya - yb).max())
        worst = max(worst, d)
        extra = ''
        if ya.ndim == 3:  # rec: same best class at every step?
            extra = f' argmax-equal {float((ya.argmax(-1) == yb.argmax(-1)).mean()):.4f}'
        log(what, 'input', shp, 'max abs diff', f'{d:.3g}' + extra)
    return worst


def params(f):
    m = onnx.load(f)
    arrs = [numpy_helper.to_array(i) for i in m.graph.initializer]
    for n in m.graph.node:
        if n.op_type == 'Constant':
            for at in n.attribute:
                if at.t and at.t.dims:
                    arrs.append(numpy_helper.to_array(at.t))
    arrs = [a.astype(np.float32) for a in arrs if a.size > 8 and a.dtype.kind == 'f']
    return sorted([(a.shape, round(float(a.astype(np.float64).sum()), 3)) for a in arrs])


KEEP_EXTRA = set('©®°·ÀÂÉ×àáäçèéíñóöúüδ–—‘’“”•★☆♀♂')


def trim_rec(src, chars, dst, dict_dst):
    """Keep only the output classes for Latin text (as the spike's shrink.py)."""
    m = onnx.load(src)
    inits = {i.name: i for i in m.graph.initializer}
    # The classifier head: the last MatMul's weight [D, n_cls] and the Add's bias [n_cls].
    n_cls = None
    cand = [i for i in m.graph.initializer if len(i.dims) == 2 and i.dims[1] in (len(chars) + 1, len(chars) + 2)]
    w = cand[-1]
    n_cls = w.dims[1]
    b = [i for i in m.graph.initializer if list(i.dims) == [n_cls]][-1]
    W_ = numpy_helper.to_array(w)
    B_ = numpy_helper.to_array(b)
    keep_idx = [i for i, c in enumerate(chars) if len(c) == 1 and (32 < ord(c) < 127 or c in KEEP_EXTRA)]
    cols = [0] + [i + 1 for i in keep_idx] + ([n_cls - 1] if n_cls == len(chars) + 2 else [])
    inits[w.name].CopyFrom(numpy_helper.from_array(np.ascontiguousarray(W_[:, cols]), w.name))
    inits[b.name].CopyFrom(numpy_helper.from_array(np.ascontiguousarray(B_[cols]), b.name))
    for o in m.graph.output:
        d = o.type.tensor_type.shape.dim
        if len(d):
            d[-1].ClearField('dim_value')
            d[-1].dim_param = 'classes'
    del m.graph.value_info[:]
    onnx.checker.check_model(m)
    onnx.save(m, dst)
    open(dict_dst, 'w', encoding='utf-8').write('\n'.join(chars[i] for i in keep_idx) + '\n')
    log('trim', os.path.basename(dst), 'weights', w.name, b.name, 'classes', n_cls, '->', len(cols))


def fp16_weights(src, dst, min_size=256):
    from onnx import helper, TensorProto
    m = onnx.load(src)
    g = m.graph
    new_inits, casts = [], []
    for init in list(g.initializer):
        a = numpy_helper.to_array(init)
        if a.dtype == np.float32 and a.size >= min_size:
            h = numpy_helper.from_array(a.astype(np.float16), init.name + '_fp16')
            new_inits.append(h)
            casts.append(helper.make_node('Cast', [h.name], [init.name], to=TensorProto.FLOAT, name=init.name + '_cast'))
            g.initializer.remove(init)
    g.initializer.extend(new_inits)
    for n in reversed(casts):
        g.node.insert(0, n)
    onnx.checker.check_model(m)
    onnx.save(m, dst)


def dict_of_yml(yml):
    import yaml
    y = yaml.safe_load(open(yml, encoding='utf-8'))
    return [str(c) for c in y['PostProcess']['character_dict']]


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(W, exist_ok=True)
    jobs = [
        # name, opset, the wheel's file, test input shapes
        ('PP-OCRv6_tiny_det', 14, f'{WHEEL}/ppocrv6/tiny/det/det.onnx', [(1, 3, 256, 960), (1, 3, 960, 704)]),
        ('PP-OCRv6_tiny_rec', 11, f'{WHEEL}/ppocrv6/tiny/rec/rec.onnx', [(6, 3, 48, 320), (2, 3, 48, 640)]),
        ('ch_ppocr_mobile_v2.0_cls', 11, f'{WHEEL}/ppocrv5/cls/cls.onnx', [(6, 3, 48, 192)]),
    ]
    exported = {}
    for name, opset, wheel_file, shapes in jobs:
        try:
            log(f'== {name}')
            log('wheel file', wheel_file, 'sha256', sha(wheel_file) if os.path.exists(wheel_file) else 'missing')
            src = official(name)
            if not src:
                continue
            dst = os.path.join(OUT, f'{name}.onnx')
            if not to_onnx(src, dst, opset):
                continue
            exported[name] = dst
            log('exported', dst, os.path.getsize(dst), 'sha256', sha(dst))
            pa, pb = params(dst), params(wheel_file)
            log('same parameter tensors as the wheel file:', pa == pb, f'({len(pa)} vs {len(pb)} tensors)')
            compare(dst, wheel_file, shapes, f'{name} official-vs-wheel')
        except Exception:
            log(traceback.format_exc())
    # Shrink like the spike and compare with the spike's shipped files (sha256 of those below).
    try:
        if 'PP-OCRv6_tiny_rec' in exported:
            ymls = glob.glob(os.path.join(W, 'PP-OCRv6_tiny_rec', '**', 'inference.yml'), recursive=True)
            chars = dict_of_yml(ymls[0])
            wheel_chars = open(f'{WHEEL}/ppocrv6/ppocrv6_tiny_dict.txt', encoding='utf-8').read().split('\n')
            if wheel_chars and wheel_chars[-1] == '':
                wheel_chars = wheel_chars[:-1]
            log('dict: official', len(chars), 'wheel', len(wheel_chars), 'same:', chars == wheel_chars)
            trim_rec(exported['PP-OCRv6_tiny_rec'], chars, os.path.join(W, 'rec_latin.onnx'), os.path.join(OUT, 'latin_dict.txt'))
            fp16_weights(os.path.join(W, 'rec_latin.onnx'), os.path.join(OUT, 'rec_latin_w16.onnx'))
            log('rec_latin_w16.onnx', os.path.getsize(os.path.join(OUT, 'rec_latin_w16.onnx')), sha(os.path.join(OUT, 'rec_latin_w16.onnx')))
            log('latin_dict.txt sha256', sha(os.path.join(OUT, 'latin_dict.txt')))
        if 'PP-OCRv6_tiny_det' in exported:
            fp16_weights(exported['PP-OCRv6_tiny_det'], os.path.join(OUT, 'det_w16.onnx'))
            log('det_w16.onnx', os.path.getsize(os.path.join(OUT, 'det_w16.onnx')), sha(os.path.join(OUT, 'det_w16.onnx')))
    except Exception:
        log(traceback.format_exc())
    open(os.path.join(OUT, 'report.txt'), 'w').write('\n'.join(report) + '\n')


main()
