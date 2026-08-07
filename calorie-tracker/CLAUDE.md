# Calorie Tracker

Snap a photo of a meal, get a calorie estimate, store it in a local atomic
database. Flutter + Rust, iOS and Android, no backend server.

Plan: [`../planning/calorie-tracker-plan.md`](../planning/calorie-tracker-plan.md)
(architecture, data model, phases). Product brief:
[`../planning/calorie-tracker-app.md`](../planning/calorie-tracker-app.md).

**Status: Phase 7.4 complete, and Phases 6.1/7.3/7.4 unverified on a device.** The app onboards — one
tap to a new account, or a pasted secret to restore one — persists the session,
and lands on a viewfinder. The shutter writes a compressed photo and a `pending`
meal and is done; the day's total is on top of the preview and the list is one
tap behind it. A queue drains those pending meals through a vision model on
OpenRouter, on launch, after each capture and on resume, and writes back a name,
a number and a range. Meals can still be typed in by hand — with a number, which
confirms them, or without one, which asks the model instead. When the model
cannot finish without knowing something, it asks: the question goes on the meal
*and* on the lock screen, tapping it opens that meal, and the answer re-estimates
it. Past days are behind the calendar icon, one row each with what they came to. Two
phones can now hold the same meals: pair them with a QR code and each syncs with
the other on launch and on every return to the foreground. The queue no
longer needs the app to be open — on the way out it hands what is left to the
OS, which finishes it on Android and, when it feels like it, on iOS. And a meal
eaten often enough turns up as a chip above the shutter: one tap logs it with
that meal's numbers, confirmed, with no model call and no waiting. Every
photographed meal carries a 384-number fingerprint of its picture, computed on
the device by a small vision model, and the viewfinder now matches what it can
see against them a few times a second — so pointing the camera at a meal this
person eats offers *that* meal rather than merely the ones they log most. A
match too weak to offer is still worth something: what they wrote about it goes
to the estimator as background, which is how the model stops asking the same
question about the same sandwich every week.

## When writing code

Do not commit changes after you finish a task. The human will do it themselves.

## Layout

```
lib/
  main.dart            app + SessionGate: renders whatever phase the session is in
  startup.dart         the cold-start-to-live-preview stopwatch
  theme.dart
  atomic/              the Atomic Dart SDK — see "Shared SDK" below
  models/meal.dart     Meal, MealStatus, localDayBounds, DaySummary
  services/
    app_session.dart   who is signed in and where their meals go; owns the boot
    meal_store.dart    one day's meals, and the writes to them
    meal_suggestions.dart  which past meals to offer above the shutter
    meal_encoder.dart  the image encoder: a photo in, 384 numbers out
    embedding_queue.dart  which meals still need one — capture and backfill both
    meal_index.dart    the decoded vectors, in memory, scanned by brute force
    live_suggestions.dart  what the camera can see, matched against that index
    meal_priors.dart   what this person wrote about the nearest meal to this one
    square_crop.dart   the one crop geometry, shared by every path into a model
    camera_feed.dart   the camera, behind a seam; DeviceCamera is the real one
    camera_frame.dart  a preview frame's centre square, as RGBA
    image_store.dart   compress, store, count, evict — all of the plan's §6
    openrouter.dart    the key, the model catalogue, and the estimate call
    estimation_queue.dart  drains the pending meals through one of those models
    notifications.dart the question on the lock screen, and the tap back in
    sync_service.dart  the other devices: how many, and what they had
    background_estimation.dart  the queue, continued after the app is gone
  screens/
    capture_screen.dart    home: the viewfinder, the shutter, the day's total
    today_screen.dart      the day's total and its meals, one tap behind home
    history_screen.dart    the days behind today, one row each
    meal_entry_sheet.dart  type a meal, correct one, or answer its question
    meal_actions.dart      what opening that sheet means, wherever it opened from
    account_screen.dart    the agent, the secret, the photo budget
    openrouter_screen.dart connect or disconnect, and pick the model
    sync_screen.dart       the other devices, and a sync on demand
    onboarding/        first launch, and the "my data is on the other phone" case
    pair_screen.dart   QR pairing, from the canvas app
  widgets/             error_snack.dart, meal_photo.dart
  src/rust/            flutter_rust_bridge output — generated, never hand-edit
rust/                  the FRB crate, rust_lib_calorie_tracker
  src/api/simple.rs    the generic bridge — copied from the canvas app
  src/api/meals.rs     what this app owns: the container, meal CRUD, day queries
rust_builder/          cargokit build integration (vendored, locally patched)
```

Everything goes through `AppSession` and `MealStore`. No screen calls `setup()`,
opens the store, or touches `AtomicSession` or the bridge itself — the boot
happens once, in one place, and screens render `session.phase`. `main.dart` owns
all of it now: the session, the camera, the image store, **the meal store**, the
OpenRouter account and the queue. The meal store moved up there in Phase 4 for a
concrete reason — there is a second writer, and the day behind the viewfinder,
the day in the list and the day the estimator is filling in have to be one
answer. Every service with a platform behind it has a seam — `AtomicBackend`,
`MealBackend`, `CameraFeed`, `ImageCompressor`, `MealEncoder` — and that is what makes the
flows testable
without a Rust library, a camera or a codec: `test/fake_atomic_backend.dart`
models the store and the process separately, which is exactly the difference a
relaunch tests, `test/fake_meal_backend.dart` models the meals table, and
`test/fake_camera.dart` models the three states a viewfinder is ever in.

## Capture, and why nothing on that path waits

The shutter compresses the frame, writes two files, and creates a meal with no
name and no number. That is the whole path, and it is finished by the time the
"Logged" chip appears — kill the app there and nothing is lost. What the meal is
worth is Phase 4's problem, and `pending` is exactly the queue it will drain.

Three things follow from that and are easy to undo by accident:

- **`calories` is `Option` all the way up.** A capture has no number, and
  "unknown" counted as zero is a day total that is wrong in the direction that
  matters. `DaySummary` keeps the unestimated count separate for the same reason.
- **The sweep runs *after* the meal is written**, never before. It decides what
  to evict from the list of meals, so a photo whose meal does not exist yet is an
  orphan it would delete on its way past.
- **Photos are a cache; meals are the data.** Every read of a photo can come back
  empty, and `ImageStore.load` returns null rather than throwing. Eviction is
  silent by design — the meal, its calories and its thumbnail all survive, so
  there is nothing to interrupt anyone about.

`ImageStore` holds all of the plan's §6: one JPEG at 1024px/q80 plus a 256px
thumbnail, both encoded straight off the camera frame (one lossy pass each, not
two stacked); a byte budget with a `SharedPreferences` counter and a full
recount on every sweep; eviction oldest-first to 10% below the budget, skipping
any meal the estimator still needs and never touching a thumbnail; and an orphan
pass every time. The format and the sizes are constants in one place, which
is what would make the WebP question (plan §10) a one-line change.

Since Phase 7.1 there is a **third artifact per capture**, in `sources/`: a
256px/q90 copy that exists to be *re-encoded* when the image encoder changes.
Three things about it, all of which are easy to undo by accident:

