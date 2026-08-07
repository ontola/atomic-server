"""The check that guards every threshold: does the stored source embed like the original?

Two questions, both answerable without a phone:

1. **Is the 256px source enough?** The design keeps a small JPEG per meal so the
   history can be re-encoded when the model changes (§9). If embedding that
   source disagrees with embedding the full-resolution photo, then every vector
   in the index is an artifact of compression and the thresholds calibrated on
   them mean nothing.

2. **Does `sourceEdge` need to be a square?** ImageStore currently caps the
   *long* edge at 256, so a 4:3 frame is stored 256x192 and the square crop the
   encoder needs yields 192px upscaled to 224. Storing a true 256x256 square
   instead costs nothing and removes the upscale. This measures whether that
   matters.

The reference is the full-resolution original, center-cropped square. Anything
the app stores has to agree with it closely -- the paper's own guidance is that
the query and the index must be preprocessed identically, and here the "query"
in the eventual live pipeline is a camera frame that has been through neither
JPEG pass.
"""

import glob
import io
import os
import sys

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def to_tensor(im):
    im = im.convert("RGB").resize((224, 224), Image.BICUBIC)
    x = np.asarray(im, dtype=np.float32) / 255.0
    x = (x - MEAN) / STD
    return x.transpose(2, 0, 1)[None].astype(np.float32)


def square(im):
    w, h = im.size
    s = min(w, h)
    return im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))


def jpeg(im, quality):
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return Image.open(io.BytesIO(buf.getvalue())), buf.getbuffer().nbytes


def variants(path):
    """The reference, plus what ImageStore does today and what it would do."""
    original = Image.open(path).convert("RGB")
    w, h = original.size

    out = {}
    # Reference: full-resolution pixels, square-cropped. No JPEG pass of ours.
    out["reference"] = (square(original), 0)

    # The stored 1024px/q80 photo (ImageStore.maxEdge/quality), square-cropped
    # at encode time -- this is what the estimation queue already sends.
    scale = 1024 / max(w, h)
    full = original.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    out["full 1024 q80"] = jpeg(square(full), 80)

    # TODAY: sourceEdge caps the LONG edge at 256 -> 4:3 gives 256x192, and the
    # square crop the encoder needs is only 192px, upscaled to 224.
    scale = 256 / max(w, h)
    today = original.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    out["source 256-long (today)"] = jpeg(today, 90)

    # PROPOSED: crop square first, then 256x256 -- a true 256 into the encoder.
    proposed = square(original).resize((256, 256), Image.LANCZOS)
    out["source 256-square"] = jpeg(proposed, 90)

    # For contrast: what the plan originally sketched, to show why 64 was wrong.
    tiny = square(original).resize((64, 64), Image.LANCZOS)
    out["source 64-square (old plan)"] = jpeg(tiny, 90)

    return out


def main(fixtures_dir, model):
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name

    def embed(im):
        h = sess.run(None, {name: to_tensor(im)})[0]
        v = h[0, 0]  # CLS -- the pooling the benchmark picked
        return v / (np.linalg.norm(v) + 1e-12)

    files = sorted(glob.glob(os.path.join(fixtures_dir, "*.jpg")))
    labels = [os.path.basename(f).rsplit("_", 1)[0] for f in files]

    kinds = None
    agree = {}
    ref_vecs, var_vecs = [], {}
    sizes = {}

    for f in files:
        vs = variants(f)
        if kinds is None:
            kinds = list(vs)
            for k in kinds:
                agree[k] = []
                var_vecs[k] = []
                sizes[k] = []
        ref = None
        for k in kinds:
            im, nbytes = vs[k]
            v = embed(im)
            if k == "reference":
                ref = v
                ref_vecs.append(v)
            agree[k].append(float(ref @ v))
            var_vecs[k].append(v)
            sizes[k].append(nbytes)

    print("Agreement with the full-resolution original (cosine, CLS):\n")
    print(f"{'artifact':<30}{'mean':>8}{'min':>8}{'KB':>8}")
    print("-" * 54)
    for k in kinds:
        kb = np.mean(sizes[k]) / 1024
        print(f"{k:<30}{np.mean(agree[k]):>8.4f}{np.min(agree[k]):>8.4f}"
              f"{kb:>8.0f}" if kb else
              f"{k:<30}{np.mean(agree[k]):>8.4f}{np.min(agree[k]):>8.4f}{'-':>8}")

    # The number that actually matters: does an index built from the stored
    # source still retrieve correctly when queried with the full-res pixels?
    print("\nCross-artifact retrieval -- query = reference, index = each artifact:")
    print("(this is the live pipeline's asymmetry: camera frame vs stored file)\n")
    R = np.stack(ref_vecs)
    for k in kinds:
        M = np.stack(var_vecs[k])
        sim = R @ M.T
        if k == "reference":
            np.fill_diagonal(sim, -np.inf)
        else:
            # A photo matching its own stored copy is trivially correct and not
            # what the row is for; exclude the identity pairing too.
            np.fill_diagonal(sim, -np.inf)
        hits = [labels[i] == labels[int(sim[i].argmax())] for i in range(len(labels))]
        print(f"  {k:<30}p@1 {np.mean(hits):.3f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
