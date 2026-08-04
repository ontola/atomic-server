use std::sync::{Arc, OnceLock};

static DB: OnceLock<Arc<atomic_lib::Db>> = OnceLock::new();

pub(super) fn db() -> Result<&'static Arc<atomic_lib::Db>, String> {
    DB.get().ok_or_else(|| "Call openDb() first.".into())
}

pub(super) fn set_db(store: atomic_lib::Db) {
    let _ = DB.set(Arc::new(store));
}

pub(super) fn err(e: atomic_lib::AtomicError) -> String {
    e.to_string()
}
