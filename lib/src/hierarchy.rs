//! The Hierarchy model describes how Resources are structured in a tree-like shape.
//! It deals with authorization (read / write permissions, rights, grants)
//! See

use core::fmt;

use crate::{agents::ForAgent, errors::AtomicResult, urls, Resource, Storelike};

#[cfg(target_arch = "wasm32")]
type AsyncResult<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + 'a>>;
#[cfg(not(target_arch = "wasm32"))]
type AsyncResult<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy)]
pub enum Right {
    /// Full read access to the resource and its children.
    /// [urls::READ]
    Read,
    /// Full edit, update, destroy access to the resource and its children.
    /// [urls::WRITE]
    Write,
    /// Create new children (append to tree)
    /// [urls::APPEND]
    Append,
}

impl fmt::Display for Right {
    fn fmt(&self, fmt: &mut fmt::Formatter) -> fmt::Result {
        let str = match self {
            Right::Read => urls::READ,
            Right::Write => urls::WRITE,
            Right::Append => urls::APPEND,
        };
        fmt.write_str(str)
    }
}

/// The authorization relevance of a single commit: which authority-defining
/// facts it establishes or mutates. A cross-agent verifier (e.g. a granted
/// replica reconstructing a drive) must retain and replay these to prove who
/// may read or write a resource — ordinary content commits can be discarded,
/// these cannot. See `planning/authorization-sync.md` "Node-as-granted-replica"
/// (P2).
///
/// This *labels* a commit; it makes no rights decision (that is
/// [`check_rights`]). Derived purely from the properties a commit changed plus
/// its genesis / destroy flags — no store access.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AuthImpact {
    /// Establishes the resource and, through its signature, its creator — the
    /// root of write authority (see `planning/genesis-self-verifying.md`).
    pub genesis: bool,
    /// Mutates the `read` ACL.
    pub read: bool,
    /// Mutates the `write` ACL.
    pub write: bool,
    /// Mutates the `append` ACL.
    pub append: bool,
    /// Re-parents the resource, changing the rights it inherits.
    pub parent: bool,
    /// Destroys the resource; the tombstone is authorization-relevant.
    pub destroy: bool,
}

impl AuthImpact {
    /// Whether this commit carries authority-defining information a cross-agent
    /// proof depends on — and so must survive any future content-commit pruning.
    /// A commit that changes only ordinary content is not critical.
    pub fn is_critical(&self) -> bool {
        self.genesis || self.read || self.write || self.append || self.parent || self.destroy
    }
}

/// Classify a commit's [`AuthImpact`] from the property URLs it changed plus its
/// genesis / destroy flags. Pure: no store access, no rights decision.
pub fn classify_auth_impact(
    changed_props: &std::collections::HashSet<String>,
    is_genesis: bool,
    is_destroy: bool,
) -> AuthImpact {
    AuthImpact {
        genesis: is_genesis,
        read: changed_props.contains(urls::READ),
        write: changed_props.contains(urls::WRITE),
        append: changed_props.contains(urls::APPEND),
        parent: changed_props.contains(urls::PARENT),
        destroy: is_destroy,
    }
}

/// Throws if not allowed.
/// Returns string with explanation if allowed.
pub fn check_write<'a>(
    store: &'a impl Storelike,
    resource: &'a Resource,
    for_agent: &'a ForAgent,
) -> AsyncResult<'a, AtomicResult<String>> {
    Box::pin(check_rights(store, resource, for_agent, Right::Write))
}

/// Does the Agent have the right to read / view the properties of the selected resource, or any of its parents?
/// Throws if not allowed.
/// Returns string with explanation if allowed.
pub fn check_read<'a>(
    store: &'a impl Storelike,
    resource: &'a Resource,
    for_agent: &'a ForAgent,
) -> AsyncResult<'a, AtomicResult<String>> {
    Box::pin(check_rights(store, resource, for_agent, Right::Read))
}

