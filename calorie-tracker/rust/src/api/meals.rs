//! Meals — the part of the bridge this app owns.
//!
//! `simple.rs` next door is a copy of the Atomic Canvas bridge, kept
//! structurally identical to it so the two can be merged into one crate later
//! (`planning/calorie-tracker-plan.md` §9). Everything calorie-specific lives
//! here instead, so that merge stays a copy rather than a diff.
//!
//! The vocabulary these functions write — `Meal`, `consumed-at`, `calories`,
//! the status tags — is seeded into every store by `atomic_lib`
//! (`lib/defaults/calorie-tracker.json`), so the subjects come from
//! [`atomic_lib::urls`] and there is no app-local ontology to drift from it.

use atomic_lib::{Storelike, Value};

use super::simple::save_and_push;
use super::simple::state::{db, err};

/// The container every meal is created under.
///
/// Meals live in one folder rather than directly on the drive so a day query is
/// "children of this subject" instead of a scan of everything the drive holds —
/// and so the drive stays free for whatever else this account keeps there.
pub const MEALS_CONTAINER_NAME: &str = "Meals";

/// Find the meals container under the active drive, creating it the first time.
/// Idempotent — call it on every launch.
///
/// It is identified by name under the drive, not by a subject remembered on
/// this device: sign in on a second phone and the drive arrives by sync with
/// its container already in it, having never run onboarding here. Looking it up
/// is what keeps that phone from minting a rival container its meals would
/// disappear into.
///
/// If two devices each made one before they ever met, the sort makes both sides
/// pick the same survivor instead of disagreeing forever. Meals already written
/// to the other one are not moved — Phase 2 owns that, once there are meals.
pub async fn ensure_meals_container() -> Result<String, String> {
    // Find-or-create is only idempotent if nothing can slip between the two.
    // Boot calls this, and so does the first meal logged before boot finished —
    // and two containers means meals in one of them stop being listed.
    static CREATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = CREATING.lock().await;

    let store = db()?;
    let drive = store.get_active_drive().ok_or("No active drive")?;

    if let Some(existing) = find_meals_container(store.as_ref(), &drive).await? {
        return Ok(existing);
    }

    store
        .create_resource(atomic_lib::urls::FOLDER, &drive, MEALS_CONTAINER_NAME, None)
        .await
        .map_err(err)
}

/// The meals container under `drive`, or None when there isn't one yet.
async fn find_meals_container(
    store: &atomic_lib::Db,
    drive: &str,
) -> Result<Option<String>, String> {
    let query = atomic_lib::storelike::Query::new_prop_val(atomic_lib::urls::PARENT, drive);
    let result = store.query(&query).await.map_err(err)?;

    let mut found: Vec<String> = Vec::new();
    for subject in &result.subjects {
        let Ok(resource) = store.get_resource(subject).await else {
            continue;
        };
        let is_folder = resource
            .get(atomic_lib::urls::IS_A)
            .map(|v| v.to_string().contains(atomic_lib::urls::FOLDER))
            .unwrap_or(false);
        let is_named_meals = resource
            .get(atomic_lib::urls::NAME)
            .map(|v| v.to_string() == MEALS_CONTAINER_NAME)
            .unwrap_or(false);

        if is_folder && is_named_meals {
            found.push(resource.get_subject().to_string());
        }
    }

    found.sort();

    Ok(found.into_iter().next())
}

// ── Status tags ────────────────────────────────────────────────────────────

/// The states a meal can be in, in the order it moves through them.
///
/// These are Tag resources under the `meal-status` property, not free text, so
/// the stored value is a subject like `…/properties/mealStatus/pending`. The
/// bridge speaks the shortnames — a Dart layer that had to build subjects would
/// be a second place the vocabulary is written down, and the one that drifts.
pub const MEAL_STATUSES: [&str; 6] = [
    "pending",
    "estimating",
    "estimated",
    "confirmed",
    "needs-info",
    "failed",
];

/// How sure an estimator was, as the ontology allows it.
pub const ESTIMATE_CONFIDENCES: [&str; 3] = ["high", "medium", "low"];

/// The subject of a status tag, rejecting anything the ontology doesn't allow.
///
/// Rejecting here rather than letting the write fail is what makes the error
/// name the caller's mistake: an unknown tag subject is accepted by the store
/// and only ever shows up later as a meal that matches no filter.
fn status_subject(shortname: &str) -> Result<String, String> {
    tag_subject(shortname, atomic_lib::urls::MEAL_STATUS, &MEAL_STATUSES)
}

fn confidence_subject(shortname: &str) -> Result<String, String> {
    tag_subject(
        shortname,
        atomic_lib::urls::ESTIMATE_CONFIDENCE,
        &ESTIMATE_CONFIDENCES,
    )
}

fn tag_subject(shortname: &str, property: &str, allowed: &[&str]) -> Result<String, String> {
    if !allowed.contains(&shortname) {
        return Err(format!(
            "Unknown value '{shortname}' for {property}. One of: {}",
            allowed.join(", ")
        ));
    }
    Ok(format!("{property}/{shortname}"))
}

/// The shortname of a tag subject — `…/mealStatus/pending` → `pending`.
/// Empty when the property isn't set.
fn tag_shortname(resource: &atomic_lib::Resource, property: &str) -> String {
    resource
        .get(property)
        .map(|v| {
            let subject = v.to_string();
            subject.rsplit('/').next().unwrap_or_default().to_string()
        })
        .unwrap_or_default()
}

// ── Meals ──────────────────────────────────────────────────────────────────