- **It is outside the byte budget, not merely exempt from eviction.** Nothing
  can evict it, so counting it would consume headroom the sweep has no way to
  reclaim and make "over budget with nothing left to evict" the steady state
  rather than the bug report it is. `sourceBytes()` reports it apart, and the
  account screen gives it its own row.
- **It survives `deleteAll()` — "delete all photos now" — as well as the
  sweep.** The one thing here that reads as inconsistent and is not: everything
  else that button deletes is a picture, and the meal, its calories and its
  notes are untouched either way. This file is the sole remaining input to
  re-encoding that meal, so deleting it removes that history from every future
  suggestion permanently, and the user asked to reclaim storage rather than to
  forget what they eat. The whole directory weighs about one photo's worth of
  what they were deleting.
- **It is still collected as an orphan.** Exempt from eviction is not exempt
  from belonging to a meal — an undone suggestion tap leaves one behind, and
  nothing else would ever pick it up.

It is 256px and not the 64px the plan sketched because every candidate encoder
takes a 224–256px input, so a 64px source would have to be upscaled 4× before it
could be encoded — manufacturing exactly the preprocessing mismatch that makes
similarity thresholds meaningless. q90 because artifacts compound across
re-encodes, and this is the only stored artifact whose consumer is a model.

- **It is a 256×256 *square*, and that is not the same as 256px.** This is the
  one thing here that has already been got wrong once. 7.1 wrote it through the
  ordinary long-edge cap like the photo and the thumbnail, so a 4:3 frame was
  stored 256×192 — and since an encoder needs a square, it got 192px upscaled
  to 224. Measured against the full-resolution original, that copy agreed at
  cosine 0.917 mean but **0.653 at worst**, against 0.987/0.948 for a true
  square: a meal unrecognisable to its own re-encoding, in the file whose sole
  purpose is surviving an encoder change. `ImageCompressor.compressSquare` is
  the fix and costs ~6 KB a meal. The geometry it pins — centre square of the
  short edge — is what the live preview stream must apply to camera frames too.
  Two paths, one geometry, or every threshold in 7.3 is calibrated against an
  artifact of cropping. `tool/encoder-bench/` is where those numbers come from.

## Estimation, and the four things it must never do

`EstimationQueue` reads `list_pending_meals()`, sends each meal's stored photo
(or the words the user typed) to a vision model on OpenRouter, and writes the
answer back with `update_meal_estimate`. One call in flight at a time; it runs
on launch, after every capture, on resume, and on demand from a `failed` row.
The whole pipeline is `openrouter.dart` (the wire) plus `estimation_queue.dart`
(the policy), and `MealStore` is the only thing either of them writes through.

- **It must not overwrite a `confirmed` meal.** A number a human typed beats an
  estimate that was in flight when they typed it. `update_meal_estimate`
  enforces that in Rust and returns `Ok` — it is two correct behaviours racing,
  not a mistake to report. Do not "fix" it by making it an error.
- **It must not fail a meal it simply cannot reach yet.** Two ways that
  happens. The documents directory is found in parallel with the store, so a
  drain can start before there is anywhere to read a photo from — those meals
  are *skipped*, left `pending`, and picked up by the drain `main.dart` fires
  when the directory lands. And since Phase 6, a paired device sees meals whose
  photo is on the *other* phone, which are skipped for a sharper reason: see
  `EstimationQueue.paired` under Sync. Failing either would throw away the
  estimate's only input.
- **It must not retry what will fail again.** A 429, a 5xx or a dead socket gets
  three goes with a doubling backoff; a rejected key, a refused request or an
  answer that is not the JSON the schema asked for gets one. Every attempt is
  billed, and a model that just broke a strict schema will break it again. The
  meal goes `failed`, keeps its photo, and offers the user a retry.
- **It must not lose the user's words.** Structurally, since Phase 5: what the
  eater wrote lives in `meal-notes` and `update_meal_estimate` does not write
  that property. Their words are the more reliable half of the record and the
  only part nobody can reconstruct, and they are also the *only* thing the queue
  sends as "the person who logged it wrote" — never the name or the description,
  which after one estimate are the model's own. Phase 4 did this by folding the
  words into the description first (`MealEstimate.keeping()`); that could not
  survive a second re-estimate, which is exactly what the clarify loop does.

Two more things about the shape:

- **`needs-info` is decided by the question, not by the confidence.** Low
  confidence on its own is a wide range, which `calories-min`/`calories-max`
  already say. A meal is only `needs-info` when the model asked something, and
  that question is stored on the meal — a "needs an answer" chip with nothing
  behind it is a dead end.
- **`estimating` is a queued status, not an in-flight one.** The only thing that
  sets it is a call in this process, so one found at launch is what a killed app
  left behind. `list_pending_meals` returns it alongside `pending` for exactly
  that reason, and the queue skips subjects it is currently holding itself.

There are two ways to get a key in: OpenRouter's OAuth PKCE flow, and pasting one made by hand on
openrouter.ai/keys. Both end in the same keychain slot, so nothing downstream knows the difference.
A pasted key is checked with `GET /api/v1/key` before it is stored — unverified, a typo is silent
until the next meal, which then fails on a 401 the queue will not retry.

The key lives in the platform keychain next to the agent secret. For
development, `--dart-define=OPENROUTER_API_KEY=…` bakes one in as a *fallback* —
`make ios` / `make android` / `make apk` pass it through from the environment —
and a key someone signed in with on the device always wins, so a dev build never
quietly bills the wrong account.

## The clarify loop, and why it terminates

A `needs-info` meal is the estimator saying it cannot finish without knowing
something. The loop that closes it: the queue posts the question through
`Notifier`, a tap brings the app up on that meal's sheet, the answer goes into
`meal-notes`, and the same button that saves it re-estimates. `test/
clarify_flow_test.dart` is the whole thing end to end, on purpose — an answer
saved but not sent, or sent but not saved, leaves the meal exactly as stuck as it
was, and either half still passes on its own.

- **`meal-notes` is the eater's words and nothing else.** `update_meal_estimate`
  does not write it, `create_meal`/`update_meal` take it *instead of* a
  description, and `EstimationQueue._words` reads nothing else. That is what
  makes a second round work: without it the model gets its own last reasoning
  back labelled as what the user wrote, and it compounds every time.
- **Answering and re-estimating are one action.** `SaveMeal.reEstimate`, not a
  second button — and the re-estimate re-reads the meal first, because the answer
  that was just written is its entire input.
- **The queue owns the question's whole life.** It posts on `needs-info`,
  withdraws when a later estimate has nothing left to ask, and `forget(subject)`
  is the meal being answered by hand or deleted. A question outliving its meal is
  the one way a notification becomes a dead end.
- **Permission is asked for at the first question, not at launch.** There is
  nothing to notify about on a fresh install, and a dialog in front of an app
  nobody has used yet is the reliable way to be told no forever.
- **A tap is resolved against the database.** `get_meal` returns null for a meal
  that has been deleted or answered elsewhere since, and `main.dart` waits for
  `SessionPhase.ready` — a tap that *launched* the app arrives before there is a
  store to look anything up in. It listens to the session and to the tap, because
  those two land in either order.