/// Does the Agent have the right to _append_ to its parent?
/// This checks the `append` rights, and if that fails, checks the `write` right.
/// Throws if not allowed.
/// Returns string with explanation if allowed.
#[tracing::instrument(skip_all)]
pub async fn check_append(
    store: &impl Storelike,
    resource: &Resource,
    for_agent: &ForAgent,
) -> AtomicResult<String> {
    match resource.get_parent(store).await {
        Ok(parent) => {
            if let Ok(msg) = check_rights(store, &parent, for_agent, Right::Append).await {
                Ok(msg)
            } else {
                check_rights(store, resource, for_agent, Right::Write).await
            }
        }
        Err(e) => {
            if resource
                .get_classes(store)
                .await?
                .iter()
                .any(|c| c.subject == urls::DRIVE)
                || resource.get_subject().to_string().starts_with("did:")
            {
                // This string is not returned, it's just a check
                Ok(String::from("Drive or DID without a parent can be created"))
            } else {
                Err(e)
            }
        }
    }
}

/// Recursively checks a Resource and its Parents for rights.
/// Throws if not allowed.
/// Returns string with explanation if allowed.
#[tracing::instrument(skip_all, fields(subject = %resource.get_subject(), agent = %for_agent_enum, right = ?right))]
pub fn check_rights<'a>(
    store: &'a impl Storelike,
    resource: &'a Resource,
    for_agent_enum: &'a ForAgent,
    right: Right,
) -> AsyncResult<'a, AtomicResult<String>> {
    Box::pin(async move {
        if for_agent_enum == &ForAgent::Sudo {
            return Ok("Sudo has root access, and can edit anything.".into());
        }
        let for_agent = for_agent_enum.to_string();
        let normalized_for_agent = store.normalize_subject(&for_agent.clone().into());
        if resource.get_subject() == &normalized_for_agent {
            return Ok("Agents can always edit themselves or their children.".into());
        }

        if let Ok(server_agent) = store.get_default_agent() {
            let normalized_server_agent = store.normalize_subject(&server_agent.subject);
            if normalized_server_agent == normalized_for_agent {
                return Ok("Server agent has root access, and can edit anything.".into());
            }
        }

        // Handle Commits.
        if let Ok(commit_subject) = resource.get(urls::SUBJECT) {
            return match right {
                Right::Read => {
                    // Commits can be read when their subject / target is readable.
                    let target = store
                        .get_resource(&commit_subject.to_string().as_str().into())
                        .await?;
                    check_rights(store, &target, for_agent_enum, right).await
                }
                Right::Write => Err("Commits cannot be edited.".into()),
                Right::Append => {
                    Err("Commits cannot have children, you cannot Append to them.".into())
                }
            };
        }

        // Check if the resource's rights explicitly refers to the agent or the public agent
        let mut properties_to_check = vec![right.to_string()];
        if matches!(right, Right::Read | Right::Append) {
            properties_to_check.push(urls::WRITE.to_string());
        }

        for prop in properties_to_check {
            if let Ok(arr_val) = resource.get(&prop) {
                for s in arr_val.to_subjects(None)? {
                    match s.as_str() {
                        urls::PUBLIC_AGENT => {
                            return Ok(format!(
                                "PublicAgent has been granted rights in {}",
                                resource.get_subject()
                            ))
                        }
                        agent => {
                            let normalized_agent = store.normalize_subject(&agent.into());
                            if normalized_agent == normalized_for_agent {
                                return Ok(format!(
                                    "Right has been explicitly set in {}",
                                    resource.get_subject()
                                ));
                            }
                        }
                    };
                }
            }
        }

        // Drive-first (race-free fast path): if this resource carries a `drive`
        // stamp (set at genesis from its cert), check the grant on the drive
        // directly. The drive is a stable, long-lived resource whose grants are
        // always materialized, so this avoids the recursive parent walk that
        // races a not-yet-materialized parent under concurrent creation (the
        // parent-before-child 401 cascade). A deny at the drive falls through to
        // the recursive walk below, which still honors explicit grants on
        // intermediate parents.
        if let Ok(drive_val) = resource.get(urls::DRIVE_PROP) {
            let drive_subject = crate::Subject::from(drive_val.to_string());
            if &drive_subject != resource.get_subject() {
                if let Ok(drive_res) = store.get_resource(&drive_subject).await {
                    if let Ok(reason) = check_rights(store, &drive_res, for_agent_enum, right).await
                    {
                        return Ok(reason);
                    }
                }
            }
        }

        // Try the parents recursively
        tracing::debug!(
            subject = %resource.get_subject(),
            "rights walk: no explicit grant here, ascending to parent"
        );
        match resource.get_parent(store).await {
            Ok(parent) => {
                tracing::debug!(
                    subject = %resource.get_subject(),
                    parent = %parent.get_subject(),
                    "rights walk: ascending"
                );
                return check_rights(store, &parent, for_agent_enum, right).await;
            }
            Err(parent_err) => {
                tracing::warn!(
                    subject = %resource.get_subject(),
                    agent = %for_agent,
                    ?right,
                    parent_err = %parent_err,
                    "rights walk TERMINATED: get_parent failed (this is where the 401 originates)"
                );
            }
        }
        {
            if for_agent_enum == &ForAgent::Public {
                // resource has no parent and agent is not in rights array - check fails
                let action = match right {
                    Right::Read => "readable",
                    Right::Write => "editable",
                    Right::Append => "appendable",
                };
                return Err(crate::errors::AtomicError::unauthorized(format!(
                    "This resource is not publicly {}. Try signing in",
                    action,
                )));
            }
            // resource has no parent and agent is not in rights array - check fails
            Err(crate::errors::AtomicError::unauthorized(format!(
                "No {} right has been found for {} in this resource or its parents",
                right, for_agent
            )))
        }
    })
}

