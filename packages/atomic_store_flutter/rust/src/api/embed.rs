//! The embedded renderer's channel into the store.

/// One call from the page: `method` and its arguments (a JSON array), answered
/// as JSON. The page's `NativeClientDb` is the other end
/// (`browser/lib/src/client-db.native.ts`).
pub async fn embed_call(method: String, args_json: String) -> Result<String, String> {
    crate::embed::call(&method, &args_json).await
}

impl super::resources::AtomicStore {
    /// [`embed_call`] answered from this handle's store, signing as its agent
    /// and pushing its writes through its own session: for an app that opened
    /// its store with `AtomicStore.open` instead of `open_db`.
    pub async fn embed_call(&self, method: String, args_json: String) -> Result<String, String> {
        atomic_lib::host::embed::EmbedHost::new(
            atomic_lib::runtime::AtomicNode::from_db((*self.db).clone()),
            self.pusher(),
            self.profiles.clone(),
        )
        .with_recents(self.recents.clone())
        .call(&method, &args_json)
        .await
    }
}
