#!/usr/bin/env python3
"""Export the image encoder this app embeds meals with.

Run it with `make model`. It writes `assets/models/dinov2-small-cls-224.onnx`,
which is gitignored and bundled into the built app — so the app itself never
downloads anything and works offline.

**Why this app exports its own instead of fetching a ready-made ONNX.** Three
reasons, and they arrived in this order:

1. **Licensing.** `facebook/dinov2-small` is Apache 2.0, stated. The convenient
   re-export (`onnx-community/dinov2-small-ONNX`, which this app shipped until
   now) declares *no* license at all — only `base_model: facebook/dinov2-small`.
   The Apache grant flows to derivative works and the re-exporter cannot revoke
   it, so that file was very probably fine; "very probably" is a poor place to
   keep the one binary the app redistributes. Exporting from the licensed
   original replaces an inference with a statement.
2. **The output shape.** The stock export emits `last_hidden_state`,
   `[1, 257, 384]`, and this app reads the CLS token — the first 384 of 98,688
   floats. Every one of the rest crossed the platform channel, three times a
   second, to be dropped. Pooling here makes the graph emit `[1, 384]`.
3. **The input shape.** The stock export's dims are all symbolic
   (`batch_size, num_channels, height, width`). This app has exactly one legal
   input size, so saying so costs nothing.

**Numbers, so nobody re-litigates this from intuition** (measured on an M-series
Mac, ORT 1.13, median of 8 runs, in `git log` for this file):

    dynamic shapes, CPU        55.0 ms      <- what the app shipped
    dynamic shapes, Core ML    55.6 ms      Core ML partitioned nothing
    static + CLS, CPU          55.2 ms      <- what this writes
    static + CLS, Core ML     130.3 ms      Core ML took it and lost

The third line is the one that matters and the fourth is the surprise. Fixing
the input shape *does* let ORT's Core ML EP accept the graph — and Core ML then
loses to the CPU by 2.4x, because a ViT of this size is dominated by matmuls the
CPU provider already does well and Core ML pays conversion overhead for. So this
export is not a speed change. It is a licensing change and a payload change, and
the input shape is here because it is free and honest, not because it is fast.

**If the phone gets slower after this**, that is the fourth line arriving on
iOS, and the fix is one line: drop `OrtProvider.CORE_ML` from
`DinoV2Encoder._providers`. The diagnostics card prints the per-inference
milliseconds, so the question is answerable in one look.

Modifications to the Apache 2.0 work, stated as section 4(b) requires:
  - the graph is exported with a fixed [1, 3, 224, 224] input;
  - it emits the CLS token, [1, 384], instead of the full hidden state.
No weight is altered. Both are recorded in `assets/licenses/NOTICE-dinov2.txt`,
which ships in the app.
"""

from __future__ import annotations

import hashlib
import os
import pathlib
import sys

# Before `transformers` is imported: it probes for TensorFlow and Flax on the
# way in, and a broken install of either — a stale `libmetal_plugin.dylib` is
# the common one on macOS — takes down an export that has no use for them. This
# is a torch-only script; say so rather than depend on the machine being tidy.
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("USE_FLAX", "0")
os.environ.setdefault("USE_TORCH", "1")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from transformers import Dinov2Model  # noqa: E402

# Pinned. The point of a pin is that a silent upstream change cannot alter every
# embedding in every database while `embedded-by-model` goes on claiming the
# vectors are comparable — see §9 of the embeddings plan. This is a commit on
# the Hub, so it names exact weights.
REPO = "facebook/dinov2-small"
REVISION = "ed25f3a31f01632728cabb09d1542f84ab7b0056"

EDGE = 224
DIMENSIONS = 384
OPSET = 14

DEST = pathlib.Path(__file__).resolve().parent.parent / "assets" / "models"
NAME = "dinov2-small-cls-224.onnx"

# What the app agrees to call this. Weights, pooling and input edge, because
# comparability depends on all three — see `DinoV2Encoder.modelIdValue`, which
# must match.
MODEL_ID = "dinov2-small-cls-224"