#[cfg(test)]
mod test {
    // use super::*;
    use crate::{datatype::DataType, Storelike, Value};

    // TODO: Add tests for:
    // - basic check_write (should be false for newly created agent)
    // - Malicious Commit (which grants itself write rights)

    mod auth_impact {
        use super::super::classify_auth_impact;
        use crate::urls;
        use std::collections::HashSet;

        fn props(items: &[&str]) -> HashSet<String> {
            items.iter().map(|s| s.to_string()).collect()
        }

        #[test]
        fn ordinary_content_change_is_not_critical() {
            // A commit that only touches description / name defines no authority.
            let impact =
                classify_auth_impact(&props(&[urls::DESCRIPTION, urls::NAME]), false, false);
            assert!(!impact.is_critical());
            assert_eq!(impact, Default::default());
        }

        #[test]
        fn a_read_grant_is_a_read_impact() {
            let impact = classify_auth_impact(&props(&[urls::READ]), false, false);
            assert!(impact.read);
            assert!(impact.is_critical());
            // Granting read says nothing about write/append/parent.
            assert!(!impact.write && !impact.append && !impact.parent);
        }

        #[test]
        fn a_write_grant_is_a_write_impact() {
            let impact = classify_auth_impact(&props(&[urls::WRITE]), false, false);
            assert!(impact.write && impact.is_critical());
        }

        #[test]
        fn an_append_grant_is_an_append_impact() {
            let impact = classify_auth_impact(&props(&[urls::APPEND]), false, false);
            assert!(impact.append && impact.is_critical());
        }

        #[test]
        fn a_reparent_changes_inherited_rights_and_is_critical() {
            let impact = classify_auth_impact(&props(&[urls::PARENT]), false, false);
            assert!(impact.parent && impact.is_critical());
        }

        #[test]
        fn genesis_is_critical_from_the_flag_regardless_of_props() {
            // Genesis is the authority root even if its changed props are all
            // ordinary content — the label comes from the flag, not the props.
            let impact = classify_auth_impact(&props(&[urls::NAME]), true, false);
            assert!(impact.genesis && impact.is_critical());
        }

        #[test]
        fn destroy_is_critical_from_the_flag() {
            // A destroy commit carries no changed props but is auth-relevant.
            let impact = classify_auth_impact(&props(&[]), false, true);
            assert!(impact.destroy && impact.is_critical());
        }

