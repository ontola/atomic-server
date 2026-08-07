# Calorie Tracker — Meal Suggestions from On-Device Image Embeddings

Companion to [calorie-tracker-plan.md](./calorie-tracker-plan.md) (§4 data model, §6 photos, §8
phases). This is **Phase 7**, ahead of Health (now Phase 8) — it is the last change to how a meal is
logged, and Health only writes out what a meal already is. It is independent of Phase 6.1, though
§11 argues for doing them together.

## 1. What this is for

Point the camera at food. Before the shutter is pressed, up to four past meals appear as chips —
the ones this looks like. Tap one and the meal is logged with that meal's number, immediately,
with no model call and no waiting.

The point is **not** the ~$0.0002 an estimate costs. It is two other things:

- **The repeated question.** Someone who eats a cheese sandwich most weeks gets asked "is there
  anything on it besides the cheese?" every single time, because each meal is estimated from
  nothing. They already answered that, in `meal-notes`, weeks ago. The clarify loop is well
  designed and it terminates (Phase 5), but a loop that terminates is still a loop the user has to
  walk around every time. A tap on a past meal skips it entirely.
- **Variance.** Two photos of the same sandwich get two different estimates from the same model on
  the same day. For a *routine* meal the user's own confirmed history is a better number than a
  fresh guess, and it is consistent with itself, which is what makes a week of totals comparable.

Everything else — instant results, working offline, no key needed for repeat meals — is a
side effect worth having but not worth designing around.

## 2. Why the live viewfinder, and not a post-capture sheet

The first sketch of this put suggestions *after* the shutter: capture, then offer four matches to
confirm. That is the worse design, for a reason specific to this app's data model.

A tapped suggestion writes a `confirmed` meal, and `update_meal_estimate` deliberately refuses to
overwrite `confirmed` (Phase 4). So a bad suggestion accepted after the fact does not merely
annoy — it **seals a wrong number that the estimator is then forbidden to correct.** Post-capture,
the user is adjudicating a guess about a photo they have already stopped looking at, which is
exactly the situation where a plausible-but-wrong chip gets tapped.

Live, the food is in frame and the suggestion is next to it. A wrong suggestion costs nothing: the
user presses the shutter instead, which is what they were going to do anyway. The feature can only
be taken, never inflicted. That inverts the risk calculus, and it means the similarity threshold
can be set generously rather than defensively.

**Nothing on the capture path waits for this.** The shutter must remain what it is today —
compress, write two files, create a `pending` meal, done. Suggestions are an overlay that either
has an answer by the time the user decides, or does not.

## 3. Three similarity bands, not two

Cosine similarity has no absolute meaning, so there is a cutoff. There are usefully *two* cutoffs,
and the middle band is where a lot of the value is:

| Band | What happens |
| --- | --- |
| **High** (≥ `suggestThreshold`) | Shown as a tappable chip. The user skips estimation entirely. |
| **Medium** (≥ `contextThreshold`) | Nothing is shown. The matched meal's `meal-notes` is passed into the estimation prompt as context: *"a similar meal this user logged previously was described as: …"*. |
| **Low** | Nothing. Estimate exactly as today. |

The medium band is retrieval-augmented estimation, and it collects on the cheese-sandwich problem
even on the days the match is not good enough to tap. The model is handed the answer to the
question it was about to ask, so it does not ask it. It degrades harmlessly — a mediocre hint about
a different meal is a sentence the model can ignore, and it cannot make the estimate *worse* than
having no prior at all in any way that matters.

**This only works because `meal-notes` is the eater's words and nothing else.** Phase 5 established
that invariant to stop the clarify loop feeding the model its own output; it is load-bearing again
here, and more so. If descriptions the model wrote were eligible for retrieval, the fifth cheese
sandwich would be estimated from a chain of four of the model's own previous guesses, each labelled
as something a human said. Feed forward `meal-notes` only. Never `description`, never `name`.

## 4. Data model

