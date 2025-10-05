use atomic_lib::{
    class_extender::BoxFuture,
    endpoints::{Endpoint, HandleGetContext, HandlePostContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls,
    utils::check_valid_url,
    Resource, Storelike, Subject, Value,
};

use crate::invite_token::InviteToken;

fn read_token_from_subject(subject: &url::Url) -> Option<String> {
    for (k, v) in subject.query_pairs() {
        if k.as_ref() == "token" {
            return Some(v.to_string());
        }
    }

    None
}

pub fn invite_endpoint() -> Endpoint {
    Endpoint {
        path: urls::PATH_INVITE.to_string(),
        params: vec!["token".to_string()],
        description: "Stateless invite endpoint that accepts user-signed tokens.".to_string(),
        shortname: "invites".to_string(),
        handle: Some(handle_invite_request),
        handle_post: Some(handle_invite_post),
    }
}

pub fn handle_invite_request<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext {
            subject,
            store,
            for_agent: _for_agent,
        } = context;

        let token_str = match read_token_from_subject(&subject) {
            Some(t) => t,
            None => {
                return invite_endpoint()
                    .to_resource_response(store, subject.as_str())
                    .await
            }
        };

        let token = InviteToken::decode(&token_str)?;
        token.verify(store).await?;

        // GET is preview mode only: return a virtual Invite resource so users can review before accepting
        let mut invite = Resource::new_instance(urls::INVITE, store).await?;
        invite.set_subject(subject.to_string());
        // `invite/target` is required on class Invite (`lib/defaults/default_store.json`).
        // If we skip it, the client-side WASM validator rejects the PUT into
        // OPFS, the resource never lands in the store, and the invite page
        // spins on "loading…" forever.
        invite
            .set(urls::TARGET.into(), Value::AtomicUrl(token.target.clone()), store)
            .await?;
        invite
            .set(urls::WRITE_BOOL.into(), Value::Boolean(token.write), store)
            .await?;
        invite
            .set(
                urls::EXPIRES_AT.into(),
                Value::Timestamp(token.expires_at),
                store,
            )
            .await?;

        let target_resource = store.get_resource(&token.target.clone()).await?;
        let title = target_resource
            .get(urls::NAME)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| token.target.to_string());
        invite
            .set(
                urls::DESCRIPTION.into(),
                Value::Markdown(format!(
                    "Stateless invite to {} the resource: {}",
                    if token.write { "edit" } else { "view" },
                    title
                )),
                store,
            )
            .await?;

        Ok(invite.into())
    })
}

pub fn handle_invite_post<'a>(
    context: HandlePostContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandlePostContext {
            subject,
            store,
            for_agent,
            ..
        } = context;

        let token_str = match read_token_from_subject(&subject) {
            Some(t) => t,
            None => {
                return invite_endpoint()
                    .to_resource_response(store, subject.as_str())
                    .await
            }
        };

        let token = InviteToken::decode(&token_str)?;
        token.verify(store).await?;

        let agent = match for_agent {
            atomic_lib::agents::ForAgent::AgentSubject(s) => s.to_owned(),
            atomic_lib::agents::ForAgent::Sudo => {
                return Err("Sudo agent cannot accept invites.".into());
            }
            atomic_lib::agents::ForAgent::Public => {
                return Err("Accepting invite requires an authenticated agent.".into());
            }
        };

        if agent.as_str().starts_with("did:ad:agent:")
            && store.get_resource(&agent.as_str().into()).await.is_err()
        {
            let mut new_agent = Resource::new_instance(urls::AGENT, store).await?;
            new_agent.set_subject(agent.to_string());
            if let Some(pk) = agent.as_str().strip_prefix("did:ad:agent:") {
                new_agent
                    .set_string(urls::PUBLIC_KEY.into(), pk, store)
                    .await?;
            }
            new_agent.save_locally(store).await?;
        }

        add_rights(agent.as_str(), token.target.as_str(), token.write, store).await?;
        if token.write {
            add_rights(agent.as_str(), token.target.as_str(), false, store).await?;
        }

        let mut redirect = Resource::new_instance(urls::REDIRECT, store).await?;
        redirect
            .set(
                urls::DESTINATION.into(),
                Value::AtomicUrl(token.target.clone()),
                store,
            )
            .await?;
        redirect.set_subject(subject.to_string());

        Ok(redirect.into())
    })
}

/// Adds the requested rights to the target resource.
/// Overwrites the target resource to include the new rights.
/// Checks if the Agent has a valid URL.
/// Will not throw an error if the Agent already has the rights.
#[tracing::instrument(skip(store))]
pub async fn add_rights(
    agent: &str,
    target: &str,
    write: bool,
    store: &impl Storelike,
) -> AtomicResult<()> {
    let agent_subject = Subject::from_raw(agent, store.get_base_domain().as_deref());
    if !agent_subject.is_did() {
        check_valid_url(agent)?;
    }
    // Get the Resource that the user is being invited to
    let mut target = store.get_resource(&target.into()).await?;
    let right = if write { urls::WRITE } else { urls::READ };

    target.push(right, agent.into(), true)?;
    target
        .save_locally(store)
        .await
        .map_err(|e| format!("Unable to save updated target resource. {}", e))?;

    Ok(())
}
