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

#[derive(Clone, Debug)]
pub enum ClassExtenderScope {
    Global,
    Drive(String),
}

#[derive(Clone)]
pub struct ClassExtender {
    pub classes: Vec<String>,
    pub on_resource_get: Option<ResourceGetHandler>,
    pub before_commit: Option<CommitHandler>,
    pub after_commit: Option<CommitHandler>,
    pub scope: ClassExtenderScope,
}

impl ClassExtender {
    pub fn resource_has_extender(&self, resource: &Resource) -> AtomicResult<bool> {
        let Ok(is_a) = resource.get(urls::IS_A) else {
            return Ok(false);
        };

        let resource_classes = is_a.to_subjects(None)?;
        Ok(resource_classes.iter().any(|c| self.classes.contains(c)))
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

    /// Checks if the resource is within the scope of the extender.
    /// To prevent unnecessary database lookups, the cached root can be supplied.
    /// Returns a tuple of (is_in_scope, cached_root).
    pub async fn check_scope(
        &self,
        resource: &Resource,
        store: &Db,
        cached_root: Option<String>,
    ) -> AtomicResult<(bool, Option<String>)> {
        match &self.scope {
            ClassExtenderScope::Drive(scope) => {
                // If the resource is the scope itself we can just return true.
                if resource.get_subject().clone() == scope.clone() {
                    return Ok((true, Some(resource.get_subject().clone())));
                }

                // Find the root parent of the resource or use the cached root.
                let rs = if let Some(rs) = &cached_root {
                    rs.clone()
                } else {
                    let parents = resource.get_parent_tree(store).await?;
                    let Some(root) = parents.last() else {
                        return Ok((false, None));
                    };

                    root.get_subject().clone()
                };

                if rs != *scope {
                    return Ok((false, Some(rs)));
                }

                return Ok((true, Some(rs)));
            }
            ClassExtenderScope::Global => {
                return Ok((true, cached_root));
            }
        }
    }
}