/// One meal, flattened for the Dart side.
///
/// The estimate fields are `Option` rather than zero-defaulted: "nobody has
/// worked out what this was yet" and "this had no calories" are different
/// answers, and a day total that silently counts the first as the second is
/// wrong in the direction that matters.
pub struct MealItem {
    pub subject: String,
    pub name: String,
    /// How the estimator got there. Written by estimates, never by the eater.
    pub description: String,
    /// What the eater wrote themselves — the answer to a
    /// [`MealItem::clarifying_question`], or detail they added by hand. The one
    /// text field [`update_meal_estimate`] does not touch.
    pub notes: String,
    /// Unix epoch milliseconds, UTC. Which local day that falls in is the
    /// caller's question — see [`list_meals`].
    pub consumed_at_ms: i64,
    /// One of [`MEAL_STATUSES`].
    pub status: String,
    pub calories: Option<i64>,
    pub calories_min: Option<i64>,
    pub calories_max: Option<i64>,
    /// Relative to the app documents directory. Empty for typed entries.
    pub image_path: String,
    /// `high` · `medium` · `low`, or empty when nothing has estimated it.
    pub confidence: String,
    pub estimated_by_model: String,
    /// What the estimator could not tell — set with `needs-info`, empty
    /// otherwise. See [`MealEstimate::clarifying_question`].
    pub clarifying_question: String,
    pub protein_grams: Option<f64>,
    pub carbs_grams: Option<f64>,
    pub fat_grams: Option<f64>,
    /// A base64 image embedding, or empty when nothing has encoded this meal.
    /// Only comparable to embeddings carrying the same
    /// [`MealItem::embedded_by_model`].
    pub meal_embedding: String,
    pub embedded_by_model: String,
    /// The meal this one took its numbers from, or empty when it was estimated
    /// rather than recognised. Always an original — see [`copy_meal`].
    pub copied_from_meal: String,
}

/// Log a meal under the meals container. Returns its subject.
///
/// `calories` decides the status, because those are the same fact: a meal
/// somebody typed a number for is `confirmed` — a human said so, and no
/// estimator should overwrite it — while one without a number is `pending`,
/// which is exactly the queue Phase 4's estimator drains.
///
/// There is no `description` here on purpose: at the moment a meal is logged
/// nothing has estimated it, so every word about it is the eater's and belongs
/// in `notes`. `description` is the estimator's, and only [`update_meal_estimate`]
/// writes it.
pub async fn create_meal(
    consumed_at_ms: i64,
    name: String,
    notes: String,
    image_path: String,
    calories: Option<i64>,
) -> Result<String, String> {
    let store = db()?;
    let container = ensure_meals_container().await?;

    let status = status_subject(if calories.is_some() {
        "confirmed"
    } else {
        "pending"
    })?;

    let mut props: Vec<(&str, Value)> = vec![
        (
            atomic_lib::urls::CONSUMED_AT,
            Value::Timestamp(consumed_at_ms),
        ),
        (
            atomic_lib::urls::MEAL_STATUS,
            Value::AtomicUrl(status.into()),
        ),
    ];
    if !notes.is_empty() {
        props.push((atomic_lib::urls::MEAL_NOTES, Value::String(notes)));
    }
    if !image_path.is_empty() {
        props.push((atomic_lib::urls::IMAGE_PATH, Value::String(image_path)));
    }
    if let Some(kcal) = calories {
        props.push((atomic_lib::urls::CALORIES, Value::Integer(kcal)));
    }

    store
        .create_resource(atomic_lib::urls::MEAL, &container, &name, Some(props))
        .await
        .map_err(err)
}

/// Correct a meal by hand. `None` leaves a field as it was.
///
/// Typing a calorie count is a confirmation, so it moves the meal to
/// `confirmed` — otherwise Phase 4's estimator would find a `pending` meal the
/// user had already answered and overwrite the answer.
///
/// `notes` is the whole clarification loop: the answer to a
/// `clarifying-question` is written here and the meal re-estimated, and because
/// an estimate never touches this property the answer survives however many
/// rounds it takes.
pub async fn update_meal(
    subject: String,
    name: Option<String>,
    notes: Option<String>,
    calories: Option<i64>,
) -> Result<(), String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;

    if let Some(name) = name {
        resource
            .set_unsafe(atomic_lib::urls::NAME.into(), Value::String(name))
            .map_err(err)?;
    }
    if let Some(notes) = notes {
        resource
            .set_unsafe(atomic_lib::urls::MEAL_NOTES.into(), Value::String(notes))
            .map_err(err)?;
    }
    if let Some(kcal) = calories {
        resource
            .set_unsafe(atomic_lib::urls::CALORIES.into(), Value::Integer(kcal))
            .map_err(err)?;
        resource
            .set_unsafe(
                atomic_lib::urls::MEAL_STATUS.into(),
                Value::AtomicUrl(status_subject("confirmed")?.into()),
            )
            .map_err(err)?;
    }

    save_and_push(&mut resource, store.as_ref()).await
}

/// Move a meal to another status. See [`MEAL_STATUSES`].
pub async fn set_meal_status(subject: String, status: String) -> Result<(), String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;
    resource
        .set_unsafe(
            atomic_lib::urls::MEAL_STATUS.into(),
            Value::AtomicUrl(status_subject(&status)?.into()),
        )
        .map_err(err)?;

    save_and_push(&mut resource, store.as_ref()).await
}

/// What an estimator worked out about a meal.
///
/// A struct rather than the JSON string the plan sketched, for the reason
/// [`MealItem`] is one: FRB generates the Dart class either way, and a field
/// this side and a key spelled slightly differently on the other is the whole
/// category of bug that plumbing avoids. Dart parses the model's JSON already —
/// it has to, to know whether to ask a follow-up question — so nothing is saved
/// by handing the string on.
pub struct MealEstimate {
    pub name: String,
    /// How the estimator got there. Replaces the last estimate's reasoning and
    /// nothing else: the eater's own words live in `notes`, which this call
    /// never writes, so there is nothing here to be careful of.
    pub description: String,
    pub calories: i64,
    pub calories_min: Option<i64>,
    pub calories_max: Option<i64>,
    /// One of [`ESTIMATE_CONFIDENCES`].
    pub confidence: String,
    /// The OpenRouter model id, so a number can be traced to what made it.
    pub model: String,
    /// The one thing the estimator could not tell — "was that milk or oat
    /// milk?". Empty when it was sure enough, and what decides the resulting
    /// status: a question makes the meal `needs-info`, because a meal waiting
    /// on an answer with no question to show is a dead end. Low confidence on
    /// its own is just a wide range, which the bounds already say.
    pub clarifying_question: String,
    pub protein_grams: Option<f64>,
    pub carbs_grams: Option<f64>,
    pub fat_grams: Option<f64>,
}

