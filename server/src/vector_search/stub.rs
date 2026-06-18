use crate::config::Config;
use crate::errors::AtomicServerResult;
use atomic_lib::{Db, Resource};
use std::sync::Arc;

/// No-op vector search state when the `vector-search` feature is disabled at compile time.
#[derive(Clone)]
pub struct VectorSearchState;

impl VectorSearchState {
    pub fn is_enabled(&self) -> bool {
        false
    }

    pub async fn new(
        _config: &Config,
        _index_notifier: Option<Arc<dyn Fn(&str, bool) + Send + Sync>>,
    ) -> AtomicServerResult<Self> {
        tracing::info!("Vector search disabled (compiled without vector-search feature)");
        Ok(Self)
    }

    pub fn is_drive_indexing(&self, _drive: &str) -> bool {
        false
    }

    pub async fn add_all_resources(&self, _store: &Db) -> AtomicServerResult<()> {
        Ok(())
    }

    pub async fn embed_chunks(&self, _chunks: &[String]) -> AtomicServerResult<Vec<Vec<f32>>> {
        Ok(Vec::new())
    }

    pub async fn create_resource_chunks(
        &self,
        _resource: &Resource,
        _store: &Db,
    ) -> AtomicServerResult<Option<(String, Vec<String>, Vec<String>, Vec<String>)>> {
        Ok(None)
    }

    pub async fn add_resource(&self, _resource: &Resource, _store: &Db) -> AtomicServerResult<()> {
        Ok(())
    }

    pub async fn flush_pending(&self) -> AtomicServerResult<()> {
        Ok(())
    }

    pub async fn scrub_pending_for_subject(&self, _subject: &str) {}

    pub async fn remove_resource(&self, _subject: &str) -> AtomicServerResult<()> {
        Ok(())
    }
}