        #[test]
        fn a_commit_can_carry_several_impacts_at_once() {
            // e.g. a genesis that also seeds read + write ACLs.
            let impact = classify_auth_impact(&props(&[urls::READ, urls::WRITE]), true, false);
            assert!(impact.genesis && impact.read && impact.write);
            assert!(!impact.parent && !impact.destroy);
            assert!(impact.is_critical());
        }
    }

    #[tokio::test]
    async fn authorization() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        // let agent = store.create_agent(Some("test_actor")).unwrap();
        let subject = "https://localhost/new_thing";
        let mut commitbuilder_1 = crate::commit::CommitBuilder::new(subject.into());
        let property = crate::urls::DESCRIPTION;
        let value = Value::new("Some value", &DataType::Markdown).unwrap();
        commitbuilder_1.set(property.into(), value);
        // let mut commitbuilder_2 = commitbuilder_1.clone();
        // let commit_1 = commitbuilder_1.sign(&agent, &store).unwrap();
        // Should fail if there is no self_url set in the store, and no parent in the commit
        // TODO: FINISH THIS
        // commit_1.apply_opts(&store, true, true, true, true).unwrap_err();
        // commitbuilder_2.set(crate::urls::PARENT.into(), Value::AtomicUrl(crate::urls::AGENT.into()));
        // let commit_2 = commitbuilder_2.sign(&agent, &store).unwrap();

