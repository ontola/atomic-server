use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::{
    agents::ForAgent, errors::AtomicResult, storelike::ResourceResponse, urls, Commit, Db, Resource,
};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub struct GetExtenderContext<'a> {
    pub store: &'a Db,
    pub url: &'a url::Url,
    pub db_resource: &'a mut Resource,
    pub for_agent: &'a ForAgent,
}

pub struct CommitExtenderContext<'a> {
    pub store: &'a Db,
    pub commit: &'a Commit,
    pub resource: &'a Resource,
}

pub type ResourceGetHandler = Arc<
    dyn for<'a> Fn(GetExtenderContext<'a>) -> BoxFuture<'a, AtomicResult<ResourceResponse>>
        + Send
        + Sync,
>;
pub type CommitHandler =
    Arc<dyn for<'a> Fn(CommitExtenderContext<'a>) -> BoxFuture<'a, AtomicResult<()>> + Send + Sync>;

#[derive(Clone)]
pub struct ClassExtender {
    pub class: String,
    pub on_resource_get: Option<ResourceGetHandler>,
    pub before_commit: Option<CommitHandler>,
    pub after_commit: Option<CommitHandler>,
}

impl ClassExtender {
    pub fn resource_has_extender(&self, resource: &Resource) -> AtomicResult<bool> {
        let Ok(is_a) = resource.get(urls::IS_A) else {
            return Ok(false);
        };

        Ok(is_a.to_subjects(None)?.iter().any(|c| c == &self.class))
    }

    pub fn wrap_get_handler<F>(handler: F) -> ResourceGetHandler
    where
        F: for<'a> Fn(GetExtenderContext<'a>) -> BoxFuture<'a, AtomicResult<ResourceResponse>>
            + Send
            + Sync
            + 'static,
    {
        Arc::new(handler)
    }

    pub fn wrap_commit_handler<F>(handler: F) -> CommitHandler
    where
        F: for<'a> Fn(CommitExtenderContext<'a>) -> BoxFuture<'a, AtomicResult<()>>
            + Send
            + Sync
            + 'static,
    {
        Arc::new(handler)
    }
}
