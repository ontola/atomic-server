//! One database for the whole test binary.
//!
//! `state::DB` is a `OnceLock`, so the first `open_db` in the process wins and
//! every later one is a no-op — and `setup()` would swap the active agent and
//! drive out from under whatever else is running. Both would be a source of
//! tests that pass alone and fail together, so every test in this crate takes
//! its store from here and isolates by resource instead.

use crate::api::simple::{open_db, setup};

pub(crate) async fn shared_drive() -> &'static str {
    static SETUP: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();

    SETUP
        .get_or_init(|| async {
            let dir =
                std::env::temp_dir().join(format!("calorie-tracker-bridge-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();

            open_db(dir.to_string_lossy().into_owned()).await.unwrap();
            setup("Test device".to_string())
                .await
                .unwrap()
                .drive_subject
        })
        .await
        .as_str()
}