/// Write an estimate onto a meal, moving it to `estimated` or `needs-info`.
///
/// **`meal-notes` is not in the list of things it writes**, which is what makes
/// the clarification loop terminate: the answer the eater gave goes into the
/// next prompt and stays where it was put, however many estimates run over it.
///
/// **A `confirmed` meal is left alone.** Confirmed means a human typed the
/// number, and the estimate racing it — the user correcting a meal while its
/// call was in flight — must not win. Silently, and returning Ok: it is a race
/// between two correct behaviours, not a mistake anybody made.
pub async fn update_meal_estimate(subject: String, estimate: MealEstimate) -> Result<(), String> {
    // Rejected before anything is written, so a bad tag cannot leave a meal
    // half-updated.
    let confidence = confidence_subject(&estimate.confidence)?;
    let status = status_subject(if estimate.clarifying_question.is_empty() {
        "estimated"
    } else {
        "needs-info"
    })?;

    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;

    if tag_shortname(&resource, atomic_lib::urls::MEAL_STATUS) == "confirmed" {
        return Ok(());
    }

    set(&mut resource, atomic_lib::urls::NAME, Value::String(estimate.name))?;
    set(
        &mut resource,
        atomic_lib::urls::DESCRIPTION,
        Value::String(estimate.description),
    )?;
    set(
        &mut resource,
        atomic_lib::urls::CALORIES,
        Value::Integer(estimate.calories),
    )?;
    set(
        &mut resource,
        atomic_lib::urls::ESTIMATE_CONFIDENCE,
        Value::AtomicUrl(confidence.into()),
    )?;
    set(
        &mut resource,
        atomic_lib::urls::ESTIMATED_BY_MODEL,
        Value::String(estimate.model),
    )?;
    set(
        &mut resource,
        atomic_lib::urls::MEAL_STATUS,
        Value::AtomicUrl(status.into()),
    )?;

    // The optional half. `None` means the model did not give one, and the right
    // answer for a re-estimate is to drop the old value rather than keep a
    // number the new estimate does not stand behind.
    for (property, value) in [
        (atomic_lib::urls::CALORIES_MIN, estimate.calories_min),
        (atomic_lib::urls::CALORIES_MAX, estimate.calories_max),
    ] {
        match value {
            Some(kcal) => set(&mut resource, property, Value::Integer(kcal))?,
            None => clear(&mut resource, property),
        }
    }
    for (property, value) in [
        (atomic_lib::urls::PROTEIN_GRAMS, estimate.protein_grams),
        (atomic_lib::urls::CARBS_GRAMS, estimate.carbs_grams),
        (atomic_lib::urls::FAT_GRAMS, estimate.fat_grams),
    ] {
        match value {
            Some(grams) => set(&mut resource, property, Value::Float(grams))?,
            None => clear(&mut resource, property),
        }
    }

    // Cleared rather than blanked when there is nothing to ask, so a meal that
    // was `needs-info` and has just been re-estimated stops carrying the
    // question it no longer has.
    if estimate.clarifying_question.is_empty() {
        clear(&mut resource, atomic_lib::urls::CLARIFYING_QUESTION);
    } else {
        set(
            &mut resource,
            atomic_lib::urls::CLARIFYING_QUESTION,
            Value::String(estimate.clarifying_question),
        )?;
    }

    save_and_push(&mut resource, store.as_ref()).await
}

fn set(
    resource: &mut atomic_lib::Resource,
    property: &str,
    value: Value,
) -> Result<(), String> {
    resource
        .set_unsafe(property.into(), value)
        .map(|_| ())
        .map_err(err)
}

/// Drop a property. Not having it is the outcome either way, so a resource that
/// never had it is not an error.
fn clear(resource: &mut atomic_lib::Resource, property: &str) {
    let _ = resource.remove_propval(property);
}

/// Meals eaten in `[from_ms, to_ms)`, newest first.
///
/// Half-open on purpose: a day is `[midnight, next midnight)`, so a meal at
/// exactly 00:00 belongs to the day starting then and to only one day. Both
/// bounds are UTC milliseconds — the caller works out where its local midnights
/// fall, because the device knows its timezone and its DST and the store does
/// not.
pub async fn list_meals(from_ms: i64, to_ms: i64) -> Result<Vec<MealItem>, String> {
    collect_meals(|meal| meal.consumed_at_ms >= from_ms && meal.consumed_at_ms < to_ms).await
}

/// The meals nobody has put a number on yet, oldest first.
///
/// The estimator's work queue. `estimating` is in it as well as `pending`,
/// because the only thing that ever sets it is an estimate running in this
/// process: a meal still marked `estimating` at launch is one an app that was
/// killed mid-call left behind, and leaving it out would strand it there
/// forever. A queue that is draining knows what it currently holds and skips
/// those itself.
///
/// Oldest first, deliberately the opposite of [`list_meals`]: this is a queue,
/// and the meal that has been waiting longest is the one to do next.
pub async fn list_pending_meals() -> Result<Vec<MealItem>, String> {
    let mut meals = collect_meals(|meal| meal.status == "pending" || meal.status == "estimating")
        .await?;
    meals.reverse();
    Ok(meals)
}

/// One meal by subject, or None when it is not there or is not a meal.
///
/// What a notification tap arrives with. It carries a subject and nothing else —
/// the meal it names may have been deleted, or answered and re-estimated, in the
/// time the notification sat on the lock screen — so "no such meal" is an
/// ordinary answer here rather than an error to show anybody.
pub async fn get_meal(subject: String) -> Result<Option<MealItem>, String> {
    let store = db()?;
    let Ok(resource) = store.get_resource(&subject.as_str().into()).await else {
        return Ok(None);
    };
    Ok(read_meal(&resource))
}

// ── Copies ─────────────────────────────────────────────────────────────────