`meal_actions.dart` is where "what a saved sheet means" lives, because four
things open that sheet now: the viewfinder, today's list, a history day, and a
notification tap with no screen behind it at all.

## Suggestions, and why they are above the shutter

A meal eaten often enough appears as a chip over the viewfinder: thumbnail,
name, kcal, how long ago. Tapping it logs a `confirmed` meal carrying that
meal's numbers — no model call, no waiting, nothing for the queue to pick up.
`meal_suggestions.dart` decides which meals; `copy_meal` in the bridge writes
them. This is Phase 7.1 of `../planning/calorie-tracker-embeddings.md`, and
there is no encoder yet: ranking is by *frequency* alone.

- **Live, not post-capture, and that is the load-bearing decision.** A tapped
  suggestion writes a `confirmed` meal, and `update_meal_estimate` deliberately
  refuses to overwrite one — so a bad suggestion accepted after the fact does
  not merely annoy, it seals a wrong number the estimator is then forbidden to
  correct. With the food in frame the suggestion sits next to the thing it
  claims to be, and a wrong one costs nothing: the user presses the shutter
  instead, which is what they were going to do anyway. The feature can only be
  taken, never inflicted, which is what lets the bar be set generously.
- **Nothing on the capture path waits for it.** The shutter is unchanged. The
  chip row either has an answer by the time the user decides or does not.
- **A copy carries the numbers and the eater's words, and nothing a model
  wrote.** `description`, `estimate-confidence`, `estimated-by-model` and
  `clarifying-question` are an account of a *different photograph*: carrying
  them would make the meal claim to have been estimated when nothing looked at
  it, and a `confirmed` meal holding a question is one nobody can answer.
  `meal-notes` is the exception and is the whole point — the answer the eater
  gave weeks ago comes with it, which is the repeated clarifying question this
  feature exists to stop.
- **`copied-from-meal` always names an original.** `copy_meal` resolves lineage
  transitively before writing, bounded to 8 hops, so every copy is one hop from
  the meal that was actually estimated however many copies deep the thing that
  was tapped was. Doing it in the bridge rather than at the call site means it
  holds for anything that ever logs a copy.
- **Absent entirely when there is nothing to offer.** No empty row, no spinner,
  no "no matches" — this is not something the user asked for, and all three read
  worse than silence. `minTimesLogged = 2` is what makes a fresh install quiet:
  one log is something that happened, two is something the eater does.
- **Four chips are four different meals.** Grouped by lineage first (a copy and
  its original are the same meal whatever either is called), then by normalized
  name (meals estimated from separate photos that came out alike). The newest
  member represents the group, which is also where the recency preference comes
  from: its numbers are the ones the user last agreed to and its photo is the
  one most likely to still exist.
- **A tap takes the picture too**, because the write path exists and a tap that
  skipped it would leave the day's list with one row that has no picture for no
  reason the user can see. But a camera that cannot produce a frame is no reason
  to refuse the meal — the numbers are the point, the photo is a cache.
- **Undo is a snackbar, not a dialog.** The entire feature is that it is one
  tap; a confirmation would cost more than the mis-taps it prevents.

## The encoder, and why capture and backfill are one job

`meal_encoder.dart` turns a food photo into 384 numbers; `embedding_queue.dart`
decides which meals get them. This is Phase 7.2 — vectors exist and are stored,
but nothing matches on them yet, so suggestions are still ranked by frequency
alone until 7.3.

- **There is one drain, not an on-capture path and a migration.** A meal
  photographed a second ago and one photographed last March differ only in how
  far down the list they are. That also makes the awkward cases free: an app
  killed mid-encode, a model change, a meal that arrived over sync are all just
  "not embedded yet" and get picked up by the same loop rather than each needing
  somebody to have thought of them. It runs on launch, after every capture,
  after a one-tap suggestion, on resume, and after a sync.
- **Newest first.** A backfill over a year of history that ran oldest-first
  would leave the meal just photographed until last, which is exactly backwards:
  suggestions are about what this person eats *now*.
- **It reads the embedding source, never the photo.** The source is square,
  never evicted, and survives "delete all photos now". Encoding the photo would
  give a meal a different vector depending on whether its picture had been
  evicted yet — the same class of bug as a crop mismatch and harder to see.
- **`embedded-by-model` names the whole pipeline, not the weights file.**
  `dinov2-small-fp32-cls-224` — weights, quantization, pooling, input edge.
  Comparability depends on all four, so changing the crop and leaving the string
  alone would leave every old vector claiming to be comparable when it is noise.
  Changing the string *is* the §9 migration: the queue re-encodes the history
  from the sources in the background, and old suggestions go quiet for a while
  rather than going wrong. It has earned its keep twice already — int8→fp16→fp32
  below is exactly this, and cost nothing but a background re-encode each time.
- **A missing source is skipped; a missing model stops the drain.** The first is
  a meal whose photo is on the other phone (meals sync, photos do not) and is
  not a failure. The second means every remaining meal fails identically, and
  grinding through a year of history to discover that costs exactly as much
  battery as it sounds like.
- **`squareImage` in `square_crop.dart` is one function on purpose.** The index
  is built from stored JPEGs and 7.3's query will be a live camera frame that
  has been through no JPEG at all. If those two are cropped or resampled
  differently the scores drift and every threshold measures the difference
  between two preprocessors rather than between two meals. One function is how
  that stays true; `ImageStore` and the encoder both call it.
- **The vector is L2-normalized, int8-quantized, base64'd — and the scale is
  deliberately not stored.** Cosine is scale-invariant and ranking is all these
  are used for, so the scale would be bytes no reader could use. 384 bytes,
  ~512 characters, against a photo's ~250 KB, which is what lets an embedding
  outlive the picture it came from.
- **`decodeVector` normalizes, and that is not the caller's job.**
  `encodeVector` divides by the vector's *peak component* — that is what puts
  the int8 range to use — so the naive inverse has norm `1/peak`, which is 3–8
  rather than 1. Everything downstream scores by plain dot product on the
  promise that both sides are unit, so a caller that forgot got scores inflated
  by that factor, silently, because an inflated cosine is still a number of the
  right shape and sign. Three callers, and two of them had forgotten: the live
  query on its first frame (`_smooth` only normalized when it had something to
  merge with) and `MealPriors` entirely — which meant the medium band cleared
  `contextThreshold` almost always and fed the estimator an unrelated meal's
  notes as "what the eater wrote". Normalizing at the one place vectors are
  decoded is the only version of this that cannot be got wrong somewhere else.
- **Nothing waits for any of this and nothing shows a spinner.** An un-embedded
  meal is a meal that does not appear as a suggestion, which is invisible rather
  than broken — the same posture as every other read of a photo in this app.

`tool/encoder-bench/` is where the int8/CLS/centre-square choices came from, and
its README has the tables. Re-run it before changing any of them.

## The live viewfinder, and the four things it must not do

Phase 7.3. `camera_frame.dart` turns a preview frame into pixels,
`meal_index.dart` holds the decoded history, and `live_suggestions.dart` is the
policy between them: throttle, gate, smooth, rank. The chips, the tap, the copy
and the undo are 7.1's and unchanged — what is new is *which* four meals.