        // let resource = store.get_resource(&subject).unwrap();
        // assert!(resource.get(property).unwrap().to_string() == value.to_string());
    }

    #[test]
    fn display_right() {
        let read = super::Right::Read;
        assert_eq!(read.to_string(), super::urls::READ);
        let write = super::Right::Write;
        assert_eq!(write.to_string(), super::urls::WRITE);
    }

    #[tokio::test]
    async fn create_did_agent() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let agent = store.create_agent(Some("test_actor")).await.unwrap();
        store.set_default_agent(agent.clone());

        // Create a drive first so we have a valid parent with write rights
        let drive_did = crate::test_utils::create_test_drive(&store).await.unwrap();

        let subject = "https://localhost/test-did-agent";
        let mut commitbuilder = crate::commit::CommitBuilder::new(subject.into());
        commitbuilder.set(
            crate::urls::DESCRIPTION.into(),
            Value::new("Some value", &DataType::Markdown).unwrap(),
        );
        commitbuilder.set(crate::urls::PARENT.into(), Value::AtomicUrl(drive_did));
        let resource = crate::Resource::new(subject.into());
        let commit = commitbuilder.sign(&agent, &store, &resource).await.unwrap();
        let opts = crate::commit::CommitOpts {
            validate_schema: false,
            validate_signature: false,
            validate_timestamp: true,
            validate_rights: true,
            validate_previous_commit: false,
            validate_loro_causality: false,
            update_index: true,
            validate_for_agent: Some(agent.subject.to_string()),
            source_id: None,
        };
        store.apply_commit(commit, &opts).await.unwrap();
    }

    /// The classifier reads `changed_props`; this pins the assumption it rests
    /// on — that editing a resource's `read` ACL really does surface `read` in
    /// a real commit's changed props (and that a later edit is not genesis).
    #[tokio::test]
    async fn a_real_read_grant_commit_is_labelled_read_critical() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let agent = store.create_agent(Some("granter")).await.unwrap();
        store.set_default_agent(agent.clone());
        let drive_did = crate::test_utils::create_test_drive(&store).await.unwrap();

        let opts = crate::commit::CommitOpts {
            validate_schema: false,
            validate_signature: false,
            validate_timestamp: true,
            validate_rights: true,
            validate_previous_commit: false,
            validate_loro_causality: false,
            update_index: true,
            validate_for_agent: Some(agent.subject.to_string()),
            source_id: None,
        };

        // Genesis: create a resource under the drive.
        let subject = "https://localhost/granted-thing";
        let mut genesis = crate::commit::CommitBuilder::new(subject.into());
        genesis.set(
            crate::urls::PARENT.into(),
            Value::AtomicUrl(drive_did.clone()),
        );
        genesis.set(
            crate::urls::DESCRIPTION.into(),
            Value::new("x", &DataType::Markdown).unwrap(),
        );
        let commit = genesis
            .sign(&agent, &store, &crate::Resource::new(subject.into()))
            .await
            .unwrap();
        store.apply_commit(commit, &opts).await.unwrap();

        // A later, non-genesis commit that edits the `read` ACL.
        let current = store.get_resource(&subject.into()).await.unwrap();
        let mut grant = crate::commit::CommitBuilder::new(subject.into());
        grant.set(
            crate::urls::READ.into(),
            Value::ResourceArray(vec![crate::urls::PUBLIC_AGENT.into()]),
        );
        let commit = grant.sign(&agent, &store, &current).await.unwrap();
        let response = store.apply_commit(commit, &opts).await.unwrap();

        let impact = response.auth_impact();
        assert!(
            impact.read,
            "editing the read ACL must be labelled a read impact; changed_props={:?}",
            response.changed_props
        );
        assert!(impact.is_critical());
        assert!(!impact.genesis, "a later edit is not genesis");
    }

    /// Moving a resource out of a publicly readable drive and into a private
    /// one must revoke public read. The `drive` propval is a rights shortcut,
    /// so it has to track the resource's current parent, not the one it had at
    /// genesis.
    #[tokio::test]
    async fn moving_a_resource_to_a_private_drive_revokes_public_read() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let agent = store.create_agent(Some("mover")).await.unwrap();
        store.set_default_agent(agent.clone());

        let opts = crate::commit::CommitOpts {
            validate_schema: false,
            validate_signature: false,
            validate_timestamp: true,
            validate_rights: true,
            validate_previous_commit: false,
            validate_loro_causality: false,
            update_index: true,
            validate_for_agent: Some(agent.subject.to_string()),
            source_id: None,
        };

        // A public drive (anyone may read) and a private one (only the agent).
        let public_drive = crate::test_utils::create_test_drive(&store).await.unwrap();
        let mut drive_res = store.get_resource(&public_drive).await.unwrap();
        drive_res
            .push(crate::urls::READ, crate::urls::PUBLIC_AGENT.into(), true)
            .unwrap();
        drive_res.save_locally(&store).await.unwrap();

        let private_drive = crate::test_utils::create_test_drive(&store).await.unwrap();

        // Genesis a DID resource under the public drive. It must be a DID, since
        // that is what gets the `drive` rights-shortcut stamp.
        let mut post = crate::Resource::new("did:ad:placeholder".into());
        post.set(
            crate::urls::PARENT.into(),
            Value::AtomicUrl(public_drive.clone()),
            &store,
        )
        .await
        .unwrap();
        post.set(
            crate::urls::DESCRIPTION.into(),
            Value::new("a draft", &DataType::Markdown).unwrap(),
            &store,
        )
        .await
        .unwrap();
        // Clients stamp `drive` at genesis (create_did / browser newResource).
        post.set(
            crate::urls::DRIVE_PROP.into(),
            Value::AtomicUrl(public_drive.clone()),
            &store,
        )
        .await
        .unwrap();
        let subject = post
            .save_as_genesis(&store)
            .await
            .unwrap()
            .resource_new
            .unwrap()
            .get_subject()
            .clone();

        let resource = store.get_resource(&subject).await.unwrap();
        assert_eq!(
            resource.get(crate::urls::DRIVE_PROP).unwrap().to_string(),
            public_drive.to_string(),
            "sanity: genesis stamps the drive"
        );
        assert!(
            super::check_read(&store, &resource, &crate::agents::ForAgent::Public)
                .await
                .is_ok(),
            "sanity: a resource on a public drive is publicly readable"
        );

        // Move it to the private drive.
        let current = store.get_resource(&subject).await.unwrap();
        let mut move_commit = crate::commit::CommitBuilder::new(subject.clone());
        move_commit.set(
            crate::urls::PARENT.into(),
            Value::AtomicUrl(private_drive.clone()),
        );
        let commit = move_commit.sign(&agent, &store, &current).await.unwrap();
        store.apply_commit(commit, &opts).await.unwrap();

        let moved = store.get_resource(&subject).await.unwrap();
        assert_eq!(
            moved.get(crate::urls::PARENT).unwrap().to_string(),
            private_drive.to_string(),
            "sanity: the move landed"
        );

        let public_read = super::check_read(&store, &moved, &crate::agents::ForAgent::Public).await;
        assert!(
            public_read.is_err(),
            "a resource moved to a private drive must not stay publicly readable. \
             drive stamp is still {:?}; check_read said: {:?}",
            moved.get(crate::urls::DRIVE_PROP).map(|v| v.to_string()),
            public_read
        );
    }

    /// The CMS publication model: one drive that is *not* publicly readable,
    /// holding a public folder and a private drafts folder. Publishing and
    /// unpublishing are re-parenting between the two, so the public/private
    /// boundary is a real authorization boundary rather than a status label.
    #[tokio::test]
    async fn a_public_folder_in_a_private_drive_publishes_only_its_own_children() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let agent = store.create_agent(Some("editor")).await.unwrap();
        store.set_default_agent(agent.clone());

        let opts = crate::commit::CommitOpts {
            validate_schema: false,
            validate_signature: false,
            validate_timestamp: true,
            validate_rights: true,
            validate_previous_commit: false,
            validate_loro_causality: false,
            update_index: true,
            validate_for_agent: Some(agent.subject.to_string()),
            source_id: None,
        };

        // The drive itself is NOT publicly readable.
        let drive = crate::test_utils::create_test_drive(&store).await.unwrap();

        let make_child = |parent: crate::Subject, public: bool| {
            let store = &store;
            async move {
                let mut res = crate::Resource::new("did:ad:placeholder".into());
                res.set(crate::urls::PARENT.into(), Value::AtomicUrl(parent), store)
                    .await
                    .unwrap();
                if public {
                    res.set(
                        crate::urls::READ.into(),
                        Value::ResourceArray(vec![crate::urls::PUBLIC_AGENT.into()]),
                        store,
                    )
                    .await
                    .unwrap();
                }

                res.save_as_genesis(store)
                    .await
                    .unwrap()
                    .resource_new
                    .unwrap()
                    .get_subject()
                    .clone()
            }
        };

        // A public site folder and a private drafts folder, both on that drive.
        let site_folder = make_child(drive.clone(), true).await;
        let drafts_folder = make_child(drive.clone(), false).await;

        let published = make_child(site_folder.clone(), false).await;
        let draft = make_child(drafts_folder.clone(), false).await;

        let can_read = |subject: crate::Subject| {
            let store = &store;
            async move {
                let res = store.get_resource(&subject).await.unwrap();
                super::check_read(store, &res, &crate::agents::ForAgent::Public)
                    .await
                    .is_ok()
            }
        };

        assert!(
            !can_read(drive.clone()).await,
            "the drive itself must stay private"
        );
        assert!(
            can_read(published.clone()).await,
            "a child of the public folder inherits public read"
        );
        assert!(
            !can_read(draft.clone()).await,
            "a draft in the same drive, outside the public folder, must NOT be publicly readable"
        );

        // Publish: re-parent the draft into the public folder.
        let current = store.get_resource(&draft).await.unwrap();
        let mut publish = crate::commit::CommitBuilder::new(draft.clone());
        publish.set(
            crate::urls::PARENT.into(),
            Value::AtomicUrl(site_folder.clone()),
        );
        let commit = publish.sign(&agent, &store, &current).await.unwrap();
        store.apply_commit(commit, &opts).await.unwrap();

        assert!(
            can_read(draft.clone()).await,
            "publishing by re-parenting into the public folder must grant public read"
        );

        // Unpublish: move it back out.
        let current = store.get_resource(&draft).await.unwrap();
        let mut unpublish = crate::commit::CommitBuilder::new(draft.clone());
        unpublish.set(
            crate::urls::PARENT.into(),
            Value::AtomicUrl(drafts_folder.clone()),
        );
        let commit = unpublish.sign(&agent, &store, &current).await.unwrap();
        store.apply_commit(commit, &opts).await.unwrap();

        assert!(
            !can_read(draft.clone()).await,
            "unpublishing by re-parenting out of the public folder must revoke public read"
        );
    }
}