/// Log a meal by recognising an earlier one, taking its numbers wholesale.
///
/// What a tapped suggestion on the viewfinder does. The new meal is `confirmed`
/// — a human looked at the food and at the suggestion and said they were the
/// same thing, which is a stronger claim than any estimate — so no estimator
/// will ever revisit it.
///
/// **It copies the numbers and the eater's words, and nothing the model wrote.**
/// `description`, `estimate-confidence`, `estimated-by-model` and
/// `clarifying-question` are all an account of a *different photograph*, and
/// carrying them here would make this meal claim to have been estimated when
/// nothing has looked at it. `meal-notes` is the exception because it is the
/// eater's own words about this food, which is exactly what makes the copy worth
/// having — the answer they gave weeks ago comes with it.
///
/// `copied_from_meal` on the new meal names the *original*, never the copy that
/// happened to be recognised: lineage stays one hop deep, so correcting an
/// original is a question about a flat set of copies rather than a walk down a
/// chain that gets longer every time somebody eats the same lunch.
pub async fn copy_meal(
    source_subject: String,
    consumed_at_ms: i64,
    image_path: String,
) -> Result<String, String> {
    let store = db()?;
    let container = ensure_meals_container().await?;

    let original = resolve_original(store.as_ref(), &source_subject).await?;
    let resource = store
        .get_resource(&original.as_str().into())
        .await
        .map_err(err)?;
    let Some(source) = read_meal(&resource) else {
        return Err(format!("{original} is not a meal"));
    };

    // Refused rather than copied as "unknown": a suggestion exists to save the
    // estimate, and one with no number saves nothing while quietly logging a
    // meal that no longer looks like it is waiting for anything.
    let Some(calories) = source.calories else {
        return Err(format!(
            "{original} has no calorie count, so there is nothing to copy from it"
        ));
    };

    let mut props: Vec<(&str, Value)> = vec![
        (
            atomic_lib::urls::CONSUMED_AT,
            Value::Timestamp(consumed_at_ms),
        ),
        (
            atomic_lib::urls::MEAL_STATUS,
            Value::AtomicUrl(status_subject("confirmed")?.into()),
        ),
        (
            atomic_lib::urls::COPIED_FROM_MEAL,
            Value::AtomicUrl(original.clone().into()),
        ),
        (atomic_lib::urls::CALORIES, Value::Integer(calories)),
    ];
    if !image_path.is_empty() {
        props.push((atomic_lib::urls::IMAGE_PATH, Value::String(image_path)));
    }
    if !source.notes.is_empty() {
        props.push((atomic_lib::urls::MEAL_NOTES, Value::String(source.notes)));
    }
    for (property, value) in [
        (atomic_lib::urls::CALORIES_MIN, source.calories_min),
        (atomic_lib::urls::CALORIES_MAX, source.calories_max),
    ] {
        if let Some(kcal) = value {
            props.push((property, Value::Integer(kcal)));
        }
    }
    for (property, value) in [
        (atomic_lib::urls::PROTEIN_GRAMS, source.protein_grams),
        (atomic_lib::urls::CARBS_GRAMS, source.carbs_grams),
        (atomic_lib::urls::FAT_GRAMS, source.fat_grams),
    ] {
        if let Some(grams) = value {
            props.push((property, Value::Float(grams)));
        }
    }

    store
        .create_resource(atomic_lib::urls::MEAL, &container, &source.name, Some(props))
        .await
        .map_err(err)
}

/// Walk `copied-from-meal` back to the meal that was actually estimated.
///
/// Bounded rather than trusted: a cycle can only arrive here from a corrupted
/// store or a sync that met one, and neither is worth hanging the shutter over.
/// A link that does not resolve ends the walk where it is — the last meal that
/// does exist is a better answer than an error, because the numbers are on it.
async fn resolve_original(store: &atomic_lib::Db, subject: &str) -> Result<String, String> {
    const MAX_HOPS: usize = 8;

    let mut current = subject.to_string();
    for _ in 0..MAX_HOPS {
        let Ok(resource) = store.get_resource(&current.as_str().into()).await else {
            return Ok(current);
        };
        let parent = string_prop(&resource, atomic_lib::urls::COPIED_FROM_MEAL);
        if parent.is_empty() || parent == current {
            return Ok(current);
        }
        current = parent;
    }
    Ok(current)
}

/// Attach an image embedding to a meal, with the encoder that produced it.
///
/// The two are written together and never apart: a vector whose encoder is
/// unknown cannot be compared to anything, so it is not a half-written meal but
/// a meaningless one. An empty `embedding` clears both, which is what a meal
/// whose encoder has been retired looks like until it is re-encoded.
pub async fn set_meal_embedding(
    subject: String,
    embedding: String,
    model: String,
) -> Result<(), String> {
    let store = db()?;
    let mut resource = store
        .get_resource(&subject.as_str().into())
        .await
        .map_err(err)?;

    if embedding.is_empty() {
        clear(&mut resource, atomic_lib::urls::MEAL_EMBEDDING);
        clear(&mut resource, atomic_lib::urls::EMBEDDED_BY_MODEL);
    } else {
        set(
            &mut resource,
            atomic_lib::urls::MEAL_EMBEDDING,
            Value::String(embedding),
        )?;
        set(
            &mut resource,
            atomic_lib::urls::EMBEDDED_BY_MODEL,
            Value::String(model),
        )?;
    }

    save_and_push(&mut resource, store.as_ref()).await
}

/// Every meal in the container that [`keep`] wants, newest first.
async fn collect_meals(keep: impl Fn(&MealItem) -> bool) -> Result<Vec<MealItem>, String> {
    let store = db()?;
    let container = ensure_meals_container().await?;

    let query = atomic_lib::storelike::Query::new_prop_val(atomic_lib::urls::PARENT, &container);
    let result = store.query(&query).await.map_err(err)?;

    let mut meals: Vec<MealItem> = Vec::new();
    for subject in &result.subjects {
        let Ok(resource) = store.get_resource(subject).await else {
            continue;
        };
        let Some(meal) = read_meal(&resource) else {
            continue;
        };
        if keep(&meal) {
            meals.push(meal);
        }
    }

    meals.sort_by_key(|m| std::cmp::Reverse(m.consumed_at_ms));
    Ok(meals)
}

