use std::sync::Mutex;

use atomic_lib::{urls, Db};

use crate::convert::{resolve_property, string_to_value};
use crate::{block_on, err, AtomicSdkError};

#[derive(uniffi::Object)]
pub struct Resource {
    inner: Mutex<atomic_lib::Resource>,
    db: Db,
}

impl std::fmt::Debug for Resource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Resource")
            .field("subject", &self.subject())
            .finish()
    }
}

impl Resource {
    pub(crate) fn new(inner: atomic_lib::Resource, db: Db) -> Self {
        Self {
            inner: Mutex::new(inner),
            db,
        }
    }
}

#[uniffi::export]
impl Resource {
    pub fn subject(&self) -> String {
        self.inner.lock().unwrap().get_subject().to_string()
    }

    pub fn name(&self) -> Option<String> {
        self.inner
            .lock()
            .unwrap()
            .get(urls::NAME)
            .ok()
            .map(|v| v.to_string())
    }

    pub fn set_name(&self, name: String) -> Result<(), AtomicSdkError> {
        self.inner
            .lock()
            .unwrap()
            .set_unsafe(urls::NAME.into(), atomic_lib::Value::String(name))
            .map_err(err)?;
        Ok(())
    }

    pub fn set(&self, property: String, value: String) -> Result<(), AtomicSdkError> {
        let prop = resolve_property(&property);
        self.inner
            .lock()
            .unwrap()
            .set_unsafe(prop, string_to_value(&value))
            .map_err(err)?;
        Ok(())
    }

    pub fn get(&self, property: String) -> Option<String> {
        let prop = resolve_property(&property);
        self.inner
            .lock()
            .unwrap()
            .get(&prop)
            .ok()
            .map(|v| v.to_string())
    }

    pub fn contains(&self, property: String) -> bool {
        let prop = resolve_property(&property);
        self.inner.lock().unwrap().get(&prop).is_ok()
    }

    pub fn keys(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap()
            .get_propvals()
            .keys()
            .cloned()
            .collect()
    }

    pub fn to_json(&self) -> Result<String, AtomicSdkError> {
        self.inner.lock().unwrap().to_json_ad(None).map_err(err)
    }

    pub fn save(&self) -> Result<(), AtomicSdkError> {
        let mut inner = self.inner.lock().unwrap();
        let response = block_on(inner.save_locally(&self.db)).map_err(err)?;
        crate::peer::publish_live(&response);
        Ok(())
    }

    /// Sign the pending edits and POST the commit to an AtomicServer `/commit`.
    ///
    /// For `did:ad:` resources the store needs a `server` origin. HTTP(S)
    /// subjects post to that subject's own host.
    pub fn save_remote(&self) -> Result<String, AtomicSdkError> {
        let mut inner = self.inner.lock().unwrap();
        block_on(inner.save_remote(&self.db)).map_err(err)
    }

    /// Delete this resource from the store.
    ///
    /// Named `destroy_resource` so UniFFI Kotlin does not collide with
    /// `Disposable.destroy()` (the FFI handle teardown).
    pub fn destroy_resource(&self) -> Result<(), AtomicSdkError> {
        let mut inner = self.inner.lock().unwrap();
        block_on(inner.destroy(&self.db)).map_err(err)?;
        Ok(())
    }
}
