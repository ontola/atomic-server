Here's what I found. The pipeline is: `ImageStore` 1024px/q80 JPEG ‚Üí `EstimationQueue._attempt` ‚Üí `OpenRouterClient.estimate` ‚Üí one call, one shot, strict JSON schema (`lib/services/openrouter.dart:542-638`). The retrieval band (`MealPriors`) adds at most one sentence of the user's own notes.

Two structural facts explain both of your failure cases:

- **The schema asks for a total before any decomposition.** `calories` is generated as a gestalt number ‚Äî nothing in the schema makes the model enumerate what it sees and what each part weighs first. "A few almonds" reads as "handful of nuts ‚âà 250 kcal" instead of 8 √ó 1.2 g = 10 g √ó 579/100 = **58 kcal**. Your 150% overestimate is exactly the shape of a gestalt guess.
- **Nothing in the prompt says where or when the eater is.** A krentenbol is a Dutch bakery item; the model produced an Anglo-centric prior ("cheese sandwich, tuna filling"). It has no locale, and no `consumed-at` ‚Äî which would have made a sweet breakfast roll far more likely than a tuna sandwich.

## Ranked suggestions

**1. Change the default model.** `defaultModel = 'openai/gpt-5.6-luna'` (`openrouter.dart:135`) is a cheap fast tier, and `visionModels()` sorts the picker **cheapest first** (`openrouter.dart:371`) ‚Äî so the UI actively steers toward the weakest option for the one task in the app that's hardest. At 3 meals/day, moving from ~$0.0002 to ~$0.002 a meal is roughly **$0.18/month**. This is the single largest accuracy lever and it's a one-line default plus a sort-order change. Food identification is where frontier vision models are dramatically better; unusual regional foods are precisely the tail they cover and small models don't.

**2. Make the schema force decomposition before the total.** JSON is generated left-to-right, so field order is reasoning order. Add an `items` array *before* `calories`:

```
items: [{ name, portion_basis, grams, kcal_per_100g, kcal }]
```

with `calories` documented as "the sum of `items`". This converts a vibe into arithmetic and gives every portion a stated basis you can inspect. It also makes the almonds case self-correcting: writing `kcal_per_100g: 579` and `grams: 10` can't produce 375.

**3. Pass the retrieved neighbour's *number*, not just its notes.** `MealPriors.notesFor` returns `best.notes` and drops everything else (`meal_priors.dart:78`) ‚Äî but `ScoredSuggestion.suggestion` already carries `name`, `calories`, and `timesLogged`. If you've logged "krentenbol met gouda, 320 kcal, confirmed" five times, that number is the strongest signal available and the app currently throws it away.

The CLAUDE.md invariant here is about not feeding the model its own words back ‚Äî a **user-confirmed** calorie figure is not the model's words. So the rule generalizes cleanly: pass `name` + `calories` only for meals whose status is `confirmed` (a human typed that number), pass `notes` for any. That fixes identification *and* portion at once, and it's the closest thing to learning this app can have without a training loop.

**4. Add locale and meal time to the prompt.** Two lines in `_userPrompt`: the device locale/region ("this person eats in the Netherlands ‚Äî Dutch supermarket, bakery and brand items are likely") and `meal.consumedAt` rendered as local time. Nearly free, and directly targets the krentenbol class of error.

**5. Return alternatives and make correcting the identity one tap.** Misidentification is the one failure prompting can't fully solve, so make it cheap to fix. Add `alternatives: [{name, calories}]` (2‚Äì3 entries) to the schema. When `confidence` is `low`, the meal sheet shows them as chips ‚Äî one tap replaces name and calories and marks it `confirmed`. Today a wrong name means retyping the whole meal, so most people just leave it wrong, and per **#3** that wrong number then poisons every future retrieval of the same dish.

**6. Widen the clarify trigger to cover identity.** The system prompt only invites a question when portion or ingredients are open (`openrouter.dart:551-558`). Nothing tells it to ask when it can't tell *what the food is*. One sentence ‚Äî "ask when you cannot identify the dish and a name would change the estimate a lot" ‚Äî and your krentenbol becomes a question instead of a confident tuna sandwich.

**7. Retrieve more than one neighbour, and lower the threshold.** `nearest(query, limit: 1)` with `contextThreshold = 0.35` (`meal_priors.dart:55, 73`). Top-3 above ~0.25, each labelled with its score and confirmed number, gives the model a small local food vocabulary rather than a single sentence. The asymmetry noted in that file's own comment applies with more force: a weak hint is a sentence the model ignores, a missing hint is an estimate made from nothing.

**8. Name-match retrieval for typed meals.** CLAUDE.md calls this out of scope because there's no text tower ‚Äî but you don't need one. A normalized-name lookup against history (the same grouping `MealSuggestions.groupsOf` already does) covers the common case: they type "krentenbol met gouda", they've logged it before, you have the number. No embeddings involved.

**9. Barcode ‚Üí Open Food Facts, for packaged food.** `mobile_scanner` is already a dependency (QR pairing). For anything with a barcode this replaces estimation with a lookup ‚Äî exact per-100g, and the user supplies only the portion. It's the accuracy ceiling for a whole category and half the plumbing exists.

## What I'd do first

**#1 and #2 together** ‚Äî a stronger model plus forced decomposition ‚Äî should move both failure classes noticeably for about a one-line change and a schema edit. Then **#3**, which is where the app starts getting better at *your* food specifically rather than food in general.

One measurement worth having before you change anything: the schema already collects `calories_min`/`calories_max` and `confidence`, and nothing reads them for calibration. Log the spread against what you confirm by hand, and you'll know within a week whether your errors are identification (name wrong, range irrelevant) or portion (name right, truth outside the stated range) ‚Äî those want different fixes and right now you're inferring the split from two anecdotes.