- **It must not preprocess the query differently from the index.** The index is
  built from stored JPEGs and the query is raw camera pixels that have been
  through no JPEG at all. If those two are cropped or resampled differently the
  scores drift and every threshold measures the difference between two
  preprocessors rather than between two meals — silently, because the numbers
  still look like similarities. `squareImage` and `squareFromPixels` are
  therefore one function with two front doors, and
  `test/square_crop_test.dart` runs a frame through both and asserts they agree
  within 3/255. The integration test makes the same check against the real
  model.
- **It must not cost anything when it has nothing to say.** An empty index
  short-circuits before the gates, so a fresh install spends no battery
  deciding it is a fresh install. Above that, a frame is skipped if the phone is
  moving (mean luma change over a coarse grid), if it is soft (Laplacian
  variance over the middle of the frame, at *native* adjacency — measured on a
  downsample everything looks equally blurred), or if an inference is already
  running, which is the strongest throttle there is and the only one that
  adapts to the phone it is on.
- **It must not keep running when nobody is looking.** §6's "battery is bounded
  by the viewfinder being up" is only true if something ends the stream, so
  `_away` in the capture screen wraps every route *and* every sheet — a keyboard
  over the preview is not somebody aiming at a plate — and the lifecycle handler
  stops it before it stops the camera.
- **It must not lag a re-aim.** The EMA and the motion gate interact, and got
  this wrong in both directions at once — together worth about three seconds of
  felt latency on a real phone. The gate lived *behind* the `_busy` check, so
  the grid it compared against was only replaced on frames that reached the
  encoder: at ~800 ms an inference the two frames being differenced were most
  of a second apart, ordinary hand-shake measured like a re-aim, and rejecting
  the frame pushed the next comparison further apart still. A threshold in
  luma-per-frame has to be sampled at a fixed interval or it is not one. And
  when the phone *was* swung to a different plate, the smoothed query still
  held 60% of the old meal, which at `smoothing` 0.6 needs four or five
  inferences to wash out. So: the grid updates on every frame, and a large view
  change clears `_query` — the same reasoning as `stop` clearing it, reached
  from the other end. The first inference on a new plate is now the answer
  rather than a fifth of it.
- **It must not flicker.** Two mechanisms, and they are not the same one:
  an EMA over the query vector steadies what is being asked, and the row starts
  in the order it is already in and nothing overtakes what it does not beat by
  `swapMargin`. **A score nudge per incumbent does not work** — it makes
  membership sticky but not order, and once two chips are both incumbents the
  nudge cancels out and they swap on any lead at all, which is the flicker it
  was meant to prevent. The margin does the membership half separately, as slack
  below the threshold.

Two more things about the shape:

- **The row is one ranking or the other, never a mixture.** Above threshold the
  matches are the row; below it, the frequency list is. "This looks like your
  cheese sandwich" and "you often have porridge" are not the same kind of claim,
  and only one of them is about what is in frame.
- **The camera feed hands over the centre square, not the frame.** Everything
  downstream wants that square and nothing wants the rest, so converting a
  1280×720 frame in full would be 44% of the pixels three times a second on a
  phone that is also running a camera. It is the same centre square the geometry
  above pins, so nothing about the claim changes.

Every threshold in `LiveSuggestions` is provisional and gathered in one place
for that reason. Cosine has no units: they come off a real phone over real days
(`../planning/calorie-tracker-embeddings.md` §11), and a debug build logs each
row change with its scores so there is something to read.

## The medium band, and the one string it may send

Phase 7.4. Below the chip threshold and above `MealPriors.contextThreshold`,
nothing is shown — instead the matched meal's `meal-notes` goes into the
estimation prompt as background, so the model is handed the answer to the
question it was about to ask. This is where most of the value of the whole
feature is: the cheese-sandwich question stops being asked every week.

- **`meal-notes` and nothing else. Never `description`, never `name`.** Phase 5
  made `meal-notes` the eater's words to stop the clarify loop feeding the model
  its own last answer; here it matters more. If text a model wrote were eligible
  for retrieval, the fifth cheese sandwich would be estimated from a chain of
  four of the model's own guesses, each labelled as something a human said.
  `MealIndex` carries exactly one string per meal for that reason — there is
  nothing else at that layer to reach for by mistake.
- **The lookup happens when the meal is estimated, not when it is captured.**
  Reusing the live query would have been free and is wrong: most estimates have
  no viewfinder behind them — a next-launch drain, a backfill, a background
  task, a meal that arrived over sync — and those are the ones that have been
  waiting longest.
- **So the estimator sometimes embeds the meal itself**, through
  `EmbeddingQueue.embed`: one local inference in front of a network call that
  takes seconds, and the vector is *stored*, so the backfill does not repeat it.
- **Exclusion is by lineage.** A re-estimate would otherwise retrieve itself,
  and a meal copied a dozen times would retrieve the copies that took their
  words from it. Neither is prior knowledge.
- **A prior is background, never input.** A meal with no photo and nothing
  written down still has nothing to estimate, and the prompt labels the two
  apart — merging them would say somebody wrote this about *this* plate, which
  is the one thing that is not true about it.
- **Nothing here may fail a meal.** Losing an estimate because a *hint* could
  not be worked out would be an absurd trade, so it is caught in `MealPriors`
  and again in `EstimationQueue`.

## Sync, and the one thing it changes about estimating

Two phones, one account, the same meals. The Rust side has done this since Phase
0 — Iroh peer pairing and an atomic-server websocket session — and Phase 6 is
everything above it: `SyncService` decides when, `SyncScreen` is where a device
is paired, and `main.dart` re-reads the day when something arrives.

- **Pairing is the opt-in; after that nobody presses anything.** `autoSync` runs
  on launch and on every return to the foreground, but only when this account
  actually has another device — `syncConnectivityNow` starts an Iroh node and
  asks the network where that device is, and doing that on a phone nobody has
  paired spends battery looking for something that does not exist. That is how
  the plan's "sync is optional and explicit" (§2) survives an automatic sync.
- **Meals travel and photos do not** (plan §10). A meal from the other phone
  arrives with a path to a file that was never written here. The sync screen says
  so, and `MealPhoto` already tolerates a missing file.
- **Which is why `EstimationQueue.paired` exists.** Unpaired, a queued meal whose
  photo is missing can only be "delete all photos now" — nothing will ever
  estimate it, so it fails and says so. Paired, it is almost certainly the other
  phone's meal, and failing it would be actively harmful: `failed` syncs *back*,
  and the queue does not pick failures back up, so this device would have talked
  the device holding the photo out of ever estimating it. So it is skipped, and
  the answer arrives by the same sync that brought the meal. `main.dart` keeps
  the flag in step with `SyncService`.
- **`waiting` is what this phone can do.** The drain filters the queue before it
  counts it, so a meal whose photo is elsewhere is not in the "Connect
  OpenRouter" banner's number. It is also why a drain that starts before the
  documents directory is known reports zero and then corrects itself — see the
  race note under Estimation.
