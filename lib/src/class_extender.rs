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

#[derive(Clone)]
pub struct ClassExtender {
    pub class: String,
    pub on_resource_get: Option<fn(GetExtenderContext) -> AtomicResult<ResourceResponse>>,
    pub before_commit: Option<fn(CommitExtenderContext) -> AtomicResult<()>>,
    pub after_commit: Option<fn(CommitExtenderContext) -> AtomicResult<()>>,
}

impl ClassExtender {
    pub fn resource_has_extender(&self, resource: &Resource) -> AtomicResult<bool> {
        let Ok(is_a) = resource.get(urls::IS_A) else {
            return Ok(false);
        };

        Ok(is_a.to_subjects(None)?.iter().any(|c| c == &self.class))
    }
}

pub fn default_class_extenders() -> Vec<ClassExtender> {
    vec![
        crate::collections::build_collection_extender(),
        crate::plugins::invite::build_invite_extender(),
        crate::plugins::chatroom::build_chatroom_extender(),
        crate::plugins::chatroom::build_message_extender(),
    ]
}
