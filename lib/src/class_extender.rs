use std::sync::Arc;

use crate::{
    agents::ForAgent, errors::AtomicResult, storelike::ResourceResponse, urls, Commit, Db, Resource,
};

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

pub type ResourceGetHandler =
    Arc<dyn Fn(GetExtenderContext) -> AtomicResult<ResourceResponse> + Send + Sync>;
pub type CommitHandler = Arc<dyn Fn(CommitExtenderContext) -> AtomicResult<()> + Send + Sync>;

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
        F: Fn(GetExtenderContext) -> AtomicResult<ResourceResponse> + Send + Sync + 'static,
    {
        Arc::new(handler)
    }

    pub fn wrap_commit_handler<F>(handler: F) -> CommitHandler
    where
        F: Fn(CommitExtenderContext) -> AtomicResult<()> + Send + Sync + 'static,
    {
        Arc::new(handler)
    }
}
