//! ACL zones: nearest rights-bearing ancestor is the unit of access control.
//!
//! See `planning/zones.md`. A **zone root** is any resource that carries an
//! explicit `read` / `write` / `append` property, or a born top-level resource
//! (no parent — drives and other parentless DIDs). Every other resource belongs
//! to exactly one zone: its nearest zone-root ancestor (possibly itself).
//!
//! The `subject → zone` mapping is derived, not authored. This module resolves
//! it by walking parents; a persisted index can wrap the same helpers later
//! (OQ2 in the plan).

use crate::{errors::AtomicResult, hierarchy::Right, urls, Resource, Storelike, Subject};

/// Properties whose presence on a resource makes it a zone root.
pub const ZONE_RIGHT_PROPS: &[&str] = &[urls::READ, urls::WRITE, urls::APPEND];

/// True when `resource` carries any rights array (`read` / `write` / `append`),
/// or is a born top-level resource (no `parent`). Setting rights is what
/// promotes a mid-tree resource into a zone; removing them demotes it.
pub fn is_zone_root(resource: &Resource) -> bool {
    if resource.get(urls::PARENT).is_err() {
        return true;
    }
    ZONE_RIGHT_PROPS
        .iter()
        .any(|prop| resource.get(prop).is_ok())
}

/// Walk parents until a zone root is found. Returns the resource itself when it
/// is already a zone root. Fails when the parent chain is broken before a zone
/// can be derived — callers that authorize commits should reject, not quarantine
/// (see `planning/zones.md`).
pub async fn resolve_zone(store: &impl Storelike, resource: &Resource) -> AtomicResult<Resource> {
    let mut current = resource.clone();
    let mut guard = 0u32;
    loop {
        if is_zone_root(&current) {
            return Ok(current);
        }
        current = current.get_parent(store).await.map_err(|e| {
            format!(
                "Cannot derive zone for {}: parent chain broken before a zone root ({e})",
                resource.get_subject()
            )
        })?;
        guard += 1;
        if guard > 10_000 {
            return Err(format!(
                "Cannot derive zone for {}: parent chain too deep (cycle?)",
                resource.get_subject()
            )
            .into());
        }
    }
}

/// Subject of the zone that `resource` belongs to.
pub async fn resolve_zone_subject(
    store: &impl Storelike,
    resource: &Resource,
) -> AtomicResult<Subject> {
    Ok(resolve_zone(store, resource).await?.get_subject().clone())
}

/// Whether `agent` appears in the zone root's explicit rights for `right`
/// (including write→read/append implication), or is the public agent match.
pub fn agent_in_zone_acl(
    store: &impl Storelike,
    zone: &Resource,
    normalized_agent: &Subject,
    right: Right,
) -> AtomicResult<Option<String>> {
    let mut properties_to_check = vec![right.to_string()];
    if matches!(right, Right::Read | Right::Append) {
        properties_to_check.push(urls::WRITE.to_string());
    }

    for prop in properties_to_check {
        let Ok(arr_val) = zone.get(&prop) else {
            continue;
        };
        for s in arr_val.to_subjects(None)? {
            match s.as_str() {
                urls::PUBLIC_AGENT => {
                    return Ok(Some(format!(
                        "PublicAgent has been granted rights in zone {}",
                        zone.get_subject()
                    )));
                }
                agent => {
                    // Pre-DID stores hold `internal:/agents/{pubkey}` while
                    // signers arrive as `did:ad:agent:{pubkey}`.
                    let migrated = crate::agents::migrate_legacy_agent_subject(agent);
                    let normalized_grant = store.normalize_subject(&migrated.as_str().into());
                    if &normalized_grant == normalized_agent {
                        return Ok(Some(format!(
                            "Right has been explicitly set on zone {}",
                            zone.get_subject()
                        )));
                    }
                }
            }
        }
    }
    Ok(None)
}