Three new properties on `Meal`, in `lib/defaults/calorie-tracker.json`, imported by
`populate_default_store` (`lib/src/populate.rs`), with consts in `lib/src/urls.rs` and coverage in
`populate::tests::the_meal_ontology_seeds` — the same path every other property took (§4 of the
main plan).

| Property | Datatype | Notes |
| --- | --- | --- |
| `meal-embedding` (`mealEmbedding`) | string | base64 of the int8-quantized embedding vector. Written by `set_meal_embedding`, which writes it and `embedded-by-model` together or clears both |
| `embedded-by-model` (`embeddedByModel`) | string | which encoder produced it — see §9 on migration. Named to mirror `estimated-by-model` |
| `copied-from-meal` (`copiedFromMeal`) | atomicURL | set when this meal was logged by tapping a suggestion; points at the meal whose number it took |

There is no bytes datatype (`DataType` in `lib/src/datatype.rs`), so base64-in-a-`String` it is.
512 dimensions at int8 is 512 bytes, ~700 base64 chars. Scalar quantization to int8 costs
essentially nothing for cosine *ranking*, which is the only thing these are used for — the absolute
scores shift slightly, which is absorbed by calibrating the thresholds against quantized vectors
rather than float ones.

**The embedding lives on the meal, not in a sidecar cache next to the photos.** Two reasons, both
of which fall out of decisions already made:

- **Photos are evicted; this must not be.** §6's sweep drops the oldest photos against a byte
  budget, so a year-old meal has no image. An embedding is 512 bytes against a photo's ~250 KB — a
  full year of history costs well under a megabyte — so the thing being matched against outlives
  the thing it was computed from. The main plan's line is "photos are a cache, meals are the data";
  an embedding is squarely on the data side of it.
- **It syncs.** Meals travel and photos do not (Phase 6, §10). Today that leaves the second phone
  unable to do anything visual with a synced meal. An embedding on the resource rides along, so the
  phone that never took the picture still gets suggestions from it. This is a real win and it is
  free.

`copied-from-meal` is cheap now and painful to add later. A copy is epistemically different from an
estimate, and the difference matters when a user corrects "actually my cheese sandwich is 450" and
something has to decide whether the twelve copies of it are also wrong. It is also what stops
copies-of-copies drifting: when a suggestion is tapped, resolve the link transitively and point at
the *original*, not at the copy that was matched.

## 5. Encoder, and where it runs