/// A resource as a meal, or None when it is not one.
fn read_meal(resource: &atomic_lib::Resource) -> Option<MealItem> {
    let is_meal = resource
        .get(atomic_lib::urls::IS_A)
        .map(|v| v.to_string().contains(atomic_lib::urls::MEAL))
        .unwrap_or(false);
    if !is_meal {
        return None;
    }

    // A meal without a readable instant belongs to no day, so it cannot be
    // placed in any range — skipping beats defaulting it to the epoch and
    // having it turn up in whatever the earliest query happens to be.
    let consumed_at_ms = resource
        .get(atomic_lib::urls::CONSUMED_AT)
        .ok()
        .and_then(|v| v.to_int().ok())?;

    Some(MealItem {
        subject: resource.get_subject().to_string(),
        name: string_prop(resource, atomic_lib::urls::NAME),
        description: string_prop(resource, atomic_lib::urls::DESCRIPTION),
        consumed_at_ms,
        status: tag_shortname(resource, atomic_lib::urls::MEAL_STATUS),
        calories: int_prop(resource, atomic_lib::urls::CALORIES),
        calories_min: int_prop(resource, atomic_lib::urls::CALORIES_MIN),
        calories_max: int_prop(resource, atomic_lib::urls::CALORIES_MAX),
        image_path: string_prop(resource, atomic_lib::urls::IMAGE_PATH),
        notes: string_prop(resource, atomic_lib::urls::MEAL_NOTES),
        confidence: tag_shortname(resource, atomic_lib::urls::ESTIMATE_CONFIDENCE),
        estimated_by_model: string_prop(resource, atomic_lib::urls::ESTIMATED_BY_MODEL),
        clarifying_question: string_prop(resource, atomic_lib::urls::CLARIFYING_QUESTION),
        protein_grams: float_prop(resource, atomic_lib::urls::PROTEIN_GRAMS),
        carbs_grams: float_prop(resource, atomic_lib::urls::CARBS_GRAMS),
        fat_grams: float_prop(resource, atomic_lib::urls::FAT_GRAMS),
        meal_embedding: string_prop(resource, atomic_lib::urls::MEAL_EMBEDDING),
        embedded_by_model: string_prop(resource, atomic_lib::urls::EMBEDDED_BY_MODEL),
        copied_from_meal: string_prop(resource, atomic_lib::urls::COPIED_FROM_MEAL),
    })
}

fn string_prop(resource: &atomic_lib::Resource, property: &str) -> String {
    resource
        .get(property)
        .map(|v| v.to_string())
        .unwrap_or_default()
}

fn int_prop(resource: &atomic_lib::Resource, property: &str) -> Option<i64> {
    resource.get(property).ok().and_then(|v| v.to_int().ok())
}

