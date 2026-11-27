//! Bundled defaults must bootstrap without consulting a vocabulary server.
use async_trait::async_trait;
use atomic_lib::{
    agents::Agent,
    atoms::Atom,
    errors::AtomicResult,
    storelike::{Query, QueryResult},
    Resource, Store, Storelike, Subject, Value,
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct OfflineDefaults {
    inner: Store,
    network_attempts: AtomicUsize,
}

#[async_trait]
impl Storelike for OfflineDefaults {
    async fn add_atoms(&self, _: Vec<Atom>) -> AtomicResult<()> {
        Err("bootstrap must use resource writes".into())
    }
    fn add_drive_mapping(&self, host: &str, drive: &Value) -> AtomicResult<()> {
        self.inner.add_drive_mapping(host, drive)
    }
    fn remove_drive_mapping(&self, host: &str) -> AtomicResult<()> {
        self.inner.remove_drive_mapping(host)
    }
    async fn add_resource_opts(
        &self,
        resource: &Resource,
        required: bool,
        index: bool,
        overwrite: bool,
    ) -> AtomicResult<()> {
        if required {
            resource.check_required_props(self).await?;
        }
        self.inner
            .add_resource_opts(resource, false, index, overwrite)
            .await
    }
    fn all_resources(&self, external: bool) -> Box<dyn Iterator<Item = Resource> + Send> {
        self.inner.all_resources(external)
    }
    fn has_stored_resource(&self, subject: &Subject) -> bool {
        self.inner.has_stored_resource(subject)
    }
    async fn get_resource(&self, subject: &Subject) -> AtomicResult<Resource> {
        if let Some(resource) = self
            .inner
            .all_resources(true)
            .find(|r| r.get_subject() == subject)
        {
            return Ok(resource);
        }
        self.fetch_resource(subject.as_str(), None).await
    }
    async fn fetch_resource(&self, subject: &str, _: Option<&Agent>) -> AtomicResult<Resource> {
        self.network_attempts.fetch_add(1, Ordering::Relaxed);
        Err(format!("offline bootstrap forbids fetching {subject}").into())
    }
    async fn remove_resource(&self, _: &Subject) -> AtomicResult<()> {
        Err("bootstrap must not remove resources".into())
    }
    async fn query(&self, _: &Query) -> AtomicResult<QueryResult> {
        Err("bootstrap must not need a query".into())
    }
    fn set_default_agent(&self, agent: Agent) {
        self.inner.set_default_agent(agent);
    }
}

#[tokio::test]
async fn bundled_defaults_import_without_network_access() {
    // Start with precisely the hardcoded base models, like a fresh database
    // just before importing the bundled JSON resources. Every cache miss is a
    // refused network attempt rather than a real HTTP request or a test cache.
    let store = OfflineDefaults {
        inner: Store::init().await.unwrap(),
        network_attempts: AtomicUsize::new(0),
    };
    atomic_lib::populate::populate_default_store(&store)
        .await
        .unwrap();
    assert_eq!(store.network_attempts.load(Ordering::Relaxed), 0);
    for subject in [
        atomic_lib::urls::NAME,
        atomic_lib::urls::ENDPOINT_RESPONSE,
        atomic_lib::urls::RESPONSE_MESSAGE,
        atomic_lib::urls::STATUS,
        "https://atomicdata.dev/ontology/data-browser/property/resources",
    ] {
        assert!(
            store.has_stored_resource(&subject.into()),
            "missing bundled resource: {subject}"
        );
    }
}
