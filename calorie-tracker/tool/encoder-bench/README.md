# Encoder bench

How the Phase 7.2 encoder decisions were made, and how to re-make them. Every
number quoted in `../../CLAUDE.md` and in
`../../../planning/calorie-tracker-embeddings.md` §5 comes out of these three
scripts, so a claim about the encoder can be re-run rather than believed.

None of this ships, and none of it runs in `make check` — it needs Python,
~160 MB of model downloads and a network. It is here because "we picked int8"
is worthless without the run that picked it.

## Running it

```sh
uv venv .venv && uv pip install --python .venv/bin/python onnxruntime pillow numpy
.venv/bin/python fetch_fixtures.py fixtures          # ~25 photos from Wikimedia Commons
mkdir -p models && for f in model.onnx model_fp16.onnx model_int8.onnx; do
  curl -sSL -o "models/$f" "https://huggingface.co/onnx-community/dinov2-small-ONNX/resolve/main/onnx/$f"
done
.venv/bin/python embed_bench.py fixtures models      # which weights, pooling, crop
.venv/bin/python domain_gap.py fixtures models/model.onnx   # which stored artifact
```

`fixtures/` and `models/` are gitignored. Commons photos are freely licensed but
individually attributed, and the manifest records which is which.

## What it settled

**`embed_bench.py` — the weights, the pooling and the crop.** Leave-one-out
precision@1 over 23 photos in 6 dishes, which is what the suggestion row
actually does.

| | size | p@1 | intra−inter gap | ms/img (Mac CPU) |
| --- | --- | --- | --- | --- |
| **fp32 (shipped)** | **88 MB** | **0.957** | **0.461** | **56** |
| fp16 (cannot ship — see below) | 43 MB | 0.957 | 0.462 | 61 |
| int8 (cannot ship — see below) | 23 MB | 0.957 | 0.446 | 34 |

int8 retrieves identically at half fp16's size and 1.6× its speed, agreeing with
fp32 at cosine 0.990 mean / 0.977 min. fp16 is a near-perfect copy of fp32
(0.9999) that costs 20 MB more and runs *slower*, because ORT's CPU provider has
no native fp16 and inserts casts around every op.

> **This table ranked the exports int8 > fp16 > fp32. On a phone that order is
> exactly reversed, because the top two do not load at all.** Every number above
> is real and was measured on a desktop ORT — which is built with every kernel
> and every graph transformer working. The mobile builds are neither.
>
> - **int8** is a *dynamic* quantization: `ConvInteger` ×1, `MatMulInteger` ×72,
>   `DynamicQuantizeLinear` ×49, and no mobile ORT has kernels for them.
>   `Could not find an implementation for ConvInteger(10)`, at session creation.
> - **fp16** loads here and asserts there. The mobile build's fp16 handling
>   inserts precision casts and an extended-level fusion then looks up a name
>   those casts replaced: `Attempting to get index by a name which does not
>   exist: InsertedPrecisionFreeCast_… for node: …/SimplifiedLayerNormFusion/`.
>   Not an op-support problem, so the op-set check below would *not* have caught
>   it; only a device did.
>
> So this benchmark answers "which weights retrieve best" and cannot answer
> "which weights this app can ship". The two questions look identical right up
> until a phone says otherwise, and the gap between them cost two build-and-check
> round-trips. **Before recommending an export, check its op set, and then load
> it on a device before believing anything else here.**
>
> ```
> python -c "import onnx; print({n.op_type for n in onnx.load('m.onnx').graph.node})"
> ```
>
> `ConvInteger`, `MatMulInteger` and `DynamicQuantizeLinear` are disqualifying.
> A clean op set is necessary and, as fp16 showed, not sufficient.

Pooling is the CLS token: this export emits only `last_hidden_state`
(1×257×384), so there is no `pooler_output` to fall back on. CLS beat
mean-of-patches (p@1 0.957 vs 0.826) and matched CLS+mean concatenated at half
the storage. The crop is a plain centre square — the training-faithful 87.5%
crop (what `resize shortest edge 256` + `center crop 224` amounts to) measured
slightly *worse*, so the simpler geometry costs nothing.

§4's int8 storage quantization is free: round-tripping the 384-d vector through
int8 moved neither p@1 nor the gap at three decimals.

**`domain_gap.py` — what to store, and the bug it found.** Agreement between
embedding a stored artifact and embedding the full-resolution original:

| artifact | mean | worst | size |
| --- | --- | --- | --- |
| full photo, 1024/q80 | 0.9991 | 0.9971 | 105 KB |
| **source 256×256 square (shipped)** | **0.9866** | **0.9482** | 24 KB |
| source 256px long-edge (7.1's bug) | 0.9174 | **0.6529** | 18 KB |
| source 64px (the plan's first sketch) | 0.7864 | 0.6698 | 3 KB |

7.1 wrote the embedding source through the same long-edge cap as the photo and
the thumbnail, so a 4:3 frame was stored 256×192 and the encoder got a 192px
square upscaled to 224. A worst case of 0.65 against the meal's own photo is
unrecognisable, in the one file that exists to survive an encoder change. Fixed
in `ImageStore.sourceEdge` / `ImageCompressor.compressSquare` for ~6 KB a meal.

## What it cannot settle

- **Absolute thresholds.** Inter-dish similarity averages 0.080 and real
  intra-dish runs 0.50–0.65, which suggests starting near `suggestThreshold`
  0.55 and `contextThreshold` 0.35 — but §11 is right that these only come from
  a real phone over real days. Stock photos in studio light are not a kitchen
  table at 19:00.
- **On-device ranking of the variants — and this one bit.** These timings are a
  Mac CPU. The guess here was that "quantized ONNX ops sometimes fall back to
  CPU, so int8's win could invert on a phone". The reality was harsher than the
  hedge: they do not fall back, they are absent, and the model does not load at
  all. A variant that wins here has not been shown to work; it has been shown to
  retrieve.
- **Label quality.** Commons search gave four genuinely different foods for
  "cheese sandwich", which is the single p@1 miss (cosine 0.355 — below any
  threshold, so it would have shown nothing rather than a wrong chip). The
  oatmeal and cappuccino sets contain near-duplicate shots, which flatters
  intra-dish scores. Good enough for the relative comparisons above; not a
  benchmark to quote absolutely.