fn float_prop(resource: &atomic_lib::Resource, property: &str) -> Option<f64> {
    resource
        .get(property)
        .ok()
        .and_then(|v| v.to_string().parse::<f64>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::simple::get_property;
    use crate::api::test_store::shared_drive;

    /// One test for the whole container story, deliberately: the tests share a
    /// process-global store, so two of them calling `ensure_meals_container` in
    /// parallel could each find nothing and each create one. That race is what
    /// the sort in `find_meals_container` exists to survive — it is not one to
    /// write a flaky test around.
    #[tokio::test]
    async fn the_meals_container_is_created_once_and_found_again() {
        let drive = shared_drive().await;

        let first = ensure_meals_container().await.unwrap();
        let second = ensure_meals_container().await.unwrap();

        assert_eq!(
            first, second,
            "a second launch must find the container, not make another"
        );
        assert_eq!(
            get_property(first.clone(), atomic_lib::urls::NAME.to_string())
                .await
                .unwrap(),
            MEALS_CONTAINER_NAME
        );
        assert_eq!(
            get_property(first, atomic_lib::urls::PARENT.to_string())
                .await
                .unwrap(),
            drive,
            "meals belong to the drive, so their container has to"
        );
    }

    /// Every meal test shares one store, one drive and one meals container, so
    /// they isolate the only way a range query can be isolated: each takes a
    /// window of the timeline nothing else writes into. `HOUR`-sized steps
    /// inside a window that is decades wide keeps them from ever meeting.
    const HOUR: i64 = 3_600_000;

    async fn meal_at(window: i64, hours: i64, name: &str, calories: Option<i64>) -> String {
        shared_drive().await;
        create_meal(
            window + hours * HOUR,
            name.to_string(),
            String::new(),
            String::new(),
            calories,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_meal_that_is_not_there_is_not_an_error() {
        shared_drive().await;
        assert!(get_meal("https://example.com/nothing".into())
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_logged_meal_comes_back_with_what_was_logged() {
        let window = 1_700_000_000_000;
        let subject = meal_at(window, 1, "Cappuccino", Some(120)).await;

        let meals = list_meals(window, window + 24 * HOUR).await.unwrap();
        let meal = meals.iter().find(|m| m.subject == subject).unwrap();

        assert_eq!(meal.name, "Cappuccino");
        assert_eq!(meal.calories, Some(120));
        assert_eq!(meal.consumed_at_ms, window + HOUR);
        assert_eq!(
            meal.status, "confirmed",
            "a number somebody typed is not an estimate waiting to be made"
        );
        assert_eq!(meal.calories_min, None, "one number is not a range");
        assert_eq!(meal.image_path, "");
    }

    #[tokio::test]
    async fn a_meal_nobody_has_estimated_is_pending_with_no_calories() {
        let window = 1_710_000_000_000;
        let subject = meal_at(window, 1, "", None).await;

        let meals = list_meals(window, window + 24 * HOUR).await.unwrap();
        let meal = meals.iter().find(|m| m.subject == subject).unwrap();

        assert_eq!(meal.status, "pending");
        assert_eq!(
            meal.calories, None,
            "unknown must not arrive as 0 — a day total would swallow it"
        );
        assert_eq!(meal.confidence, "");
    }

    /// The half-open range is what makes a day a day: run two back-to-back
    /// windows over a meal on the seam and it has to land in exactly one.
    #[tokio::test]
    async fn the_range_includes_its_start_and_excludes_its_end() {
        let window = 1_720_000_000_000;
        let midnight = window + 24 * HOUR;
        let on_the_seam = meal_at(window, 24, "Midnight snack", Some(200)).await;
        let just_before = meal_at(window, 23, "Late dinner", Some(600)).await;

        let first_day = list_meals(window, midnight).await.unwrap();
        let second_day = list_meals(midnight, midnight + 24 * HOUR).await.unwrap();

        let subjects = |meals: &[MealItem]| -> Vec<String> {
            meals.iter().map(|m| m.subject.clone()).collect()
        };

        assert!(subjects(&first_day).contains(&just_before));
        assert!(!subjects(&first_day).contains(&on_the_seam));
        assert!(subjects(&second_day).contains(&on_the_seam));
        assert!(!subjects(&second_day).contains(&just_before));
    }

    #[tokio::test]
    async fn meals_come_back_newest_first() {
        let window = 1_730_000_000_000;
        let breakfast = meal_at(window, 8, "Breakfast", Some(400)).await;
        let dinner = meal_at(window, 19, "Dinner", Some(800)).await;
        let lunch = meal_at(window, 13, "Lunch", Some(600)).await;

        let meals = list_meals(window, window + 24 * HOUR).await.unwrap();

        assert_eq!(
            meals.iter().map(|m| m.subject.clone()).collect::<Vec<_>>(),
            vec![dinner, lunch, breakfast]
        );
    }

    #[tokio::test]
    async fn editing_a_meal_keeps_what_was_not_edited() {
        let window = 1_740_000_000_000;
        let subject = meal_at(window, 12, "Sandwich", Some(350)).await;

        update_meal(subject.clone(), Some("Cheese sandwich".into()), None, None)
            .await
            .unwrap();

        let meals = list_meals(window, window + 24 * HOUR).await.unwrap();
        let meal = meals.iter().find(|m| m.subject == subject).unwrap();

        assert_eq!(meal.name, "Cheese sandwich");
        assert_eq!(meal.calories, Some(350));
    }

    /// Correcting the number by hand is the user answering the question the
    /// estimator exists to answer, so it must stop being a meal the estimator
    /// would pick up and overwrite.
    #[tokio::test]
    async fn typing_a_calorie_count_confirms_the_meal() {
        let window = 1_750_000_000_000;
        let subject = meal_at(window, 12, "Mystery bowl", None).await;

        update_meal(subject.clone(), None, None, Some(450))
            .await
            .unwrap();

        let meals = list_meals(window, window + 24 * HOUR).await.unwrap();
        let meal = meals.iter().find(|m| m.subject == subject).unwrap();

        assert_eq!(meal.calories, Some(450));
        assert_eq!(meal.status, "confirmed");
    }

    #[tokio::test]
    async fn a_status_the_ontology_does_not_allow_is_refused() {
        let window = 1_760_000_000_000;
        let subject = meal_at(window, 12, "Soup", None).await;

        set_meal_status(subject.clone(), "estimating".into())
            .await
            .unwrap();
        let error = set_meal_status(subject.clone(), "done".into())
            .await
            .unwrap_err();
        assert!(error.contains("done"), "the error has to name the mistake");

        let meals = list_meals(window, window + 24 * HOUR).await.unwrap();
        let meal = meals.iter().find(|m| m.subject == subject).unwrap();
        assert_eq!(
            meal.status, "estimating",
            "the refused write must not have landed"
        );
    }

    #[tokio::test]
    async fn a_deleted_meal_stops_being_listed() {
        let window = 1_770_000_000_000;
        let subject = meal_at(window, 12, "Regrettable", Some(900)).await;

        crate::api::simple::delete_resource(subject.clone())
            .await
            .unwrap();

        let meals = list_meals(window, window + 24 * HOUR).await.unwrap();
        assert!(!meals.iter().any(|m| m.subject == subject));
    }

    // ── Estimates ──────────────────────────────────────────────────────────

    fn estimate(calories: i64) -> MealEstimate {
        MealEstimate {
            name: "Cappuccino with oat milk".into(),
            description: "A takeaway cup, roughly 250 ml".into(),
            calories,
            calories_min: Some(90),
            calories_max: Some(160),
            confidence: "medium".into(),
            model: "openai/gpt-5.6-luna".into(),
            clarifying_question: String::new(),
            protein_grams: Some(4.5),
            carbs_grams: Some(12.0),
            fat_grams: Some(5.5),
        }
    }

    async fn reload(window: i64, subject: &str) -> MealItem {
        let meals = list_meals(window, window + 24 * HOUR).await.unwrap();
        meals.into_iter().find(|m| m.subject == subject).unwrap()
    }

    #[tokio::test]
    async fn an_estimate_fills_the_meal_in_and_settles_it() {
        let window = 1_780_000_000_000;
        let subject = meal_at(window, 9, "", None).await;

        update_meal_estimate(subject.clone(), estimate(120))
            .await
            .unwrap();

        let meal = reload(window, &subject).await;
        assert_eq!(meal.name, "Cappuccino with oat milk");
        assert_eq!(meal.calories, Some(120));
        assert_eq!(meal.calories_min, Some(90));
        assert_eq!(meal.calories_max, Some(160));
        assert_eq!(meal.confidence, "medium");
        assert_eq!(meal.estimated_by_model, "openai/gpt-5.6-luna");
        assert_eq!(meal.protein_grams, Some(4.5));
        assert_eq!(
            meal.status, "estimated",
            "numbers a model produced are not numbers a human agreed with"
        );
        assert_eq!(meal.clarifying_question, "");
    }

    /// The whole point of the uncertainty loop: a question makes the meal
    /// something the user can answer, and the question has to be on it or there
    /// is nothing to ask them.
    #[tokio::test]
    async fn a_question_makes_the_meal_need_an_answer() {
        let window = 1_790_000_000_000;
        let subject = meal_at(window, 9, "", None).await;

        let mut estimate = estimate(140);
        estimate.confidence = "low".into();
        estimate.clarifying_question = "Was that milk or oat milk?".into();
        update_meal_estimate(subject.clone(), estimate).await.unwrap();

        let meal = reload(window, &subject).await;
        assert_eq!(meal.status, "needs-info");
        assert_eq!(meal.clarifying_question, "Was that milk or oat milk?");
        assert_eq!(meal.calories, Some(140), "a guess is still worth having");
    }

    /// Re-estimating after the answer arrives has to leave nothing of the old
    /// estimate behind — a meal that still shows a question it has been told
    /// the answer to reads as the app not having listened.
    #[tokio::test]
    async fn a_second_estimate_drops_what_the_first_one_asked() {
        let window = 1_800_000_000_000;
        let subject = meal_at(window, 9, "", None).await;

        let mut first = estimate(140);
        first.clarifying_question = "Was that milk or oat milk?".into();
        update_meal_estimate(subject.clone(), first).await.unwrap();

        let mut second = estimate(120);
        second.calories_min = None;
        second.calories_max = None;
        second.protein_grams = None;
        update_meal_estimate(subject.clone(), second).await.unwrap();

        let meal = reload(window, &subject).await;
        assert_eq!(meal.status, "estimated");
        assert_eq!(meal.clarifying_question, "");
        assert_eq!(
            meal.calories_min, None,
            "a bound the new estimate does not stand behind must not survive it"
        );
        assert_eq!(meal.protein_grams, None);
    }

    /// The user correcting a meal while its estimate was in flight. Two correct
    /// behaviours racing, and the human wins.
    #[tokio::test]
    async fn an_estimate_does_not_overwrite_a_confirmed_meal() {
        let window = 1_810_000_000_000;
        let subject = meal_at(window, 9, "Porridge", Some(300)).await;

        update_meal_estimate(subject.clone(), estimate(120))
            .await
            .unwrap();

        let meal = reload(window, &subject).await;
        assert_eq!(meal.calories, Some(300));
        assert_eq!(meal.name, "Porridge");
        assert_eq!(meal.status, "confirmed");
    }

    /// The clarification loop, from both ends: the answer has to reach the next
    /// prompt, and it has to still be there after that prompt is answered — a
    /// meal that gets re-estimated twice must not end up feeding the model its
    /// own last reply as the eater's words.
    #[tokio::test]
    async fn an_estimate_reads_the_notes_and_leaves_them_alone() {
        let window = 1_860_000_000_000;
        let subject = meal_at(window, 9, "", None).await;

        update_meal(subject.clone(), None, Some("Oat milk".into()), None)
            .await
            .unwrap();
        assert_eq!(reload(window, &subject).await.notes, "Oat milk");

        update_meal_estimate(subject.clone(), estimate(120))
            .await
            .unwrap();
        update_meal_estimate(subject.clone(), estimate(130))
            .await
            .unwrap();

        let meal = reload(window, &subject).await;
        assert_eq!(
            meal.notes, "Oat milk",
            "what the eater wrote is the one thing an estimate must not touch"
        );
        assert_eq!(
            meal.description, "A takeaway cup, roughly 250 ml",
            "and the reasoning is replaced whole rather than piled up"
        );
    }

    #[tokio::test]
    async fn a_meal_can_be_fetched_by_subject() {
        let window = 1_870_000_000_000;
        let subject = meal_at(window, 9, "Ramen", Some(700)).await;

        let meal = get_meal(subject.clone()).await.unwrap().unwrap();

        assert_eq!(meal.subject, subject);
        assert_eq!(meal.name, "Ramen");
        assert_eq!(meal.calories, Some(700));
    }

    #[tokio::test]
    async fn a_confidence_the_ontology_does_not_allow_is_refused() {
        let window = 1_820_000_000_000;
        let subject = meal_at(window, 9, "", None).await;

        let mut estimate = estimate(120);
        estimate.confidence = "quite sure".into();
        let error = update_meal_estimate(subject.clone(), estimate)
            .await
            .unwrap_err();

        assert!(error.contains("quite sure"), "the error has to name the mistake");
        let meal = reload(window, &subject).await;
        assert_eq!(
            meal.status, "pending",
            "a refused estimate must leave the meal in the queue, not half-written"
        );
        assert_eq!(meal.calories, None);
    }

    // ── Copies ─────────────────────────────────────────────────────────────

    /// The whole point of a suggestion: the numbers and the eater's own words
    /// come across, so the meal is finished the moment it is logged.
    #[tokio::test]
    async fn a_copy_carries_the_numbers_and_the_words() {
        let window = 1_880_000_000_000;
        let source = meal_at(window, 8, "", None).await;
        update_meal_estimate(source.clone(), estimate(420)).await.unwrap();
        update_meal(source.clone(), None, Some("Rye bread, two slices".into()), None)
            .await
            .unwrap();

        let copy = copy_meal(source.clone(), window + 30 * HOUR, "photos/9.jpg".into())
            .await
            .unwrap();

        let meal = reload(window + 24 * HOUR, &copy).await;
        assert_eq!(meal.name, "Cappuccino with oat milk");
        assert_eq!(meal.calories, Some(420));
        assert_eq!(meal.calories_min, Some(90));
        assert_eq!(meal.calories_max, Some(160));
        assert_eq!(meal.protein_grams, Some(4.5));
        assert_eq!(meal.notes, "Rye bread, two slices");
        assert_eq!(meal.image_path, "photos/9.jpg");
        assert_eq!(meal.copied_from_meal, source);
        assert_eq!(
            meal.status, "confirmed",
            "somebody looked at the food and said it was this — no estimator may revisit it"
        );
    }

    /// A copy was not estimated, and must not claim to have been. Everything the
    /// model wrote is an account of a different photograph.
    #[tokio::test]
    async fn a_copy_claims_nothing_a_model_said() {
        let window = 1_890_000_000_000;
        let source = meal_at(window, 8, "", None).await;
        let mut asked = estimate(300);
        asked.clarifying_question = "Was that milk or oat milk?".into();
        update_meal_estimate(source.clone(), asked).await.unwrap();

        let copy = copy_meal(source, window + 30 * HOUR, String::new())
            .await
            .unwrap();

        let meal = reload(window + 24 * HOUR, &copy).await;
        assert_eq!(meal.description, "", "the reasoning was about another photo");
        assert_eq!(meal.estimated_by_model, "");
        assert_eq!(meal.confidence, "");
        assert_eq!(
            meal.clarifying_question, "",
            "a confirmed meal carrying a question would be a dead end nobody can answer"
        );
    }

    /// Copies of copies are what a routine meal produces, and a chain that grows
    /// a link a day is a chain something eventually has to walk. Resolving at
    /// write time keeps every copy one hop from the meal that was estimated.
    #[tokio::test]
    async fn a_copy_of_a_copy_points_at_the_original() {
        let window = 1_900_000_000_000;
        let original = meal_at(window, 8, "", None).await;
        update_meal_estimate(original.clone(), estimate(500)).await.unwrap();

        let first = copy_meal(original.clone(), window + 30 * HOUR, String::new())
            .await
            .unwrap();
        let second = copy_meal(first.clone(), window + 54 * HOUR, String::new())
            .await
            .unwrap();

        assert_eq!(
            reload(window + 48 * HOUR, &second).await.copied_from_meal,
            original,
            "not {first}, which is itself a copy"
        );
    }

    #[tokio::test]
    async fn a_meal_with_no_number_is_nothing_to_copy() {
        let window = 1_910_000_000_000;
        let source = meal_at(window, 8, "Mystery", None).await;

        let error = copy_meal(source, window + 30 * HOUR, String::new())
            .await
            .unwrap_err();

        assert!(error.contains("no calorie count"));
    }

    // ── Embeddings ─────────────────────────────────────────────────────────

    /// The vector and the encoder that made it travel together, because a vector
    /// whose encoder is unknown is not comparable to anything.
    #[tokio::test]
    async fn an_embedding_round_trips_with_its_encoder() {
        let window = 1_920_000_000_000;
        let subject = meal_at(window, 8, "Porridge", Some(350)).await;

        set_meal_embedding(subject.clone(), "AQIDBA==".into(), "mobileclip-s0".into())
            .await
            .unwrap();

        let meal = reload(window, &subject).await;
        assert_eq!(meal.meal_embedding, "AQIDBA==");
        assert_eq!(meal.embedded_by_model, "mobileclip-s0");

        set_meal_embedding(subject.clone(), String::new(), String::new())
            .await
            .unwrap();

        let meal = reload(window, &subject).await;
        assert_eq!(meal.meal_embedding, "");
        assert_eq!(
            meal.embedded_by_model, "",
            "an encoder with no vector to name is worse than nothing — it would \
             put the meal in an index it has no entry in"
        );
    }

    // ── The queue ──────────────────────────────────────────────────────────

    /// The queue is not a day, so this one runs against every meal there is —
    /// which the other tests are constantly adding to. It asserts about its own
    /// meals only, and about the *order* of those, which is the property that
    /// makes a queue a queue.
    #[tokio::test]
    async fn the_queue_holds_what_has_no_number_yet_oldest_first() {
        let window = 1_830_000_000_000;
        let older = meal_at(window, 1, "", None).await;
        let newer = meal_at(window, 5, "", None).await;
        let typed = meal_at(window, 3, "Toast", Some(200)).await;
        let done = meal_at(window, 4, "", None).await;
        update_meal_estimate(done.clone(), estimate(120))
            .await
            .unwrap();

        let queue = list_pending_meals().await.unwrap();
        let subjects: Vec<String> = queue.iter().map(|m| m.subject.clone()).collect();

        assert!(!subjects.contains(&typed), "a number somebody typed needs nothing");
        assert!(!subjects.contains(&done), "an estimated meal is off the queue");
        let older_at = subjects.iter().position(|s| s == &older).unwrap();
        let newer_at = subjects.iter().position(|s| s == &newer).unwrap();
        assert!(
            older_at < newer_at,
            "the meal that has been waiting longest is the one to do next"
        );
    }

    /// An app killed mid-call leaves a meal marked `estimating` and no process
    /// that is estimating it. Left off the queue it would sit there forever.
    #[tokio::test]
    async fn a_meal_abandoned_mid_estimate_is_still_in_the_queue() {
        let window = 1_840_000_000_000;
        let subject = meal_at(window, 9, "", None).await;
        set_meal_status(subject.clone(), "estimating".into())
            .await
            .unwrap();

        let queue = list_pending_meals().await.unwrap();

        assert!(queue.iter().any(|m| m.subject == subject));
    }

    #[tokio::test]
    async fn a_meal_that_gave_up_is_not_retried_on_its_own() {
        let window = 1_850_000_000_000;
        let subject = meal_at(window, 9, "", None).await;
        set_meal_status(subject.clone(), "failed".into())
            .await
            .unwrap();

        let queue = list_pending_meals().await.unwrap();

        assert!(
            !queue.iter().any(|m| m.subject == subject),
            "three failures in a row are not fixed by a fourth; retrying is the user's call"
        );
    }

    /// The container is the app's, but nothing stops something else from
    /// putting a resource in it — and a folder is not a meal.
    #[tokio::test]
    async fn only_meals_are_listed() {
        shared_drive().await;
        let container = ensure_meals_container().await.unwrap();
        let store = db().unwrap();
        let folder = store
            .create_resource(atomic_lib::urls::FOLDER, &container, "Not a meal", None)
            .await
            .unwrap();

        // Deliberately unbounded: this one is about the class filter, and other
        // tests' meals in the result are no trouble as long as the folder isn't.
        let meals = list_meals(i64::MIN, i64::MAX).await.unwrap();

        assert!(!meals.iter().any(|m| m.subject == folder));
    }
}
