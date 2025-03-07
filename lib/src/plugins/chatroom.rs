/*!
# ChatRoom
These are similar to Channels in Slack or Discord.
They list a bunch of Messages.
*/

use crate::{
    class_extender::{ClassExtender, CommitExtenderContext, GetExtenderContext},
    commit::{CommitBuilder, CommitOpts},
    errors::AtomicResult,
    storelike::{Query, QueryResult, ResourceResponse},
    urls::{self, PARENT},
    utils,
    values::SubResource,
    Storelike, Value,
};

// Find the messages for the ChatRoom
#[tracing::instrument(skip(context))]
pub fn construct_chatroom(context: GetExtenderContext) -> AtomicResult<ResourceResponse> {
    let GetExtenderContext {
        store,
        url,
        db_resource: resource,
        for_agent,
    } = context;

    // TODO: From range
    let mut start_val = utils::now();
    for (k, v) in url.query_pairs() {
        if k.as_ref() == "before-timestamp" {
            start_val = v.parse::<i64>()?;
        }
    }

    let page_limit = 50;

    // First, find all children
    let query_children = Query {
        property: Some(PARENT.into()),
        value: Some(Value::AtomicUrl(resource.get_subject().clone())),
        // We fetch one extra to see if there are more, so we can create a next-page URL
        limit: Some(page_limit + 1),
        start_val: None,
        end_val: Some(Value::Timestamp(start_val)),
        offset: 0,
        sort_by: Some(urls::CREATED_AT.into()),
        sort_desc: true,
        include_external: false,
        include_nested: true,
        for_agent: for_agent.clone(),
    };

    let QueryResult {
        mut subjects,
        resources,
        count,
    } = store.query(&query_children)?;

    // An attempt at creating a `next_page` URL on the server. But to be honest, it's probably better to do this in the front-end.
    if count > page_limit {
        let last_subject = resources
            .last()
            .ok_or("There are more messages than the page limit")?
            .get_subject();
        let last_resource = store.get_resource(last_subject)?;
        let last_timestamp = last_resource.get(urls::CREATED_AT)?;
        let next_page_url = url::Url::parse_with_params(
            resource.get_subject(),
            &[("before-timestamp", last_timestamp.to_string())],
        )?;
        resource.set(
            urls::NEXT_PAGE.into(),
            Value::AtomicUrl(next_page_url.to_string()),
            store,
        )?;
    }

    // Clients expect messages to appear from old to new
    subjects.reverse();

    resource.set(urls::MESSAGES.into(), subjects.into(), store)?;

    Ok(ResourceResponse::ResourceWithReferenced(
        resource.to_owned(),
        resources,
    ))
}

/// Update the ChatRoom with the new message, make sure this is sent to all Subscribers
#[tracing::instrument(skip(context))]
pub fn after_apply_commit_message(context: CommitExtenderContext) -> AtomicResult<()> {
    let CommitExtenderContext {
        store,
        commit: applied_commit,
        resource,
    } = context;

    // only update the ChatRoom for _new_ messages, not for edits
    if applied_commit.previous_commit.is_none() {
        // Get the related ChatRoom
        let parent_subject = resource
            .get(urls::PARENT)
            .map_err(|_e| "Message must have a Parent!")?
            .to_string();

        // We need to push the Appended messages to all listeners of the ChatRoom.
        // We do this by creating a new Commit and sending that.
        // We do not save the actual changes in the ChatRoom itself for performance reasons.

        // We use the ChatRoom only for its `last_commit`
        let chat_room = store.get_resource(&parent_subject)?;

        let mut commit_builder = CommitBuilder::new(parent_subject);

        commit_builder.push_propval(
            urls::MESSAGES,
            SubResource::Subject(resource.get_subject().to_string()),
        )?;

        let commit = commit_builder.sign(&store.get_default_agent()?, store, &chat_room)?;

        let resp =
            commit.validate_and_build_response(&CommitOpts::no_validations_no_index(), store)?;

        store.handle_commit(&resp);
    }
    Ok(())
}

pub fn build_chatroom_extender() -> ClassExtender {
    ClassExtender {
        class: urls::CHATROOM.to_string(),
        on_resource_get: Some(construct_chatroom),
        before_commit: None,
        after_commit: None,
    }
}

pub fn build_message_extender() -> ClassExtender {
    ClassExtender {
        class: urls::MESSAGE.to_string(),
        on_resource_get: None,
        before_commit: None,
        after_commit: Some(after_apply_commit_message),
    }
}