/// Implicit creator write (and implied read/append): the genesis signer of
/// `resource` always has write authority on that resource. See
/// `planning/authorization-sync.md` and `planning/zones.md`.
pub fn agent_is_resource_creator(resource: &Resource, normalized_agent: &Subject) -> bool {
    match resource.genesis_signer() {
        Some(signer) => {
            let migrated = crate::agents::migrate_legacy_agent_subject(&signer);
            migrated == normalized_agent.to_string() || signer == normalized_agent.to_string()
        }
        None => false,
    }
}

/// Compare the authored `drive` stamp (if any) to the derived zone subject.
///
/// Under the zone model these disagree whenever a mid-tree ACL exists: the
/// stamp still points at the drive root while the zone is the nested ACL
/// resource. Returns `Ok(None)` when there is no stamp; `Ok(Some(true))` when
/// they agree; `Ok(Some(false))` on intentional nested-zone mismatch or a
/// latent bug. Used by migration verification (step 1 in `planning/zones.md`).
pub async fn drive_stamp_matches_zone(
    store: &impl Storelike,
    resource: &Resource,
) -> AtomicResult<Option<bool>> {
    let Some(stamp) = resource.get_drive() else {
        return Ok(None);
    };
    let zone = resolve_zone_subject(store, resource).await?;
    Ok(Some(stamp.pure_id() == zone.pure_id()))
}

/// Collect every subject in `zone`'s organizational subtree that still belongs
/// to this zone — BFS that **stops at nested zone boundaries**. Wire-visible
/// sync/quota change from `collect_drive_subjects` (see `planning/zones.md`).
pub async fn collect_zone_subjects(
    store: &impl Storelike,
    zone_root: &Subject,
) -> AtomicResult<Vec<Subject>> {
    let mut out = Vec::new();
    let mut queue = vec![zone_root.clone()];
    let mut seen = std::collections::HashSet::new();

    while let Some(subject) = queue.pop() {
        let pure = subject.pure_id();
        if !seen.insert(pure.clone()) {
            continue;
        }
        out.push(subject.clone());

        // Children: resources whose `parent` is this subject.
        let children = find_children(store, &subject).await?;
        for child_subject in children {
            let child = store.get_resource(&child_subject).await?;
            // Nested zone roots are separate sync/quota units — do not descend.
            if is_zone_root(&child) && child.get_subject() != zone_root {
                continue;
            }
            queue.push(child_subject);
        }
    }
    Ok(out)
}