> **License check, done in Phase 7.1 — MobileCLIP cannot ship.** Apple's weights are under
> `apple-amlr`, which grants use "exclusively for Research Purposes", defined as non-commercial and
> expressly excluding "product development or use in any commercial product or service". That covers
> MobileCLIP and MobileCLIP2, and it flows through the ONNX re-exports (`plhery/mobileclip2-onnx`
> carries it forward; `Xenova/mobileclip_s0` has the ready-made `vision_model_fp16.onnx` at 22.9 MB,
> under the same terms). Fine for a personal build, not for a distributed one.
>
> **The permissive answer is the alternative this section already names**: `facebook/dinov2-small`,
> Apache 2.0, 22.1M params — 384-d rather than 512-d, which changes nothing
> structural since §4's property is base64 of whatever length. It gives up the text tower, which §12
> had already put out of scope. So the license question and this section's own benchmark question
> turn out to have the same answer. Third tier if size dominates: MediaPipe's Image Embedder
> (MobileNetV3, ~5 MB, Apache 2.0), weaker on exactly the oatmeal-vs-chili discrimination below.
>
> Runtime either way: `flutter_onnxruntime` ≥1.5.1 (the floor for Play's 16 KB page-size rule) or
> `onnxruntime`. Both reach NNAPI and Core ML, which is this section's argument for a plugin.
>
> **Correction, made in 7.2: "~20–25 MB as ONNX fp16" was wrong.** That is MobileCLIP-S0's number,
> carried over by mistake. 22.1M params is 88.5 MB at fp32 and **45.5 MB at fp16**; the ~24 MB tier
> is int8. The feature costs 23–45 MB of app size, not 20–25, which is worth knowing before it is
> weighed against anything.

**Which weights ship was measured, not argued** (`calorie-tracker/tool/encoder-bench/`, and its
README has the full tables). Leave-one-out precision@1 over 23 photos in 6 dishes — the metric the
suggestion row actually implements:

| | size | p@1 | intra−inter gap | ms/img (Mac CPU) |
| --- | --- | --- | --- | --- |
| fp32 (reference, never ships) | 88 MB | 0.957 | 0.461 | 56 |
| fp16 | 45 MB | 0.957 | 0.462 | 61 |
| **int8 (shipped)** | **23 MB** | **0.957** | **0.446** | **34** |

int8 retrieves identically at half fp16's size and 1.6× its speed, agreeing with the fp32 reference
at cosine 0.990 mean / 0.977 min. fp16 is a near-perfect copy of fp32 that costs 22 MB more and runs
*slower* — ORT's CPU provider has no native fp16 and inserts casts. **This is a Mac CPU result and
could invert on a phone**, where fp16 maps onto Core ML and the ANE while quantized ops sometimes
fall back to CPU; re-measure on the device this phase already owes.

Two more things fell out of the same run, neither of which this doc had an opinion on:

- **Pooling is the CLS token.** The ONNX export emits only `last_hidden_state` (1×257×384) — there
  is no `pooler_output` to default to, so this is a decision and not a lookup. CLS beat
  mean-of-patches (p@1 0.957 vs 0.826) and matched CLS+mean concatenated at half the storage.
- **The crop is a plain centre square**, not the training-faithful 87.5% one that
  `resize-shortest-256 + center-crop-224` amounts to; the faithful crop measured slightly *worse*.
  So §6's "centre-crop to square, consistently, in both directions" costs nothing to obey.

And §4's int8 storage quantization is confirmed free: round-tripping the 384-d vector through int8
moved neither p@1 nor the gap at three decimals.

The weights are not committed. `make model` fetches them into a gitignored `assets/models/`,
checksum-pinned — 23 MB of binary that only this app wants has no business in every clone of this
repo, and the pin is there because a silent re-export upstream would make every stored vector
incomparable with nothing to say so.

**MobileCLIP-S0** (Apple, CVPR 2024) or equivalent small image encoder. 512-d output, on the order
of tens of milliseconds per frame on an accelerated mobile path, ~20–30 MB shipped. Two properties
recommend it over a plain ImageNet feature extractor:

- Semantic rather than surface similarity. A colour histogram cannot tell a bowl of oatmeal from a
  bowl of chili — same bowl, same lighting, same kitchen — and this app's whole corpus is one
  person's plates in one person's kitchen, where surface features are nearly constant and therefore
  nearly useless.
- It is a *shared* text/image space, which makes §7's typed-entry matching fall out for free rather
  than needing a second model.

DINOv2-small is the alternative worth benchmarking during calibration: self-supervised instance
similarity is arguably a better fit for "is this the same dish" and it is a drop-in swap at this
interface. It gives up the text tower.

**Run it through a Dart plugin (`tflite_flutter` or `onnxruntime`), not through `candle` in the FRB
crate.** For a one-shot post-capture embedding the Rust path would win — one bridge call, matching
next to the data, pure-Rust cross-compilation with no C++ toolchain surprises, which given this
repo's build notes is not nothing. Continuous inference flips it: candle on mobile is CPU-only, so
a sustained 2–3 Hz would be several times slower and materially hotter, while the camera is
*already* running. The Dart plugins reach NNAPI on Android and Core ML / the Neural Engine on iOS.
Power is the deciding factor and it points at the plugin.

Inference goes on an isolate. iOS plugins here go through SPM, so no `pod install` is needed (see
the app's CLAUDE.md); Android gains a native `.so` per ABI, which adds to the per-ABI build cost
already documented there.

## 6. The live pipeline

`CameraController.startImageStream` gives YUV420 on Android and BGRA8888 on iOS. Sample at
**2–3 Hz** rather than processing every frame; request a low preview resolution so the downsample
is cheap. Four things this has to get right:

- **One preprocessing path, used twice.** The query is a preview frame; the index was built from
  stored photos. If those two are preprocessed differently — different crop, different resample,
  one JPEG-compressed and one not — the scores drift and the thresholds stop meaning anything.
  Avoid the domain gap entirely by **embedding the camera frame at capture, not the re-decoded
  JPEG**. It is the same pixels the preview was matching against, and it is cheaper. Center-crop to
  square, consistently, in both directions.
- **Hysteresis.** Re-ranking every 300 ms as the phone moves produces a chip row that flickers
  between candidates, which reads as broken software. Smooth the query vector with an EMA over the
  last few frames, and require a new candidate to beat the incumbent by a *margin* before it swaps
  in. The target is a list that changes when the user re-aims and is otherwise still.
- **A garbage-frame gate.** Most of what the camera sees on the way to the plate is a table, a lap,
  or motion blur. The threshold handles most of this for free — nothing in the history matches a
  blurred table — but a cheap blur/motion check before spending an inference saves battery and
  stops the row twitching while the phone is being raised.
- **Battery is bounded by the viewfinder being up.** This is seconds at a time, not a daemon.
  Stop the stream on `paused` and when the app navigates off the capture screen. Do not design
  around a cost that only exists while the user is actively pointing a camera at lunch.

## 7. Matching

**There is no vector database, and there should not be one.** Four meals a day for a year is ~1,500
vectors. Brute-force cosine over 1,500 × 512 int8 is well under a millisecond in Rust and a few
milliseconds in Dart, and stays comfortable past 50k — an order of magnitude beyond anything this
app will hold. A flat array scanned linearly is the whole implementation. No HNSW, no sqlite-vec,
no ObjectBox vector search, no index to corrupt or rebuild.

The one thing that *would* make it slow is re-reading and re-decoding every meal resource per
frame. Keep a decoded matrix in memory, built once, and invalidate it on meal write, delete, and
sync-import. Rebuilding is a table scan; doing it per capture is fine, per frame is not.

Candidate filtering, before ranking:

- Only meals with a calorie number and a settled status (`estimated` / `confirmed`). A `pending`,
  `failed` or `needs-info` meal is not an answer to anything.
- **Dedupe the result set by meal identity, not by score.** Someone who eats the same breakfast
  forty times otherwise gets four chips that are all the same breakfast. Collapse by
  `copied-from-meal` lineage and by normalized `name`, take the best-scoring representative of
  each, and *then* take four. Four suggestions should be four different meals.
- Prefer recency between near-equal candidates. If a sandwich was 380 kcal last month and 420 last
  week, last week is the better prior.

Below `suggestThreshold`, fall back to a **frequency list**: the most-logged distinct meals of the
last 30 days. This is not a stepping stone to be discarded — it is the below-threshold behavior and
the cold-start behavior, and it needs to exist regardless. It is also the honest baseline the
embedding has to beat during calibration (§10); if it turns out to capture most of the value for
routine eaters, that is worth finding out from the data rather than assuming either way.

## 8. UX

- **Capture screen.** A row of up to four chips above the shutter: thumbnail, name, kcal, and how
  long ago. Absent entirely when there is nothing above threshold — an empty row, a spinner or a
  "no matches" state is worse than nothing, because the row is not something the user asked for.
- **A tap logs the meal immediately** with the source meal's calories, bounds, macros and
  `meal-notes`, status `confirmed`, `copied-from-meal` set to the resolved original. The "Logged ✓"
  chip is the same one the shutter shows.
- **A tap also captures the frame.** The camera is live and the write path already exists; a tap
  that skips the photo is a tap that makes every future match slightly worse, and it leaves the
  day's list with one row that has no picture for no reason the user can see.
- **Undo, briefly.** A snackbar with an undo on the "Logged" chip, for the mis-tap. Not a
  confirmation dialog — the whole feature is that it is one tap.
- **Cold start is silence.** Nothing at all for the first weeks, until there is history. No
  explanatory empty state; the feature simply appears once it works.

## 9. Encoder migration

An embedding is only comparable to embeddings from the same encoder. Swapping models — or a plugin
that quietly changes preprocessing — invalidates the whole index, and **the photos needed to
recompute it have been evicted**. That is the one genuinely irreversible hazard in this design.

`embedded-by-model` makes the damage detectable: match only within one model id, and a change means
suggestions go quiet for a while rather than going wrong. To make it *recoverable*, keep a ~~64px~~ **256px**
embedding-source thumbnail per meal that the sweep never evicts — ~~a few KB~~ **~25 KB** each, on
the order of ~~4 MB~~ **30 MB** for a year, against a photo budget already measured in hundreds.
Then a model change is a background re-embed rather than a permanent hole in the history.

(64px was the wrong number, and 7.1 found out why: every candidate encoder takes a 224–256px input,
so a 64px source has to be upscaled 4× before it can be encoded — which manufactures the very
domain gap §6 calls the thing that silently breaks everything else. See Phase 7.1 below for the
rest of what the policy came to.)

Decide this in 7.1, not later. Retrofitting a thumbnail policy only helps meals logged after the
retrofit, which is the same permanent hole one release further on.

## 10. Phased build plan

Each phase ends green: `flutter analyze`, `flutter test`, `cargo test` in `rust/`, and — because
this touches the ontology — `cargo test -p atomic_lib --features db-redb --lib --tests` from the
repo root (the app's `make check` does not cover it).

### Phase 7.1 — Ontology, storage, and the frequency baseline ✅ done

The three properties of §4, the 64px source thumbnail of §9 and its eviction exemption, and the
frequency-list suggestions of §7 wired into the capture screen with the real chip UI, the tap path,
`copied-from-meal`, and undo. No model, no plugin, no inference.

**Accept:** the ontology seeds and resolves; a tapped suggestion produces a `confirmed` meal
carrying the source's numbers and notes, linked to the resolved original, with the frame captured;
the sweep never evicts a source thumbnail; suggestions are absent on a fresh install.

How it landed, and where it left the plan:

- **The embedding source is 256px at quality 90, not the 64px this doc sketched.** Small image
  encoders take 224–256px square inputs — MobileCLIP-S0 is 256, DINOv2-S is 224 — so a 64px source
  would have to be upscaled 4× before it could be encoded at all, building in exactly the
  preprocessing mismatch §6 says silently breaks every threshold. 256 is the floor that feeds either
  candidate without inventing pixels. Quality 90 because this copy exists to be *re-encoded* and
  lossy artifacts compound across passes; it is also the only stored artifact whose consumer is a
  model rather than an eye. The cost is ~25 KB a meal, against a photo budget measured in hundreds
  of megabytes.
- **The sources are outside the byte budget, not merely exempt from eviction.** Counting files
  nothing can evict would permanently consume headroom the sweep has no way to reclaim, and would
  make "over budget with nothing left to evict" the steady state rather than the bug report it is
  meant to be. `ImageStore.sourceBytes()` reports them apart, and the account screen shows them on
  their own row.
- **They survive "delete all photos now" too**, which is the one thing here that reads as
  inconsistent and is not. Everything else that button deletes is a picture, and the meal, its
  calories and its notes are untouched. A deleted source is different in kind: it is the sole
  remaining input to re-encoding that meal, so deleting it silently removes that history from every
  future suggestion, permanently — and the user asked to reclaim storage, not to forget what they
  eat. The whole directory weighs about one photo's worth of what they were deleting. The dialog
  says so.
- **They are still collected as orphans.** Exempt from eviction is not exempt from belonging to a
  meal: an undone suggestion tap and a crash between the two writes both leave one behind, and
  nothing else would ever pick it up.
- **`copy_meal` copies the numbers and the eater's words, and nothing a model wrote.**
  `description`, `estimate-confidence`, `estimated-by-model` and `clarifying-question` are an
  account of a *different photograph*; carrying them would make the new meal claim to have been
  estimated when nothing has looked at it, and a `confirmed` meal carrying a question is one nobody
  can answer. `meal-notes` is the exception, and is the reason the feature is worth having.
- **Lineage is resolved at write time, in the bridge.** §4 asks for the link to point at the
  original; doing it in `copy_meal` rather than at the call site means every copy is one hop from
  the meal that was estimated no matter what produced it — the chip, a future re-log, anything.
  Bounded to 8 hops, because a cycle can only arrive from a corrupted store or a sync that met one,
  and neither is worth hanging the shutter over.
- **A meal with no calorie count is refused rather than copied as "unknown".** A suggestion exists
  to save an estimate, and one with no number saves nothing while quietly logging a meal that no
  longer looks like it is waiting for anything.
- **`minTimesLogged = 2` is what makes cold start silent.** "The most-logged meals of the last 30
  days" is technically satisfied by a single meal on a phone that holds one, and §8 asks for nothing
  at all until the feature works. One log is something that happened; two is something the eater
  does.
- **Grouping is two passes, lineage then name.** Lineage first because it is the stronger claim — a
  copy took its numbers from the original, so they are the same meal even after one is renamed —
  then merging lineages that came out with the same name, which is what collapses meals estimated
  from separate photos. The newest member represents the group, which is also how §7's recency
  preference falls out: its photo is the one most likely to still exist, and its numbers are the
  ones the user last agreed to.
- **A tap takes the picture, but a camera that cannot produce a frame is no reason to refuse the
  meal.** The simulator has no camera and that is a supported state everywhere else in this app. The
  numbers are the point; the photo is a cache.
- **`set_meal_embedding` exists with no encoder to call it.** A property that can be read and never
  written is not really seeded, and writing it blind in 7.2 is how the round trip goes untested.
  It is fifteen lines and it makes 7.2 purely about the model.

### Phase 7.2 — The encoder, offline

The plugin, the isolate, the preprocessing path, and embedding on capture. Backfill embeddings for
meals whose photos still exist. No live preview yet — this phase is about producing vectors and
proving they are stable.

Settled first, off-device, before any Dart (see §5 and `calorie-tracker/tool/encoder-bench/`):
DINOv2-small int8, CLS pooling, 384-d, centre-square crop, weights fetched by `make model` rather
than committed.

**And one bug in 7.1, which the same harness found.** `ImageStore` wrote the embedding source
through the ordinary long-edge cap, so a 4:3 frame was stored 256×192 and the encoder got a 192px
square upscaled to 224 — the exact preprocessing mismatch §6 says silently breaks every threshold,
built into the one file that exists to survive an encoder change. Measured against the
full-resolution original:

| stored artifact | mean agreement | worst | size |
| --- | --- | --- | --- |
| full photo, 1024/q80 | 0.9991 | 0.9971 | 105 KB |
| **source 256×256 square (now)** | **0.9866** | **0.9482** | 24 KB |
| source 256px long-edge (7.1) | 0.9174 | **0.6529** | 18 KB |
| source 64px (this doc's first sketch) | 0.7864 | 0.6698 | 3 KB |

A meal whose stored source sits 0.65 from its own photo is unrecognisable to its own re-encoding.
Fixed for ~6 KB a meal via `ImageCompressor.compressSquare`, and the geometry it pins — centre
square of the short edge — is the one the live preview must use on camera frames too. Two paths,
one geometry, or 7.3's thresholds are calibrated against an artifact of cropping. (The 64px row
also confirms 7.1 was right to reject the original sketch, for a reason it could only argue.)

**Accept:** every new meal gets a `meal-embedding` and an `embedded-by-model`; two photos of the
same dish score materially higher against each other than against a different dish (a small fixture
set, asserted as a *ranking*, not against an absolute number); embedding a camera frame and
embedding the JPEG written from that same frame agree closely — this is the §6 domain-gap check and
it is the one that silently breaks everything else.

### Phase 7.3 — Live suggestions ✅ done

The preview stream, the throttle, the EMA and hysteresis, the blur gate, the cached matrix and its
invalidation, and the high band wired to the chips built in 7.1.

**Accept:** suggestions appear within a few hundred ms of pointing at a known meal and are stable
while the phone is held still; the shutter path is unchanged and unblocked (the startup and capture
tests from Phases 3–4 still pass untouched); the stream stops on `paused` and on navigation away.

How it landed, and where it left the plan:

- **"One geometry" became one *function*, and it now has a test that fails.** §6 asks that the
  query and the index be preprocessed identically; 7.2 made that a convention and 7.3 makes it a
  call — `squareFromPixels` and `squareImage` differ only in how the `ImageDescriptor` is built and
  share every line after it. `test/square_crop_test.dart` runs a synthetic frame through both sides
  and asserts they agree within 3/255 per channel, which is the domain-gap check in miniature, in a
  second, on every commit rather than only on a device.
- **The camera feed hands over the centre square, not the frame.** Everything downstream wants that
  square and nothing wants the rest, so converting a 1280×720 frame in full would be 44% of the
  pixels, three times a second, on the phone that is also running a camera. The crop is the same
  centre square the geometry above specifies, so the claim survives the optimisation.
- **The stream format is no longer `jpeg`.** `DeviceCamera` asks for `yuv420` on Android and
  `bgra8888` on iOS, because those are the two `camera_frame.dart` knows how to read; a format it
  does not recognise is silently no suggestions rather than a guess. `takePicture` still writes a
  JPEG either way — `imageFormatGroup` is about the stream.
- **Hysteresis is not a score nudge, and that was the one thing here that had to be got right
  twice.** Adding a margin to each incumbent's score makes *membership* sticky but does nothing for
  *order*: once two chips are both on screen the nudge cancels out and they swap on any lead at all,
  which is precisely the flicker it was supposed to stop. So the rule is stated directly instead —
  the row starts in the order it is already in and nothing overtakes what it does not beat by the
  margin — with the margin doing the membership half separately, as slack below the threshold. Both
  halves are asserted, the ordering one against its own control.
- **The gate is two checks, not one, and both come off the same reads.** A motion check over a
  coarse luma grid (the phone is being raised, not aimed) and a Laplacian variance over the middle
  of the frame at *native* adjacency — measured on a downsample everything looks equally blurred,
  which is the same as measuring nothing. Behind both, the strongest throttle there is and the only
  one that adapts to the phone it is on: an inference already running.
- **Cold start costs nothing at all.** An empty index short-circuits before the gates, so a fresh
  install spends no battery deciding it has nothing to say.
- **The row is one ranking or the other, never a mixture.** "This looks like your cheese sandwich"
  and "you often have porridge" are not the same kind of claim, and only one of them is about what
  is in frame. Above threshold the matches are the row; below it, §7's frequency list is.
- **Navigating away counts, and a sheet is navigating away.** §6's "battery is bounded by the
  viewfinder being up" is only true if something ends the stream, so `_away` wraps every route and
  every sheet the capture screen opens — a keyboard over the preview is not somebody aiming at a
  plate.

### Phase 7.4 — The medium band ✅ done

`meal-notes` from a medium-scoring match passed into the estimation prompt as prior context.

**Accept:** an estimate for a meal with a known prior does not re-ask a question that prior already
answers; `description` and `name` are never fed forward — assert this directly, it is the
invariant Phase 5 exists to protect and the easiest thing here to break by accident.

How it landed, and where it left the plan:

- **The prior is retrieved when the meal is *estimated*, not when it is captured.** The obvious
  implementation is to reuse the live query the viewfinder already has, and it is wrong: most
  estimates do not happen in front of a viewfinder. A meal drained on next launch, a backfilled one,
  one the OS finished in the background, one that arrived over sync — none of those has a camera
  behind it, and those are exactly the meals that have been waiting long enough to be worth getting
  right. So `MealPriors` takes a meal and does its own lookup, and the capture path is untouched.
- **Which means the estimator sometimes embeds the meal itself**, through `EmbeddingQueue.embed` —
  one local inference of tens of milliseconds in front of a network call that takes seconds, and the
  vector is *stored*, so the backfill that would have reached that meal eventually now does not have
  to. Asking the queue rather than the encoder is what stops that being work done twice.
- **`MealIndex` carries exactly one string per meal**, and it is `meal-notes`. §3 says the invariant
  is load-bearing here and more so than in Phase 5; making it a property of what the index holds,
  rather than a rule at the call site, means there is nothing else for a future caller to reach for.
  The name and the description never leave the index at all.
- **A prior is background and never input.** A meal with no photo and nothing written down still has
  nothing to estimate, whatever this person once said about a different one — the client refuses it
  exactly as before. And the two are labelled apart in the prompt, because merging them would tell
  the model that somebody said this about *this* plate, which is the one thing that is not true.
- **Exclusion is by lineage, not by subject.** A settled meal being re-estimated would otherwise
  retrieve itself, and a meal copied a dozen times would retrieve the copies that took their words
  from it. Neither is prior knowledge; both are the meal talking to itself.
- **Nothing here may fail a meal.** A prior makes an estimate better and its absence makes the
  estimate exactly what it was before this phase, so losing one because a *hint* could not be worked
  out would be an absurd trade. It is caught twice, in `MealPriors` and again in the queue.
- **The index is read before the first drain**, which reversed one line of `main.dart`: the
  estimator now asks it something, and an index nobody has loaded has nothing to say. The *backfill*
  still runs behind the estimates, because a phone with a year of history to get through would
  otherwise delay every one of them.
- **The starting thresholds are `suggestThreshold` 0.55 and `contextThreshold` 0.35**, from
  `tool/encoder-bench/` (inter-dish similarity averages 0.080, real intra-dish runs 0.50–0.65) and
  gathered in one place in `LiveSuggestions` and `MealPriors` with a note saying so. They are
  guesses off stock food photography and §11 still owns them.

## 11. Calibration is the actual work

The code is small — the matching is a loop. What cannot be compressed is picking
`suggestThreshold`, `contextThreshold`, the EMA window and the hysteresis margin, and those come
only from pointing a real phone at real repeated meals over real days. A fixture set of stock food
photos will produce numbers that are wrong on a kitchen table in evening light.

So: build 7.1–7.3 quickly, then **live with it for a week before tuning anything**, logging every
frame's top score and whether the suggestion was taken. The thresholds fall out of that log. Two
measurements worth having from it:

- **Tap-through rate against the frequency baseline of §7.** How much does the embedding actually
  add over "the four things you eat most"? If the answer is "little", that is a real finding, and
  7.4 may be where the value was all along.
- **Clarify-rate before and after 7.4.** The medium band's whole justification is that it stops the
  repeated question. Watch it.

This is also the phase that finally needs a device, which Phase 6.1 already owes. Fold them.

## 12. Open questions

- **Does the query need to be the food, or the plate?** Center-cropping assumes the meal is
  centered. A wide shot of a full table is a different problem, and a saliency crop or an on-device
  detector is a plausible answer that is out of scope until the calibration log says it is needed.
- **Cross-device index freshness.** An embedding syncs with its meal, so the second phone matches
  against the first phone's meals — but only after a sync, and sync happens on launch and on
  foreground (Phase 6). Suggestions are best-effort against whatever has arrived. Probably fine;
  worth confirming it does not read as flaky in practice.
- **Correcting a source meal.** When a user fixes the calories on a meal that twelve others were
  copied from, should the copies follow? `copied-from-meal` makes it *possible*. Rewriting settled
  history behind the user's back is the kind of thing that is right in the abstract and alarming in
  a list of days. Leave it inert until someone asks.
- **The text tower.** MobileCLIP's shared space means a typed "cheese sandwich" could retrieve past
  cheese-sandwich *photos*, folding this feature into the keyboard path. Cheap once 7.2 lands,
  since it is the same model. Not scoped here.
- **Two paired phones can both embed the same typed meal**, the same way they can both estimate one
  (Phase 6). Same conclusion: not worth a lock.
