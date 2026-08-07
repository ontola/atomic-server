"""Pick the DINOv2 variant, the crop and the pooling by measurement, not guess.

Phase 7.2 of calorie-tracker-embeddings.md has to settle four things before any
Dart is written, and none of them need a phone:

1. **Which weights ship.** fp32 (88 MB) is the reference and never ships; fp16
   (45 MB) and int8 (24 MB) are the candidates. The question is not "are they
   accurate" in the abstract -- it is whether they *rank* the same, since ranking
   is the only thing these vectors are used for.
2. **Which crop.** The export's own preprocessor says resize-shortest-edge-256
   then center-crop-224, which is exactly a centered square at 87.5% of the short
   edge resized to 224. The app cannot use "resize shortest edge" directly (the
   camera preview and the stored source have different aspect ratios and the
   design doc requires one geometry for both), so the question is whether the
   faithful 87.5% crop beats the simpler full-square crop.
3. **Which pooling.** This export emits only `last_hidden_state` (1x257x384) --
   there is no `pooler_output` to default to. CLS, mean-of-patches, and the
   concatenation of both are the candidates.
4. **Whether int8 storage quantization is free.** Section 4 stores the vector as
   base64 int8. That is a second, independent quantization on top of whatever the
   weights do, and it has to not change the ordering.

The metric is precision@1 under leave-one-out nearest neighbour: for each photo,
is its closest neighbour the same dish? That is literally what the suggestion
row does, so it is the number that matters, rather than an abstract embedding
quality score.
"""

import glob
import json
import os
import sys
import time
from collections import defaultdict

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
EDGE = 224

# The export's preprocessor_config.json: shortest edge -> 256, center crop 224.
# 224/256 of the short edge, which is the crop this reproduces without ever
# needing to know the aspect ratio.
FAITHFUL_CROP = 224 / 256


def preprocess(path, crop_frac):
    """Center-crop square, resize to 224 bicubic, normalize. NCHW float32."""
    im = Image.open(path).convert("RGB")
    w, h = im.size
    side = int(min(w, h) * crop_frac)
    left, top = (w - side) // 2, (h - side) // 2
    im = im.crop((left, top, left + side, top + side))
    im = im.resize((EDGE, EDGE), Image.BICUBIC)
    x = np.asarray(im, dtype=np.float32) / 255.0
    x = (x - MEAN) / STD
    return x.transpose(2, 0, 1)[None].astype(np.float32)


def pool(hidden, how):
    """hidden: (1, 1+patches, 384) -> (384,) or (768,)."""
    cls, patches = hidden[0, 0], hidden[0, 1:].mean(axis=0)
    if how == "cls":
        return cls
    if how == "mean":
        return patches
    return np.concatenate([cls, patches])


def normed(v):
    return v / (np.linalg.norm(v) + 1e-12)


def quantize_int8(v):
    """Section 4's storage format: symmetric per-vector int8, then back.

    Cosine is scale invariant, so the scale factor need not be stored -- only
    the 384 bytes. This models exactly what a round trip through the
    `meal-embedding` property does to the ranking.
    """
    scale = np.abs(v).max()
    if scale == 0:
        return v
    return np.round(v / scale * 127.0).astype(np.int8).astype(np.float32)


def precision_at_1(vecs, labels):
    """Leave-one-out: is each photo's nearest neighbour the same dish?"""
    m = np.stack([normed(v) for v in vecs])
    sim = m @ m.T
    np.fill_diagonal(sim, -np.inf)
    hits = [labels[i] == labels[int(sim[i].argmax())] for i in range(len(labels))]
    return float(np.mean(hits)), hits, sim


def separation(sim, labels):
    """Mean intra-dish and inter-dish cosine, and the gap between them."""
    intra, inter = [], []
    for i in range(len(labels)):
        for j in range(i + 1, len(labels)):
            (intra if labels[i] == labels[j] else inter).append(sim[i, j])
    return float(np.mean(intra)), float(np.mean(inter))


def main(fixtures_dir, models_dir):
    files = sorted(glob.glob(os.path.join(fixtures_dir, "*.jpg")))
    labels = [os.path.basename(f).rsplit("_", 1)[0] for f in files]
    print(f"{len(files)} photos, {len(set(labels))} dishes\n")

    variants = ["model.onnx", "model_fp16.onnx", "model_int8.onnx"]
    crops = {"full-square": 1.0, "faithful-87.5%": FAITHFUL_CROP}
    poolings = ["cls", "mean", "cls+mean"]

    # embeddings[variant][crop][pooling] -> list of vectors
    emb = defaultdict(lambda: defaultdict(dict))
    timings = {}

    for variant in variants:
        path = os.path.join(models_dir, variant)
        sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
        name = sess.get_inputs()[0].name
        for crop_label, frac in crops.items():
            hiddens, elapsed = [], 0.0
            for f in files:
                x = preprocess(f, frac)
                t0 = time.perf_counter()
                out = sess.run(None, {name: x})[0]
                elapsed += time.perf_counter() - t0
                hiddens.append(np.asarray(out, dtype=np.float32))
            timings[(variant, crop_label)] = elapsed / len(files) * 1000
            for how in poolings:
                emb[variant][crop_label][how] = [pool(h, how) for h in hiddens]
        print(f"loaded {variant}")

    rows = []
    for variant in variants:
        for crop_label in crops:
            for how in poolings:
                vecs = emb[variant][crop_label][how]
                p1, _, sim = precision_at_1(vecs, labels)
                intra, inter = separation(sim, labels)
                q = [quantize_int8(v) for v in vecs]
                p1q, _, simq = precision_at_1(q, labels)
                intraq, interq = separation(simq, labels)
                rows.append(
                    {
                        "variant": variant,
                        "crop": crop_label,
                        "pool": how,
                        "p@1": p1,
                        "intra": intra,
                        "inter": inter,
                        "gap": intra - inter,
                        "p@1_int8store": p1q,
                        "gap_int8store": intraq - interq,
                        "ms": timings[(variant, crop_label)],
                    }
                )

    hdr = (
        f"{'variant':<16}{'crop':<16}{'pool':<10}{'p@1':>7}{'intra':>8}"
        f"{'inter':>8}{'gap':>8}{'p@1 q8':>8}{'gap q8':>8}{'ms':>8}"
    )
    print("\n" + hdr)
    print("-" * len(hdr))
    for r in sorted(rows, key=lambda r: -r["gap"]):
        print(
            f"{r['variant'].replace('model','').replace('.onnx','') or 'fp32':<16}"
            f"{r['crop']:<16}{r['pool']:<10}{r['p@1']:>7.3f}{r['intra']:>8.3f}"
            f"{r['inter']:>8.3f}{r['gap']:>8.3f}{r['p@1_int8store']:>8.3f}"
            f"{r['gap_int8store']:>8.3f}{r['ms']:>8.1f}"
        )

    # How far the shipping candidates drift from the fp32 reference, per vector.
    print("\nAgreement with fp32 reference (cosine, same crop+pool):")
    for crop_label in crops:
        for how in poolings:
            ref = [normed(v) for v in emb["model.onnx"][crop_label][how]]
            for variant in ("model_fp16.onnx", "model_int8.onnx"):
                cand = [normed(v) for v in emb[variant][crop_label][how]]
                cos = [float(a @ b) for a, b in zip(ref, cand)]
                print(
                    f"  {variant:<18}{crop_label:<16}{how:<10}"
                    f"mean {np.mean(cos):.4f}  min {np.min(cos):.4f}"
                )

    with open("bench_results.json", "w") as f:
        json.dump({"rows": rows, "files": files, "labels": labels}, f, indent=2)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