- **Two paired phones can both estimate the same *typed* meal.** Nothing locks a
  meal to a device, so a text entry with no photo may be estimated twice, at
  ~$0.0002 each. Photographed meals cannot: only the phone holding the picture
  can do anything with them. Worth a lock only if it ever costs more than that.
- **`ServerSettingsSection` and `PairScreen` are the canvas app's**, unchanged
  except for one layout fix (the pair/connect buttons wrap now — side by side
  they are wider than a phone). That fix is ported to `../flutter`; see "Shared
  SDK" below.

## Background estimation, and what each platform actually promises

`background_estimation.dart` hands the queue to the OS on the way out. The
next-launch drain has worked since Phase 4 and remains the guarantee — every path
through this file is allowed to do nothing.

- **Android means it.** WorkManager persists the request across process death and
  reboots and runs it once the network constraint is met.
- **iOS does not.** `BGProcessingTask` is scheduled, not promised: iOS decides
  from usage patterns, charge state and idle time, and a rarely-opened app may go
  days without a window. This is the API's contract, not a bug to fix.
- **Scheduled on `paused` with meals waiting, cancelled on `resumed`.** Not on
  `inactive` — that is a notification shade or the app switcher, not leaving. The
  cancel is the important half: every estimate is billed, and the foreground
  drain is faster than any scheduler.
- **The background drain boots the same objects the foreground does** —
  `AppSession`, `MealStore`, `EstimationQueue`. A second, simpler estimator would
  be a place for each of the four things the queue must never do to be got wrong
  once per platform.
- **`false` means "worth another go".** No account, no key and nothing pending
  all return `true`: retrying changes none of them, and on Android a `false` is a
  retry with backoff.
- **Three places have to agree on the iOS task identifier**:
  `estimationTaskName` here, `BGTaskSchedulerPermittedIdentifiers` in
  `ios/Runner/Info.plist`, and the `registerBGProcessingTask` call in
  `AppDelegate.swift`. Disagree and nothing fails — the task simply never runs.
- **Not verified on a device.** The policy and both platforms' builds are green,
  but whether a headless isolate really reaches the keychain, the documents
  directory and the Rust bridge is a claim only a phone can settle (plan §8,
  Phase 6.1). If it turns out it cannot, meals still estimate on next launch.

## The meal vocabulary lives in `atomic_lib`, not here

`Meal`, `consumed-at`, `calories`, `meal-status` and the rest are defined in
`../lib/defaults/calorie-tracker.json`, imported by `populate_default_store`
(`../lib/src/populate.rs`) and named by consts in `../lib/src/urls.rs`. So they
are seeded into *every* atomic store, including this app's local redb one, and
`rust/src/api/meals.rs` writes `atomic_lib::urls::CALORIES` rather than a
string this app made up. `populate::tests::the_meal_ontology_seeds` resolves the
class and every property, which is what turns a JSON-AD typo into a test failure
instead of a failed write on a phone.

Two things about that model are worth knowing before extending it:

- **`meal-status` and `estimate-confidence` are Tags, not strings.** `allowsOnly`
  only accepts subjects — a plain `"pending"` in that list fails the import — so
  each state is a Tag resource under its property
  (`…/properties/mealStatus/pending`). The bridge speaks the shortnames and
  converts at the boundary; nothing above `meals.rs` sees a tag URL.
- **`meal-embedding`, `embedded-by-model` and `copied-from-meal` arrived in
  Phase 7.1.** The first two are written together by `set_meal_embedding` or
  cleared together — a vector whose encoder is unknown is not a half-written
  meal but a meaningless one, since it cannot be compared to anything. The
  encoder has not landed yet (Phase 7.2), so nothing calls it in anger; it
  exists so the round trip is tested rather than written blind. `copied-from-meal`
  has a `classtype` of `Meal`, asserted in `the_meal_ontology_seeds` — without
  it the lineage the suggestion path resolves through is an untyped link free to
  point anywhere.
- **`clarifying-question` was added in Phase 4**, for the reason above: a meal
  that is `needs-info` has to carry what it is waiting on. It is cleared, not
  blanked, when a later estimate has nothing to ask.
- **A meal requires only `consumed-at` and `meal-status`.** It is created the
  instant it is captured, before anyone knows what it was, so the name and the
  numbers cannot be required of it. `calories` is `Option` all the way up for
  the same reason: "not estimated yet" is not "zero calories", and a day total
  that conflates them is wrong in the direction that matters.

## Shared SDK — keep it in step with the canvas app

`lib/atomic/` and `rust/src/api/` were copied from `../flutter` (Atomic Canvas)
and stripped of that app's canvas/stroke/folder/undo code. The two are meant to
be merged into one package once both apps' needs are known
(`calorie-tracker-plan.md` §9). Until then, keep shared code structurally
identical to its twin so the merge stays mechanical, and port fixes both ways.

Fixed in both copies (found here, ported to `../flutter`): **`open_db` turns on
`Db::set_durable_writes(true)`**. redb writes commits at `Durability::None` — no
fsync — and rolls back to the last durable commit when the file is opened again.
`atomic-server` covers that with a periodic flush thread and a clean shutdown; an
app the OS reaps in the background gets neither, so every meal logged since
launch was gone at the next start, and the meals container with it (which is why
a relaunch also minted a fresh one). The store now fsyncs per commit, which on a
phone is a handful of user actions a day. Note that nothing in `test/` or in
`integration_test/` could have caught this: both relaunch inside one process,
where the store is still open and nothing has been rolled back.
`lib/tests/write_durability.rs` in `atomic_lib` is the test that does — it writes
in a child process and `abort()`s it.

Also fixed in both copies (found here, ported to `../flutter`):
`ServerSettingsSection`'s "Pair with QR code" / "Connect by address" buttons are
a `Wrap` rather than a `Row`. Side by side they are wider than a phone, and this
app puts that section on a settings screen rather than in the wide dialog it was
written for — so it overflowed, which a widget test turns into a failure and a
device turns into a yellow-and-black stripe.

Also fixed in both copies: `open_db` and
`initRustBridge` are now idempotent. Both used to throw on a second call, and
`open_db`'s recovery path reads any failure as corruption and **deletes the
database** — so booting the app twice in one process wiped it. Nothing in
either app did that on purpose, but an integration test that relaunches the app
does, and so would a retry after a failed start.

What diverged deliberately:

- `create_resource` takes a `class` argument. The canvas version hardcoded
  `urls::CLASS` — the meta-class for *defining* classes, which requires a
  `shortname` — so every call through it failed. Nothing called it, so nobody
  found out.
- `get_resource_at_version` → `get_property_at_version`, which names the
  property to read. The canvas twin always read stroke data.
- `subscribe_canvas` → `subscribe_resource`; `delete_canvas`/`rename_canvas` →
  `delete_resource`/`rename_resource`.
- `save_and_push` no longer touches a `dateEdited` property (a gallery sort key
  this app has no use for — meals sort by `consumed-at`).
- Web is dropped. Target platforms are iOS and Android only, so
  `atomic_client_web.dart` was not copied.
- `update_meal_estimate` takes a **typed `MealEstimate` struct**, not the
  `estimate_json: String` the plan sketched. Same argument the plan makes for
  `MealItem`: FRB generates the Dart class either way, and Dart has to parse the
  model's JSON regardless — it decides whether there is a question to ask — so
  handing the string on buys nothing and costs a category of typo.
