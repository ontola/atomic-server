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
    pub description: String,
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
}

/// Log a meal under the meals container. Returns its subject.
///
/// `calories` decides the status, because those are the same fact: a meal
/// somebody typed a number for is `confirmed` — a human said so, and no
/// estimator should overwrite it — while one without a number is `pending`,
/// which is exactly the queue Phase 4's estimator drains.
pub async fn create_meal(
    consumed_at_ms: i64,
    name: String,
    description: String,
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
    if !description.is_empty() {
        props.push((atomic_lib::urls::DESCRIPTION, Value::String(description)));
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
pub async fn update_meal(
    subject: String,
    name: Option<String>,
    description: Option<String>,
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
    if let Some(description) = description {
        resource
            .set_unsafe(
                atomic_lib::urls::DESCRIPTION.into(),
                Value::String(description),
            )
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
    /// How the estimator got there. Overwrites what was on the meal, which for
    /// a photographed one is nothing and for a typed one was the user's words —
    /// so this must arrive with those words in it (the caller sends them to the
    /// model in the first place).
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
        confidence: tag_shortname(resource, atomic_lib::urls::ESTIMATE_CONFIDENCE),
        estimated_by_model: string_prop(resource, atomic_lib::urls::ESTIMATED_BY_MODEL),
        clarifying_question: string_prop(resource, atomic_lib::urls::CLARIFYING_QUESTION),
        protein_grams: float_prop(resource, atomic_lib::urls::PROTEIN_GRAMS),
        carbs_grams: float_prop(resource, atomic_lib::urls::CARBS_GRAMS),
        fat_grams: float_prop(resource, atomic_lib::urls::FAT_GRAMS),
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