async fn find_children(store: &impl Storelike, parent: &Subject) -> AtomicResult<Vec<Subject>> {
    let query = crate::storelike::Query::new_prop_val(urls::PARENT, parent.as_str());
    let result = store.query(&query).await?;
    Ok(result.subjects)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{agents::ForAgent, hierarchy, Storelike, Value};

    async fn setup() -> (crate::Store, crate::agents::Agent) {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let agent = store.create_agent(Some("zone-tester")).await.unwrap();
        store.set_default_agent(agent.clone());
        (store, agent)
    }

    async fn make_child(
        store: &crate::Store,
        parent: Subject,
        rights: Option<(bool, bool)>,
    ) -> Subject {
        let mut res = Resource::new("did:ad:placeholder".into());
        res.set(urls::PARENT.into(), Value::AtomicUrl(parent), store)
            .await
            .unwrap();
        if let Some((public_read, _write_self)) = rights {
            if public_read {
                res.set(
                    urls::READ.into(),
                    Value::ResourceArray(vec![urls::PUBLIC_AGENT.into()]),
                    store,
                )
                .await
                .unwrap();
            }
        }
        res.save_as_genesis(store)
            .await
            .unwrap()
            .resource_new
            .unwrap()
            .get_subject()
            .clone()
    }

    #[tokio::test]
    async fn parentless_resource_is_a_born_zone() {
        let (store, _) = setup().await;
        let drive = crate::test_utils::create_test_drive(&store).await.unwrap();
        let drive_res = store.get_resource(&drive).await.unwrap();
        assert!(is_zone_root(&drive_res));
        let zone = resolve_zone_subject(&store, &drive_res).await.unwrap();
        assert_eq!(zone.pure_id(), drive.pure_id());
    }

    #[tokio::test]
    async fn mid_tree_acl_promotes_to_zone_and_children_resolve_to_it() {
        let (store, _) = setup().await;
        let drive = crate::test_utils::create_test_drive(&store).await.unwrap();
        let folder = make_child(&store, drive.clone(), Some((true, false))).await;
        let child = make_child(&store, folder.clone(), None).await;

        let folder_res = store.get_resource(&folder).await.unwrap();
        let child_res = store.get_resource(&child).await.unwrap();
        assert!(is_zone_root(&folder_res));
        assert!(!is_zone_root(&child_res));

        let child_zone = resolve_zone_subject(&store, &child_res).await.unwrap();
        assert_eq!(child_zone.pure_id(), folder.pure_id());
    }

    #[tokio::test]
    async fn nested_zone_replaces_outer_acl_completely() {
        let (store, agent) = setup().await;
        // Private drive (born zone, no public read).
        let drive = crate::test_utils::create_test_drive(&store).await.unwrap();
        // Outer shared folder: public read.
        let outer = make_child(&store, drive.clone(), Some((true, false))).await;
        // Nested zone with an empty-of-public ACL: only the creator via
        // implicit write. Setting write=[agent] (and no public read) makes it
        // a zone whose ACL replaces the outer public-read zone.
        let mut inner = Resource::new("did:ad:placeholder".into());
        inner
            .set(urls::PARENT.into(), Value::AtomicUrl(outer.clone()), &store)
            .await
            .unwrap();
        inner
            .set(
                urls::WRITE.into(),
                Value::ResourceArray(vec![agent.subject.to_string().into()]),
                &store,
            )
            .await
            .unwrap();
        let inner_subj = inner
            .save_as_genesis(&store)
            .await
            .unwrap()
            .resource_new
            .unwrap()
            .get_subject()
            .clone();
        let leaf = make_child(&store, inner_subj.clone(), None).await;

        let leaf_res = store.get_resource(&leaf).await.unwrap();
        let zone = resolve_zone_subject(&store, &leaf_res).await.unwrap();
        assert_eq!(zone.pure_id(), inner_subj.pure_id());

        // Public may read the outer zone's own children, but not the nested zone.
        let outer_child = make_child(&store, outer.clone(), None).await;
        let outer_child_res = store.get_resource(&outer_child).await.unwrap();
        assert!(
            hierarchy::check_read(&store, &outer_child_res, &ForAgent::Public)
                .await
                .is_ok()
        );
        assert!(
            hierarchy::check_read(&store, &leaf_res, &ForAgent::Public)
                .await
                .is_err(),
            "nested zone ACL must replace outer public read, not intersect"
        );
    }

    #[tokio::test]
    async fn demoting_a_zone_returns_descendants_to_parent_zone() {
        let (store, _) = setup().await;
        let drive = crate::test_utils::create_test_drive(&store).await.unwrap();
        let folder = make_child(&store, drive.clone(), Some((true, false))).await;
        let child = make_child(&store, folder.clone(), None).await;

        // Remove the ACL → demote; child should resolve to the drive.
        let folder_res = store.get_resource(&folder).await.unwrap();
        let mut demote = crate::commit::CommitBuilder::new(folder.clone());
        demote.remove(urls::READ.into());
        let agent = store.get_default_agent().unwrap();
        let commit = demote.sign(&agent, &store, &folder_res).await.unwrap();
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

        let folder_after = store.get_resource(&folder).await.unwrap();
        let child_after = store.get_resource(&child).await.unwrap();
        assert!(!is_zone_root(&folder_after));
        assert_eq!(
            resolve_zone_subject(&store, &child_after)
                .await
                .unwrap()
                .pure_id(),
            drive.pure_id()
        );
    }
}