- `state.rs` is `pub(crate)` and `simple.rs` declares `pub(crate) mod state`, so
  `api::meals` can reach the same store handle. `save_and_push` is `pub(crate)`
  for the same reason — meals save through it rather than growing a second,
  subtly different save path. App-specific bridge code goes in `meals.rs`, never
  in `simple.rs` — that is what keeps the merge a copy.

## Commands

`make check` is what every phase has to leave green: `flutter analyze`,
`flutter test`, `cargo test`.

| Command | What |
| --- | --- |
| `make check` | analyze + Dart tests + Rust tests |
| `make ios` / `make android` | run the app, hot reload via `make reload-ios` from any terminal |
| `make apk` | debug APK, one ABI (see below) |
| `make integration-ios` / `make integration-android` | on-device test: onboard, log a meal, relaunch, same account and same meal |
| `make gen` | regenerate FRB bindings — **required after any signature change** in `rust/src/api/` |
| `make model` | export the image encoder into the gitignored `assets/models/` — needed once per clone, before the first build |
| `make model-deps` | install the Python the export needs (torch, transformers, onnx) |
| `make clean-build` | wipe the build tree when the disk fills up |

## Build gotchas

These all cost an afternoon once. They are fixed in-tree; this is why.

- **After changing a `pub fn` in `rust/src/api/`, run `make gen`.** The crate
  will not compile until you do — `frb_generated.rs` still calls the old
  signature, and the error points at generated code rather than at your edit.
- **Disk.** A full Android build compiles atomic_lib's ~1500-crate tree once
  *per ABI* — around 15 GB. `make apk` builds one ABI (`ABI=android-arm64` by
  default; `android-x64` for Intel emulators). Xcode's DerivedData grows by
  several GB per iOS build too.
- **iOS needs SystemConfiguration and Security frameworks.** Iroh reaches
  SystemConfiguration to enumerate network interfaces; rustls reaches Security
  for the platform verifier. Declared in
  `rust_builder/ios/rust_lib_calorie_tracker.podspec`. **Run `pod install` in
  `ios/` after editing that podspec** — CocoaPods caches the generated xcconfig,
  and a stale one fails the link at the `rust_lib_calorie_tracker` target with
  `Undefined symbol: _kSCNetworkInterfaceType*`.
- **`rust_builder/cargokit/gradle/plugin.gradle` is locally patched.** Gradle 9
  removed `Project.exec()`; the task uses an injected `ExecOperations`. Re-apply
  when vendoring a newer cargokit.
- **`mobile_scanner` must stay on 7.x.** Version 6 uses ML Kit on iOS, which has
  no arm64 simulator slice — the app builds but will not install on an Apple
  Silicon simulator. 7.x uses Apple Vision instead.
- **iOS deployment target is 16.0**, the floor `flutter_onnxruntime` sets (its
  `onnxruntime-swift-package-manager` dependency declares it). `mobile_scanner`
  wants 15.5, which this clears. It is in both `ios/Podfile` and
  `ios/Runner.xcodeproj/project.pbxproj`, and both have to agree — SPM checks
  the Xcode target's value, not the Podfile's, so bumping only the Podfile
  leaves the build failing with "requires minimum platform version 16.0 … but
  this target supports 15.5".
- **Signing lives in `ios/Flutter/Local.xcconfig`**, which is untracked and
  pulled in by an optional `#include?` from `Debug.xcconfig`/`Release.xcconfig`.
  Put your `DEVELOPMENT_TEAM` there. Xcode writes that setting straight into
  `project.pbxproj` when you pick a team in the UI — that file is shared, so a
  committed team ID breaks signing for everyone else. Revert the pbxproj if it
  reappears.
- **`calorie-tracker/rust` is excluded from the root Cargo workspace** (see the
  root `Cargo.toml`), like `flutter/rust`. Build it with
  `cargo test --manifest-path rust/Cargo.toml`, not from the workspace root.
- **A widget test cannot await `dart:io`.** `testWidgets` runs its body in a
  fake-async zone, and a file `Future` completes on the real event loop, which
  that zone never pumps. So anything touching the photo directory — the shutter,
  an `ImageStore` call in a test body — has to go inside `tester.runAsync`, or
  the test hangs half-way through a capture with the shutter spinner still up,
  which reads as an app bug rather than a harness one.
  `test/capture_screen_test.dart` has the two helpers for it. Plain `test()`
  files, like `image_store_test.dart`, are unaffected.
- **`pumpAndSettle` never returns while a `CircularProgressIndicator` is on
  screen**: it is a repeating animation, so there is always another frame
  scheduled. "The camera has not come up yet" is exactly that state, so the
  capture tests count their pumps instead of settling.
- **A test file that touches `AppSession` needs the storage mocks**
  (`SharedPreferences.setMockInitialValues({})` and
  `FlutterSecureStorage.setMockInitialValues({})` in `setUp`). `AtomicSession`
  writes through both, and without the mocks those platform channels never
  answer: the file does not fail, it *hangs* — `flutter test` sits there with no
  output until you kill it, which reads as a broken toolchain rather than a
  missing line.
- **Changing the ontology means running `atomic_lib`'s tests too.**
  `lib/defaults/calorie-tracker.json` is seeded into every store in the repo, so
  `cargo test -p atomic_lib --features db-redb --lib --tests` from the repo root
  is part of the check — `make check` here does not cover it. (Skip
  `--lib --tests` and the run dies compiling `examples/list_sled_trees.rs`,
  which wants the `db-sled` feature; CI uses nextest, which ignores examples.)

- **The OAuth redirect scheme is `caltracker://`**, declared once in
  `android/app/src/main/AndroidManifest.xml` on `flutter_web_auth_2`'s
  `CallbackActivity`. iOS needs no equivalent — `ASWebAuthenticationSession` is
  told the scheme at call time. If you change it, change both that manifest
  entry and `_callbackScheme` in `lib/services/openrouter.dart`.
- **iOS plugins go through Swift Package Manager here, not CocoaPods.**
  `ios/Podfile.lock` has three pods in it and always will; everything else
  (camera, mobile_scanner, flutter_web_auth_2) is a package reference in
  `Runner.xcodeproj`, regenerated by `flutter run`/`flutter build`. So adding a
  plugin needs no `pod install` — the podspec note above is only about
  `rust_lib_calorie_tracker`, which *is* a pod.
- **`flutter_onnxruntime` validates the provider list; it does not fall back
  through it.** `OrtSessionOptions(providers: […])` is walked name by name and
  appended, and a name the *platform's* plugin has no `case` for fails the whole
  session with `INVALID_PROVIDER`. iOS knows CPU, CORE_ML and XNNPACK; Android
  knows NNAPI and a dozen others. So the obvious `[CORE_ML, NNAPI, CPU]` — one
  list meant to cover both phones — creates no session on *either*, and the
  failure is indistinguishable from a missing model: `_unavailable` latches,
  every `encode` returns null, the embedding queue stops at the first meal, the
  index stays empty and the viewfinder shows nothing. That is four layers of
  correct "this is invisible rather than broken" handling turning a one-line
  mistake into a feature that silently does not exist. `DinoV2Encoder._providers`
  now asks `getAvailableProviders()` and intersects, always ending in CPU.
