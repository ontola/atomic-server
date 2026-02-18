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
    pub is_new: bool,
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
    pub id: Option<String>,
    pub classes: Vec<String>,
    pub on_resource_get: Option<ResourceGetHandler>,
    pub before_commit: Option<CommitHandler>,
    pub after_commit: Option<CommitHandler>,
    pub scope: ClassExtenderScope,
    pub subject: Option<String>,
}

pub struct ClassExtenderBuilder {
    id: Option<String>,
    classes: Vec<String>,
    on_resource_get: Option<ResourceGetHandler>,
    before_commit: Option<CommitHandler>,
    after_commit: Option<CommitHandler>,
    scope: ClassExtenderScope,
    subject: Option<String>,
}

impl ClassExtenderBuilder {
    pub fn new() -> Self {
        Self {
            id: None,
            classes: Vec::new(),
            on_resource_get: None,
            before_commit: None,
            after_commit: None,
            scope: ClassExtenderScope::Global,
            subject: None,
        }
    }

    pub fn id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    pub fn classes(mut self, classes: Vec<String>) -> Self {
        self.classes = classes;
        self
    }

    pub fn class(mut self, class: impl Into<String>) -> Self {
        self.classes.push(class.into());
        self
    }

    pub fn on_resource_get(mut self, handler: ResourceGetHandler) -> Self {
        self.on_resource_get = Some(handler);
        self
    }

    pub fn on_resource_get_fn<F>(mut self, handler: F) -> Self
    where
        F: for<'a> Fn(GetExtenderContext<'a>) -> BoxFuture<'a, AtomicResult<ResourceResponse>>
            + Send
            + Sync
            + 'static,
    {
        self.on_resource_get = Some(ClassExtender::wrap_get_handler(handler));
        self
    }

    pub fn before_commit(mut self, handler: CommitHandler) -> Self {
        self.before_commit = Some(handler);
        self
    }

    pub fn before_commit_fn<F>(mut self, handler: F) -> Self
    where
        F: for<'a> Fn(CommitExtenderContext<'a>) -> BoxFuture<'a, AtomicResult<()>>
            + Send
            + Sync
            + 'static,
    {
        self.before_commit = Some(ClassExtender::wrap_commit_handler(handler));
        self
    }

    pub fn after_commit(mut self, handler: CommitHandler) -> Self {
        self.after_commit = Some(handler);
        self
    }

    pub fn after_commit_fn<F>(mut self, handler: F) -> Self
    where
        F: for<'a> Fn(CommitExtenderContext<'a>) -> BoxFuture<'a, AtomicResult<()>>
            + Send
            + Sync
            + 'static,
    {
        self.after_commit = Some(ClassExtender::wrap_commit_handler(handler));
        self
    }

    pub fn scope(mut self, scope: ClassExtenderScope) -> Self {
        self.scope = scope;
        self
    }

    pub fn subject(mut self, subject: impl Into<String>) -> Self {
        self.subject = Some(subject.into());
        self
    }

    pub fn build(self) -> ClassExtender {
        ClassExtender {
            id: self.id,
            classes: self.classes,
            on_resource_get: self.on_resource_get,
            before_commit: self.before_commit,
            after_commit: self.after_commit,
            scope: self.scope,
            subject: self.subject,
        }
    }
}

impl Default for ClassExtenderBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl ClassExtender {
    pub fn builder() -> ClassExtenderBuilder {
        ClassExtenderBuilder::new()
    }

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
                let subject = resource.get_subject().clone();
                if subject == scope.clone() {
                    return Ok((true, Some(subject)));
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

    /// Checks if the given resource is the plugin itself.
    /// This can be used to prevent the plugin from extending itself as this could enable malicious behavior.
    pub fn can_extend(&self, resource: &Resource) -> bool {
        if self.subject.is_none() {
            // The extender is not a plugin so it can extend any resource
            return true;
        };

        let Ok(is_a) = resource.get(urls::IS_A) else {
            return true;
        };

        let Ok(is_a_subjects) = is_a.to_subjects(None) else {
            return true;
        };

        // Check if the resource is a plugin, if so return false.
        !is_a_subjects.contains(&urls::PLUGIN.to_string())
    }
}
