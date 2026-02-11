use atomic_lib::{
    agents::Agent,
    class_extender::BoxFuture,
    endpoints::{Endpoint, HandleGetContext},
    errors::AtomicResult,
    storelike::ResourceResponse,
    urls,
    utils::check_valid_url,
    Resource, Storelike, Value,
};

use crate::invite_token::InviteToken;

pub fn invite_endpoint() -> Endpoint {
    Endpoint {
        path: urls::PATH_INVITE.to_string(),
        params: vec!["token".to_string()],
        description: "Stateless invite endpoint that accepts user-signed tokens.".to_string(),
        shortname: "invites".to_string(),
        handle: Some(handle_invite_request),
        handle_post: None,
    }
}

pub fn handle_invite_request<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandleGetContext {
            subject,
            store,
            for_agent,
        } = context;

        let query_pairs = subject.query_pairs();
        let mut token_str = None;
        let mut public_key = None;
        for (k, v) in query_pairs {
            match k.as_ref() {
                "token" => token_str = Some(v.to_string()),
                "public-key" | "publicKey" => public_key = Some(v.to_string()),
                _ => {}
            }
        }

        let token_str = match token_str {
            Some(t) => t,
            None => return invite_endpoint().to_resource_response(store).await,
        };

        let token = InviteToken::decode(&token_str)?;
        token.verify(store).await?;

        let agent = match for_agent {
            atomic_lib::agents::ForAgent::AgentSubject(s) => Some(s.to_owned()),
            atomic_lib::agents::ForAgent::Sudo => {
                return Err("Sudo agent cannot accept invites.".into());
            }
            atomic_lib::agents::ForAgent::Public => {
                if let Some(pk) = public_key {
                    tracing::info!("Creating new agent from public key: {}", pk);
                    let new_agent = Agent::new_from_public_key(&pk)?;
                    // Create an agent if there is none, but skip save_locally for DIDs to avoid "Parent not found" errors
                    if store
                        .get_resource(&new_agent.subject.clone().into())
                        .await
                        .is_err()
                        && !new_agent.subject.starts_with("did:")
                    {
                        new_agent.to_resource()?.save_locally(store).await?;
                    }

                    // Always add write rights to the agent itself
                    if !new_agent.subject.starts_with("did:") {
                        add_rights(&new_agent.subject, &new_agent.subject, true, store).await?;
                    }

                    Some(new_agent.subject)
                } else {
                    tracing::info!("No public key provided for unauthenticated invite request");
                    None
                }
            }
        };

        if let Some(agent) = agent {
            tracing::info!("Redirecting to target with agent: {}", agent);
            add_rights(&agent, &token.target, token.write, store).await?;
            if token.write {
                add_rights(&agent, &token.target, false, store).await?;
            }

            let mut redirect = Resource::new_instance(urls::REDIRECT, store).await?;
            redirect
                .set(
                    urls::DESTINATION.into(),
                    Value::AtomicUrl(token.target.into()),
                    store,
                )
                .await?;
            redirect.set_subject(subject.to_string());

            Ok(redirect.into())
        } else {
            // Unauthenticated and no public-key provided, return virtual Invite resource
            let mut invite = Resource::new_instance(urls::INVITE, store).await?;
            invite.set_subject(subject.to_string());
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

            let target_resource = store.get_resource(&token.target.clone().into()).await?;
            let title = target_resource
                .get(urls::NAME)
                .map(|v| v.to_string())
                .unwrap_or_else(|_| token.target.clone());
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
        }
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
    if !agent.starts_with("did:") {
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
