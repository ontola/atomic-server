use atomic_lib::{
    agents::Agent,
    class_extender::{BoxFuture, ClassExtender, CommitExtenderContext, GetExtenderContext},
    errors::AtomicResult,
    hierarchy,
    storelike::ResourceResponse,
    urls,
    utils::check_valid_url,
    Resource, Storelike, Value,
};

/// If there is a valid Agent in the correct query param, and the invite is valid, update the rights and respond with a redirect to the target resource
#[tracing::instrument(skip(context))]
pub fn construct_invite_redirect<'a>(
    context: GetExtenderContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let GetExtenderContext {
            store,
            url,
            db_resource,
            for_agent: _,
        } = context;

        let query_params = url.query_pairs();

        let requested_subject = db_resource.get_subject().to_string();
        let mut pub_key = None;
        let mut invite_agent = None;
        for (k, v) in query_params {
            match k.as_ref() {
                "public-key" | urls::INVITE_PUBKEY => pub_key = Some(v.to_string()),
                "agent" | urls::AGENT => invite_agent = Some(v.to_string()),
                _ => {}
            }
        }

        // Check if there is either a publicKey or an Agent present in the request. Either one is needed to continue accepting the invite.
        let agent = match (pub_key, invite_agent) {
            (None, None) => return Ok(db_resource.to_owned().into()),
            (None, Some(agent_url)) => agent_url,
            (Some(public_key), None) => {
                let new_agent = Agent::new_from_public_key(store, &public_key)?;
                // Create an agent if there is none
                match store.get_resource(&new_agent.subject).await {
                    Ok(_found) => {}
                    Err(_) => {
                        new_agent.to_resource()?.save_locally(store).await?;
                    }
                };

                // Always add write rights to the agent itself
                // A bit inefficient, since it re-fetches the agent from the store, but it's not that big of a cost
                add_rights(&new_agent.subject, &new_agent.subject, true, store).await?;
                new_agent.subject
            }
            (Some(_), Some(_)) => {
                return Err(
                    "Either publicKey or agent can be set - not both at the same time.".into(),
                )
            }
        };

        // If there are write or read rights
        let write = if let Ok(bool) = db_resource.get(urls::WRITE_BOOL) {
            bool.to_bool()?
        } else {
            false
        };

        let target = &db_resource
            .get(urls::TARGET)
            .map_err(|e| {
                format!(
                    "Invite {} does not have a target. {}",
                    db_resource.get_subject(),
                    e
                )
            })?
            .to_string();

        store
            .get_resource(target)
            .await
            .map_err(|_| format!("Target for invite does not exist: {}", target))?;

        // If any usages left value is present, make sure it's a positive number and decrement it by 1.
        if let Ok(usages_left) = db_resource.get(urls::USAGES_LEFT) {
            let num = usages_left.to_int()?;
            if num == 0 {
                return Err("No usages left for this invite".into());
            }
            // Since the requested subject might have query params, we don't want to overwrite that one - we want to overwrite the clean resource.
            let mut url = url::Url::parse(&requested_subject)?;
            url.set_query(None);

            db_resource.set_subject(url.to_string());
            db_resource
                .set(urls::USAGES_LEFT.into(), Value::Integer(num - 1), store)
                .await?;
            db_resource
                .save_locally(store)
                .await
                .map_err(|e| format!("Unable to save updated Invite. {}", e))?;
        }

        if let Ok(expires) = db_resource.get(urls::EXPIRES_AT) {
            if expires.to_int()? > atomic_lib::utils::now() {
                return Err("Invite is no longer valid".into());
            }
        }

        // Make sure the creator of the invite is still allowed to Write the target
        let invite_creator =
            crate::plugins::versioning::get_initial_commit_for_resource(target, store)
                .await?
                .signer;
        hierarchy::check_write(
            store,
            &store.get_resource(target).await?,
            &invite_creator.into(),
        )
        .await
        .map_err(|e| format!("Invite creator is not allowed to write the target. {}", e))?;

        add_rights(&agent, target, write, store).await?;
        if write {
            // Also add read rights
            add_rights(&agent, target, false, store).await?;
        }

        // Construct the Redirect Resource, which might provide the Client with a Subject for his Agent.
        let mut redirect = Resource::new_instance(urls::REDIRECT, store).await?;
        redirect
            .set(
                urls::DESTINATION.into(),
                db_resource.get(urls::TARGET)?.to_owned(),
                store,
            )
            .await?;
        redirect
            .set(urls::REDIRECT_AGENT.into(), Value::AtomicUrl(agent), store)
            .await?;
        // The front-end requires the @id to be the same as requested
        redirect.set_subject(requested_subject);
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
    check_valid_url(agent)?;
    // Get the Resource that the user is being invited to
    let mut target = store.get_resource(target).await?;
    let right = if write { urls::WRITE } else { urls::READ };

    target.push(right, agent.into(), true)?;
    target
        .save_locally(store)
        .await
        .map_err(|e| format!("Unable to save updated target resource. {}", e))?;

    Ok(())
}

/// Check if the creator has rights to invite people (= write) to the target resource
pub fn before_apply_commit<'a>(
    context: CommitExtenderContext<'a>,
) -> BoxFuture<'a, AtomicResult<()>> {
    Box::pin(async move {
        let CommitExtenderContext {
            store,
            commit,
            resource,
        } = context;

        let target = resource
            .get(urls::TARGET)
            .map_err(|_e| "Invite does not have required Target attribute")?;

        let target_resource = store.get_resource(&target.to_string()).await?;

        hierarchy::check_write(store, &target_resource, &commit.signer.clone().into()).await?;
        Ok(())
    })
}

pub fn build_invite_extender() -> ClassExtender {
    ClassExtender {
        classes: vec![urls::INVITE.to_string()],
        on_resource_get: Some(ClassExtender::wrap_get_handler(construct_invite_redirect)),
        before_commit: Some(ClassExtender::wrap_commit_handler(before_apply_commit)),
        after_commit: None,
    }
}