- **`imageFormatGroup` is the *stream* format, not the photo format.**
  `DeviceCamera` asks for `yuv420` on Android and `bgra8888` on iOS since Phase
  7.3, because those are the two `camera_frame.dart` knows how to read.
  `takePicture` still writes a JPEG either way. A format the converter does not
  recognise is not an error: it is silently no live suggestions, and everything
  else works.
- **The iOS simulator has no camera**, and neither does a CI machine. That is a
  supported state, not a broken one: `DeviceCamera` reports it, the capture
  screen says so and offers the keyboard instead, and everything else works. Do
  not "fix" it by making the screen an error page — the simulator is where this
  app is developed.
- **Notifications need one line of native setup each.**
  `UNUserNotificationCenter.current().delegate` in `ios/Runner/AppDelegate.swift`
  — without it a tap never reaches Dart and the deep link silently does nothing —
  and `POST_NOTIFICATIONS` in the Android manifest for API 33+. Neither shows up
  as a build failure; both show up as a notification that does nothing.
- **Android needs core library desugaring**, in `android/app/build.gradle.kts`:
  `isCoreLibraryDesugaringEnabled = true` plus a `coreLibraryDesugaring(...)`
  dependency on `desugar_jdk_libs`. `flutter_local_notifications` 22 declares the
  requirement in its AAR metadata, so without it `assembleDebug` fails at
  `checkDebugAarMetadata` — before compiling a line of this app's code. It is a
  Phase 5 dependency that only shows up when somebody actually builds an APK;
  `make check` never does.
- **The iOS background task identifier lives in three files** and they have to
  match exactly: `estimationTaskName` in
  `lib/services/background_estimation.dart`,
  `BGTaskSchedulerPermittedIdentifiers` in `ios/Runner/Info.plist`, and
  `WorkmanagerPlugin.registerBGProcessingTask(withIdentifier:)` in
  `ios/Runner/AppDelegate.swift`. A mismatch is not a build error and not a
  runtime error — the task is simply never run, which is indistinguishable from
  iOS deciding not to.
- **`AppDelegate.swift` imports `workmanager_apple`.** That is the SPM module
  name, so it needs no `pod install` (see the note about plugins above), but it
  does mean the file will not compile until `flutter build`/`flutter run` has
  regenerated the package references at least once.
- **`dart run flutter_launcher_icons` corrupts `project.pbxproj`.** It rewrites
  `ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = YES` to
  `= AppIcon` — it is matching the wrong key; the one it means,
  `ASSETCATALOG_COMPILER_APPICON_NAME`, is already right. `git checkout --
  ios/Runner.xcodeproj/project.pbxproj` after running it, and keep the icon
  changes.

## Next: a device, then Phase 8 — Health

Phase 7 is code-complete. What is left before Phase 8 is the part that was
always going to need a phone, and it is now three phases' worth in one sitting
(`../planning/calorie-tracker-embeddings.md` §11 says to fold them, and Phase
6.1 has been owed since Phase 6):

1. **Does the encoder work at all here?** That the ONNX asset loads through the
   platform channel, that Core ML and NNAPI accept an int8 model rather than
   falling back to CPU, and how long an inference actually takes. `_encoderTests`
   in `integration_test/bridge_test.dart` is written; `make integration-ios` runs
   it. **If the domain-gap check fails, stop** — every threshold in 7.3 would be
   calibrated against an artifact of preprocessing, which is the one failure
   here that looks like working software.
2. **Does the live stream keep up?** 7.3 assumes ~3 Hz of DINOv2 costs little
   next to a running camera. Watch the frame rate of the preview itself, not
   the inference time: the gates exist so that most frames cost nothing, and if
   the viewfinder stutters they are not doing their job.
3. **The thresholds.** `suggestThreshold` 0.55 and `contextThreshold` 0.35 are
   guesses from stock food photography. Live with the app for a week and read
   the `suggestions:` lines a debug build prints — §11 wants two numbers out of
   that: tap-through against the frequency baseline, and the clarify rate before
   and after 7.4.
4. **Background estimation**, which Phase 6.1 owes: log a meal, background the
   app, and confirm the drain happens without reopening it (`adb shell dumpsys
   jobscheduler`; on iOS the `_simulateLaunchForTaskWithIdentifier` debugger
   call).

**The app exports its own weights now** (`tool/export_model.py`, `make model`),
from `facebook/dinov2-small` at a pinned revision, rather than fetching a
ready-made ONNX. Three reasons, in the order they turned up:

- **Licensing.** `facebook/dinov2-small` is Apache 2.0, stated.
  `onnx-community/dinov2-small-ONNX` — what this app shipped until now —
  declares *no* licence, only `base_model`. The grant flows to derivative works
  and cannot be revoked, so that file was very probably fine; "very probably" is
  a poor footing for the one binary the app redistributes.
- **The output shape.** The stock export emits `last_hidden_state`,
  `[1, 257, 384]`, and this app reads the CLS token — 384 of 98,688 floats.
  The rest crossed the platform channel three times a second to be dropped:
  386 KB a frame against 1.5. The exported graph pools, so it emits `[1, 384]`.
- **The input shape.** All four dims were symbolic; this app has one legal
  input size.

`make model` therefore needs Python and torch (`make model-deps`), which is a
real cost to a fresh clone and the reason it is written down here. The pin is on
the *upstream revision*, and the export is verified by **behaviour** rather than
by file hash — `torch.onnx.export` is not byte-reproducible across versions, so
a hash would fail on every toolchain but one while saying nothing about whether
the graph still computes the same vector. Each run checks the output shape, that
no integer-quantized op crept in, and cosine ≥ 0.9999 against the torch model.

**Static shapes are not a speed change, and the measurement is the interesting
part.** Fixing the input *does* let ORT's Core ML EP accept the graph, and Core
ML then loses to the CPU by 2.4× (M-series Mac, ORT 1.13, median of 8):

```
dynamic shapes, CPU        55.0 ms      <- what the app shipped
dynamic shapes, Core ML    55.6 ms      Core ML partitioned nothing
static + CLS, CPU          55.2 ms      <- what ships now
static + CLS, Core ML     130.3 ms      Core ML took it and lost
```

A ViT this size is dominated by matmuls the CPU provider already does well, and
Core ML pays conversion overhead for them. **If the phone gets slower after this
change, that is the fourth line arriving on iOS**, and the fix is one line: drop
`OrtProvider.CORE_ML` from `DinoV2Encoder._providers`. The diagnostics card
prints per-inference milliseconds, so it is one look.

**And before all that: the bench's ranking was exactly backwards, which took
two device round-trips to establish.** It ordered the exports int8, fp16, fp32 on
size and speed. The phone runs them in the opposite order, because neither of
the small ones loads at all.