class ClsEncoder(torch.nn.Module):
    """DINOv2 with the pooling this app uses folded into the graph.

    CLS rather than mean-of-patches is `tool/encoder-bench/`'s result
    (precision@1 0.957 against 0.826), and it is a *decision* rather than a
    lookup because this model publishes no `pooler_output`. Making it part of
    the exported graph is what stops 257x the needed floats crossing a platform
    channel three times a second.
    """

    def __init__(self, model: Dinov2Model) -> None:
        super().__init__()
        self.model = model

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        hidden = self.model(pixel_values=pixel_values).last_hidden_state
        return hidden[:, 0]


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    out = DEST / NAME

    if out.exists():
        print(f"Already present: {out}")
        print(f"  ({out.stat().st_size / 1e6:.0f} MB). Delete it to re-export.")
        return 0

    print(f"Loading {REPO} @ {REVISION[:12]}")
    model = Dinov2Model.from_pretrained(REPO, revision=REVISION).eval()
    encoder = ClsEncoder(model).eval()

    # Fixed, and deliberately not `dynamic_axes`: this app has one legal input
    # size, and a symbolic dim is a claim that it might not.
    example = torch.zeros(1, 3, EDGE, EDGE)

    print(f"Exporting to {out.name} (opset {OPSET}, input {tuple(example.shape)})")
    tmp = out.with_suffix(".part")
    torch.onnx.export(
        encoder,
        example,
        str(tmp),
        input_names=["pixel_values"],
        output_names=["cls"],
        opset_version=OPSET,
        do_constant_folding=True,
        dynamic_axes=None,
    )

    if not verify(tmp, encoder):
        tmp.unlink(missing_ok=True)
        return 1

    tmp.rename(out)
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"OK  {out.stat().st_size / 1e6:.0f} MB")
    print(f"    sha256 {digest}")
    print(f"    model id {MODEL_ID}")
    return 0


def verify(path: pathlib.Path, reference: torch.nn.Module) -> bool:
    """Check the export against the torch model that produced it.

    **A file hash would be the wrong pin here** and this is the substitute.
    `torch.onnx.export` is not byte-reproducible across torch versions, so
    pinning the output's sha256 would fail on every toolchain but the one that
    wrote it — while saying nothing about whether the graph still computes the
    same vector. The upstream *weights* are pinned by revision above; what has
    to be checked here is behaviour, so that is what is checked.
    """
    try:
        import onnx
        import onnxruntime as ort
    except ImportError as e:  # pragma: no cover - a developer's toolchain
        print(f"Cannot verify the export ({e}). Refusing to ship it.", file=sys.stderr)
        return False

    graph = onnx.load(str(path))
    onnx.checker.check_model(graph)

    shape = [d.dim_value or d.dim_param for d in graph.graph.input[0].type.tensor_type.shape.dim]
    if shape != [1, 3, EDGE, EDGE]:
        print(f"Input shape is {shape}, want [1, 3, {EDGE}, {EDGE}]", file=sys.stderr)
        return False

    ops = {n.op_type for n in graph.graph.node}
    banned = ops & {"ConvInteger", "MatMulInteger", "DynamicQuantizeLinear"}
    if banned:
        # The int8 export failed exactly here, on a phone, at session creation:
        # the ONNX Runtimes shipped to iOS and Android carry no kernels for
        # these. Catching it in the exporter costs nothing; catching it on a
        # device cost two round-trips.
        print(f"Integer-quantized ops no mobile runtime has: {banned}", file=sys.stderr)
        return False

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    sample = rng.random((1, 3, EDGE, EDGE), dtype=np.float32)

    got = session.run(None, {"pixel_values": sample})[0]
    if got.shape != (1, DIMENSIONS):
        print(f"Output shape is {got.shape}, want (1, {DIMENSIONS})", file=sys.stderr)
        return False

    with torch.no_grad():
        want = reference(torch.from_numpy(sample)).numpy()

    got, want = got.reshape(-1), want.reshape(-1)
    cosine = float(np.dot(got, want) / (np.linalg.norm(got) * np.linalg.norm(want)))
    if cosine < 0.9999:
        print(f"The export disagrees with torch: cosine {cosine:.6f}", file=sys.stderr)
        return False

    print(f"Verified: [1, {DIMENSIONS}] out, cosine {cosine:.6f} against torch")
    return True


if __name__ == "__main__":
    sys.exit(main())
