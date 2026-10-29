//! Who is where, on the default store: thin wrappers on `atomic_lib`'s
//! presence hub (`lib/src/host/presence.rs`). The hub speaks the web's
//! `PresenceEntry` wire format, so a browser and the app see each other. The
//! WebSocket session (`ws_sync.rs`) and the WebRTC links carry its updates.
//! See `planning/flutter-presence.md`.

use atomic_lib::host::presence;

/// Announce this device in `drive`. `entry_json` is a JSON object, the web's
/// `PresenceEntry` (`agent`, `resource`, `following`, `allowFollow`, `typing`,
/// `data`). The hub re-sends it every 10 s until [`clear_presence`].
pub async fn set_presence(drive: String, entry_json: String) -> Result<(), String> {
    let entry: serde_json::Value =
        serde_json::from_str(&entry_json).map_err(|e| format!("invalid presence JSON: {e}"))?;
    let store = super::state::default_store()?;
    presence::set_presence(store.db.as_ref(), &drive, entry).map_err(|e| e.to_string())
}

/// Leave `drive`: delete this device's entry so others see it go at once.
pub async fn clear_presence(drive: String) -> Result<(), String> {
    let store = super::state::default_store()?;
    presence::clear_presence(store.db.as_ref(), &drive);
    Ok(())
}

/// The other sessions in `drive` as a JSON array of the web's `PresenceItem`
/// (the entry plus `sessionId`), stable between reads.
pub async fn presence(drive: String) -> Result<String, String> {
    let store = super::state::default_store()?;
    let items = presence::presence(store.db.as_ref(), &drive);
    serde_json::to_string(&items).map_err(|e| e.to_string())
}

/// Counter that changes whenever any drive's presence does, like
/// `storeRevision`: poll it, and re-read [`presence`] when it moved.
#[flutter_rust_bridge::frb(sync)]
pub fn presence_revision() -> u64 {
    presence::presence_revision()
}
