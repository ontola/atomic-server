//! Looking for a newer version of the desktop app, and installing it.
//!
//! The updater needs the public half of the release signing key, which only
//! release builds have (see `tauri.updater.conf.json` and the `updater`
//! feature). Without the feature the two commands the page calls still exist
//! and answer "nothing is waiting", so development and plain `cargo tauri
//! build` runs never reach out for updates.

#[cfg(feature = "updater")]
use std::sync::Mutex;
#[cfg(feature = "updater")]
use std::time::Duration;
#[cfg(feature = "updater")]
use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(feature = "updater")]
use tauri_plugin_updater::{Update, UpdaterExt};

/// How long after launch the first check waits, so it never competes with the
/// app starting up.
#[cfg(feature = "updater")]
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
/// An app left open for days still hears about a release.
#[cfg(feature = "updater")]
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// The update found by the last check, kept so a click can install it.
#[cfg(feature = "updater")]
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

/// What the page is told about a waiting update.
#[derive(Clone, serde::Serialize)]
pub struct Available {
  version: String,
  notes: Option<String>,
}

#[cfg(feature = "updater")]
impl Available {
  fn of(update: &Update) -> Self {
    Self {
      version: update.version.clone(),
      notes: update.body.clone(),
    }
  }
}

#[cfg(feature = "updater")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R, tauri_plugin_updater::Config> {
  tauri_plugin_updater::Builder::new().build()
}

/// Checks shortly after launch and then every few hours, for as long as the
/// app runs.
#[cfg(feature = "updater")]
pub fn watch(app: AppHandle) {
  app.manage(PendingUpdate::default());
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(FIRST_CHECK_DELAY).await;

    loop {
      if let Err(e) = check(&app).await {
        // Offline is normal; the next round tries again.
        eprintln!("[updater] check failed: {e}");
      }
      tokio::time::sleep(CHECK_EVERY).await;
    }
  });
}

#[cfg(feature = "updater")]
async fn check(app: &AppHandle) -> Result<(), tauri_plugin_updater::Error> {
  let Some(update) = app.updater()?.check().await? else {
    return Ok(());
  };
  let available = Available::of(&update);
  *app.state::<PendingUpdate>().0.lock().unwrap() = Some(update);
  let _ = app.emit("update-available", available);

  Ok(())
}

/// The update the last check found, for a page that loaded after the event.
#[cfg(feature = "updater")]
#[tauri::command]
pub fn pending_update(pending: State<'_, PendingUpdate>) -> Option<Available> {
  pending.0.lock().unwrap().as_ref().map(Available::of)
}

#[cfg(not(feature = "updater"))]
#[tauri::command]
pub fn pending_update() -> Option<Available> {
  None
}

/// Downloads and installs the waiting update, then restarts into it.
#[cfg(feature = "updater")]
#[tauri::command]
pub async fn install_update(
  app: AppHandle,
  pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
  let update = pending
    .0
    .lock()
    .unwrap()
    .take()
    .ok_or("No update is waiting.")?;
  update
    .download_and_install(|_, _| {}, || {})
    .await
    .map_err(|e| e.to_string())?;
  app.restart()
}

#[cfg(not(feature = "updater"))]
#[tauri::command]
pub async fn install_update() -> Result<(), String> {
  Err("This build does not update itself.".into())
}
