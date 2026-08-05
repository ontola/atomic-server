//! Meals — the part of the bridge this app owns.
//!
//! `simple.rs` next door is a copy of the Atomic Canvas bridge, kept
//! structurally identical to it so the two can be merged into one crate later
//! (`planning/calorie-tracker-plan.md` §9). Everything calorie-specific lives
//! here instead, so that merge stays a copy rather than a diff. Meal CRUD and
//! the day queries land here in Phase 2; Phase 1 only needs the container they
//! all hang under.

use atomic_lib::Storelike;

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
}