```
int8 (23 MB)  Could not find an implementation for ConvInteger(10) node with
              name '/embeddings/patch_embeddings/projection/Conv_quant'

fp16 (43 MB)  Attempting to get index by a name which does not exist:
              InsertedPrecisionFreeCast_/encoder/layer.0/norm1/Constant_output_0
              for node: /encoder/layer.0/norm1/Mul/SimplifiedLayerNormFusion/
```

int8 is a *dynamic* quantization, so its graph is `ConvInteger`/`MatMulInteger`
and the ONNX Runtimes shipped to iOS and Android have no kernels for them. fp16
loads fine on a desktop ORT and hits an optimizer assert in the mobile build:
the fp16 handling inserts precision casts, then an extended-level fusion looks
up a name those casts replaced. Both fail at *session creation*, so nothing runs
and every meal comes back un-embedded — indistinguishable, from the viewfinder,
from a phone that has never been pointed at food.

**fp32 (88 MB) is what ships.** It has neither failure available to it: no
integer ops to be missing, no fp16 anywhere so no precision casts inserted. It
also benched *faster* than fp16 (56 ms against 61 on a Mac CPU), because ORT's
CPU provider has no native fp16 and casts around every op. The whole cost is app
size, and it is a large one.

If `flutter_onnxruntime` ever exposes `graphOptimizationLevel` on iOS/Android —
it is web-only today — `ORT_ENABLE_BASIC` skips the offending extended-level
pass and fp16 becomes shippable again at half the size. That is the one change
that would win back 45 MB.

The decisions 7.2 rests on, kept here because they are still the reasons:

- **Not MobileCLIP.** Apple's weights are `apple-amlr`, which grants use
  "exclusively for Research Purposes" and excludes any commercial product —
  and that flows through the ONNX re-exports. `facebook/dinov2-small` is the
  permissive swap: Apache 2.0, 22.1M params, 384-d rather than 512-d, which
  changes nothing structural. It gives up the text tower, which was already out
  of scope. Runtime: `flutter_onnxruntime` ≥1.5.1 (the floor for Play's 16 KB
  page-size rule).
- **CLS pooling and the centre-square crop — measured, in
  `tool/encoder-bench/`.** The export emits only `last_hidden_state`
  (1×257×384), so pooling is a decision rather than a lookup: CLS beat
  mean-of-patches 0.957 vs 0.826 and matched CLS+mean at half the storage. The
  plain centre square beat the training-faithful 87.5% crop. Both still hold —
  they are properties of the weights, not of how they are stored.
- **The quantization is the one thing that bench could not answer**, and it is
  worth remembering why it was so confident and so wrong. It ranked int8 first
  on precision@1, size and speed, all correctly, on a Mac. A desktop ORT is
  built with every kernel; the mobile ones are not. So a benchmark on a laptop
  says what a model *scores* and never what a phone will *run*, and this one
  went as far as recommending weights that fail at session creation on both
  target platforms. Anything it says about a future encoder needs a device
  before it is believed — which is now one line in `_encoderTests`.
- **The weights are not in git.** `make model` writes them into a gitignored
  `assets/models/`, and they are bundled into the built app — so the app never
  downloads anything, but a fresh clone needs `make model` once before its
  first build. The upstream revision is pinned: a silent re-export would make
  every vector already in every database incomparable, and `embedded-by-model`
  could not tell, because the id would not have changed.
- **`assetKey` is derived from `modelIdValue`**, so the file and the string
  written into `embedded-by-model` cannot name different things. Three encoder
  swaps went through here and each was a chance to change one and forget the
  other, which is the silent failure: new weights, old id, so nothing
  re-encodes and the index mixes two vector spaces while claiming they are
  comparable. `tool/export_model.py` writes that exact filename, and
  `meal_encoder_test.dart` asserts the derivation — the half of the agreement
  Dart cannot enforce is the Python one.
- **The licence ships with the weights.** Apache 2.0 §4 attaches conditions to
  *distributing* the work, and bundling it in an app is distributing it: a copy
  of the licence, the attribution, and a statement of what was changed. Those
  live in `assets/licenses/` — committed, unlike the weights, because a fresh
  clone must not have to generate the terms. `registerBundledLicenses` in
  `main.dart` feeds them to `showLicensePage`, reached from the account screen.
  Registering a licence and never linking to the page that shows it satisfies
  nothing, so `test/licenses_test.dart` covers the whole chain — it is four
  strings, none of which fails loudly.
- **The domain-gap check is the acceptance criterion that guards everything
  else.** Embedding a camera frame and embedding the file written from that same
  frame must agree closely, or every threshold is calibrated against an artifact
  of preprocessing. This is why the stored source is 256px rather than 64.

After all that, Phase 8 is Health: write `DIETARY_ENERGY_CONSUMED` on estimate
and confirm, behind a settings toggle.

Loose ends worth knowing about before then:

- **The frequency row and the index are refreshed at four moments, not
  continuously.** On the screen appearing, after a capture, after a tap, and on
  resume — plus a sync, and whenever the embedding queue wrote something. That
  is a 30-day range query and a table scan, which is too much to run on every
  `MealStore` notify and not enough to be stale in a way anybody notices. The
  *live* row is not one of these: it re-ranks off the cached index a few times a
  second, and only the index behind it is periodic.
- **Nothing rewrites the copies when their original is corrected.** Fix the
  calories on a meal that twelve others were copied from and the twelve keep the
  old number. `copied-from-meal` makes following them *possible*; rewriting
  settled history behind the user's back is right in the abstract and alarming
  in a list of days. Left inert until somebody asks.

- **Nothing re-estimates on a model change.** Change the model in Settings and
  the meals already estimated keep the old one's numbers, which is right. A
  settled meal can now be asked again by hand — "Estimate it again" in its sheet
  — but only where there is still something to send it.
- **`waiting` is what the last drain found.** It is not a live count from the
  database, so a meal synced in from another device does not show up in the
  banner until the next drain. Every path that adds a meal here drains, including
  a sync that imported something.
- **A sync is a whole-store sync, not a meals sync.** `syncConnectivityNow` pulls
  whatever the other device has under the drive. Fine while a meal is the only
  thing this app writes; worth knowing if it ever writes anything else.
- **The history reads 90 days and doubles on demand.** One range query, grouped
  in Dart. That is fine for a phone's worth of meals and would not be for a
  decade of them; the day it stops being fine, the grouping is what moves into
  the bridge, not the screen.
- **A `failed` meal keeps whatever question it had.** `set_meal_status` does not
  clear `clarifying-question`, so a meal that was `needs-info` and then failed a
  re-estimate still carries a stale one. Nothing shows it — `Meal.needsAnswer`
  wants the status *and* the question, and that meal's status is `failed` — so it
  is dead data rather than a wrong screen. Worth clearing if the property ever
  grows a second reader.
- **A prior is retrieved once per meal, not once per attempt.** It is worked out
  before the retry loop in `EstimationQueue._attempt`, since a retry is about
  the network and re-running a similarity search would spend battery arriving at
  the same sentence.
- **The medium band cannot help a typed meal.** There is no photograph, so
  there is no vector, so there is nothing to match on — and the text tower that
  would fix it is out of scope (`../planning/calorie-tracker-embeddings.md`
  §12). It is the case the feature would help most and the one it does not
  reach.
