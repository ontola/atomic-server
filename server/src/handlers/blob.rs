use actix_web::{web, HttpResponse};
use atomic_lib::{storelike::Query, urls, Db, Storelike, Value};

use crate::errors::{AppErrorType, AtomicServerError};
use crate::{appstate::AppState, errors::AtomicServerResult};

/// F4 follow-up (planning/unified-sync.md): resolve write-admission for a
/// blob PUT. `Ok(())` iff some resource on this server already references
/// `did:ad:blob:<hash_hex>` via the `BLOB` property, and that resource's
/// drive passes `admit_drive_write`. Pulled out of the HTTP handler so it's
/// unit-testable directly against a `Db` — there's no config-level way to
/// spin up the actix server with a non-default `SyncPolicy` installed
/// (policies are installed programmatically by an embedder, not via CLI
/// flags), so an actix-integration test can't exercise the rejection paths.
async fn resolve_blob_write_admission(store: &Db, hash_hex: &str) -> Result<(), String> {
    // Stored values are canonical (`atomic:blob:`): writes canonicalize
    // them and opening a store rewrites older `did:ad:blob:` values.
    let mut q = Query::new();
    q.property = Some(urls::BLOB.to_string());
    q.value = Some(Value::AtomicUrl(
        atomic_lib::identifiers::blob_subject(hash_hex).into(),
    ));
    let resources = store.query(&q).await.map_err(|e| e.to_string())?.resources;

    if resources.is_empty() {
        return Err(format!(
            "No resource references atomic:blob:{hash_hex} yet — post the commit that \
             references it before pushing its bytes."
        ));
    }

    // Content-addressed bytes can legitimately be referenced from resources
    // in more than one drive (e.g. the same file uploaded independently into
    // two drives). Accept if ANY referencing resource's drive is admitted —
    // that drive genuinely wants these bytes, regardless of whether some
    // other, unrelated drive also happens to reference the same hash. A
    // single-result `limit` here would make the verdict depend on iteration
    // order instead of on the actual admission question.
    let admitted = resources.iter().any(|referencing| {
        let drive = referencing
            .get(urls::DRIVE_PROP)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| referencing.get_subject().to_string());
        store.sync_policy().admit_drive_write(&drive)
    });

    if !admitted {
        return Err(format!(
            "atomic:blob:{hash_hex} is referenced, but no referencing drive is admitted for writes"
        ));
    }

    Ok(())
}

/// Record who the pushed bytes of `hash_hex` prove possession for, among the
/// resources that reference them in drives that admit writes.
///
/// A signed push proves it for the signer: every such drive in which the
/// signer may write the referencing resource is claimed. An anonymous push
/// (a client that does not sign it) cannot say who holds the bytes, so it is
/// only accepted as proof when exactly one drive is waiting for them; when
/// several drives reference the hash, none is claimed and each must push
/// signed. Claiming for every referrer would let anyone who creates a File
/// for a known hash piggyback on the real owner's push.
async fn claim_pushed_blob(
    store: &Db,
    hash_hex: &str,
    agent: &atomic_lib::agents::ForAgent,
) -> AtomicServerResult<()> {
    use atomic_lib::agents::ForAgent;
    let mut drives = std::collections::BTreeSet::new();
    for referrer in store.all_blob_referrers(hash_hex).await? {
        let raw_drive = referrer
            .get(urls::DRIVE_PROP)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| referrer.get_subject().to_string());
        if !store.sync_policy().admit_drive_write(&raw_drive) {
            continue;
        }
        let may = match agent {
            ForAgent::Public => true,
            _ => atomic_lib::hierarchy::check_write(store, &referrer, agent)
                .await
                .is_ok(),
        };
        if may {
            drives.insert(store.claim_drive_of(&referrer));
        }
    }
    if matches!(agent, ForAgent::Public) && drives.len() != 1 {
        return Ok(());
    }
    for drive in drives {
        store.claim_blob(hash_hex, &drive)?;
    }
    Ok(())
}

/// HTTP fallback for pushing blob bytes to the server. Used by clients when
/// the WebSocket BLOB_RESPONSE path isn't available (WS not open, restricted
/// network, etc.). The hash is verified server-side: a body whose BLAKE3
/// digest doesn't match the URL hash is rejected.
///
/// F4 follow-up (planning/unified-sync.md): the hash alone is NOT the
/// capability — an attacker choosing their own bytes can always compute a
/// matching hash for them, so hash-verification alone gates nothing. Bytes
/// are only accepted when a resource *already on this server* references
/// `did:ad:blob:<hash>` via the `BLOB` property, and that resource's drive
/// passes `admit_drive_write` — mirrors the WS `BLOB_RESPONSE` gate
/// (`sync::engine::handle_frame`), just keyed by "a matching commit already
/// landed" instead of "we issued a matching `BLOB_REQUEST`". The client's
/// outbox drain POSTs the commit (creating that reference) before pushing
/// the blob, so ordering works: see `local-outbox.ts`.
#[tracing::instrument(skip(appstate, body))]
pub async fn put_blob(
    path: web::Path<String>,
    appstate: web::Data<AppState>,
    req: actix_web::HttpRequest,
    body: web::Bytes,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    // A blob put carries no signature (admission is the referencing commit),
    // so the peer address stands in for the agent, on the agent-sized budget:
    // one browser draining a folder of images must not trip the anonymous one.
    if let Err(limited) = appstate
        .write_rate_limiter
        .check(&crate::helpers::peer_ip(&req), false)
    {
        return Err(AtomicServerError {
            message: limited.to_string(),
            error_type: AppErrorType::TooManyRequests,
            error_resource: None,
        });
    }
    let hash_hex = path.into_inner();
    if hash_hex.len() != 64 {
        return Err("Hash must be 64 hex chars (BLAKE3)".into());
    }
    let hash_bytes = hex::decode(&hash_hex).map_err(|_| "Hash must be valid hex".to_string())?;

    let computed = blake3::hash(&body);
    if computed.as_bytes() != hash_bytes.as_slice() {
        return Err(format!(
            "Body hash {} does not match URL hash {}",
            computed.to_hex(),
            hash_hex
        )
        .into());
    }

    let store = &appstate.store;

    if let Err(message) = resolve_blob_write_admission(store, &hash_hex).await {
        return Err(AtomicServerError {
            message,
            error_type: AppErrorType::Unauthorized,
            error_resource: None,
        });
    }

    store.put_blob(&hash_bytes, &body).await?;

    // The bytes are proof of possession. Who they prove it for is the signer
    // when the request is signed; see `claim_pushed_blob`.
    let path_and_query = req
        .head()
        .uri
        .path_and_query()
        .map(|p| p.to_string())
        .unwrap_or_default();
    let signed_subject =
        atomic_lib::Subject::from_raw(&path_and_query, None).resolve(&context.origin);
    // A signature that does not verify is as good as none: the push is then
    // anonymous, not refused (admission above is what gates the write).
    let agent =
        crate::helpers::get_client_agent_for_request(&req, &body, &appstate, &signed_subject)
            .await
            .unwrap_or(atomic_lib::agents::ForAgent::Public);
    claim_pushed_blob(store, &hash_hex, &agent)
        .await
        .map_err(|e| e.to_string())?;

    Ok(HttpResponse::NoContent().finish())
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use atomic_lib::sync::policy::AllowlistPolicy;
    use std::sync::Arc;
    use std::time::Duration;

    /// F4 follow-up: a hash with no referencing resource must be rejected —
    /// otherwise the hash alone is the write capability, and an attacker can
    /// always compute a hash for bytes of their own choosing.
    #[tokio::test]
    async fn unreferenced_hash_is_rejected() {
        let db = Db::init_temp("blob_admission_unreferenced").await.unwrap();
        let _ = db.setup("Alice").await.unwrap();

        let hash_hex = blake3::hash(b"nobody committed a reference to this")
            .to_hex()
            .to_string();

        let err = resolve_blob_write_admission(&db, &hash_hex)
            .await
            .expect_err("a hash with no referencing resource must be rejected");
        assert!(
            err.contains("No resource references"),
            "unexpected error message: {err}"
        );
    }

    /// Companion: once a resource legitimately references the hash (the
    /// commit landed first, matching the outbox drain's ordering) and its
    /// drive is admitted, the write is allowed.
    #[tokio::test]
    async fn referenced_hash_on_admitted_drive_is_allowed() {
        let db = Db::init_temp("blob_admission_referenced_admitted")
            .await
            .unwrap();
        let (_alice, drive) = db.setup("Alice").await.unwrap();

        let hash_hex = blake3::hash(b"legitimate upload bytes")
            .to_hex()
            .to_string();
        let subject = db
            .create_resource(
                "https://atomicdata.dev/classes/Folder",
                &drive,
                "a file",
                None,
            )
            .await
            .unwrap();
        let mut resource = db.get_resource(&subject.as_str().into()).await.unwrap();
        resource
            .set_unsafe(
                urls::BLOB.into(),
                atomic_lib::Value::AtomicUrl(format!("did:ad:blob:{hash_hex}").into()),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();

        // Default policy (`OpenPolicy`, installed by `Db::init_temp`) admits
        // every drive — this is the "legit flow unaffected" case.
        resolve_blob_write_admission(&db, &hash_hex)
            .await
            .expect("a referenced hash on an admitted drive must be allowed");
    }

    /// F4 follow-up: a resource DOES reference the hash, but its drive is not
    /// admitted by the installed policy — must still be rejected. Otherwise
    /// gating only on "does a reference exist" would let a write into any
    /// drive the attacker can get a File resource created in (e.g. one they
    /// have write rights on but that a managed node hasn't enrolled/quota'd).
    #[tokio::test]
    async fn referenced_hash_on_unadmitted_drive_is_rejected() {
        let db = Db::init_temp("blob_admission_referenced_unadmitted")
            .await
            .unwrap();
        let (_alice, drive) = db.setup("Alice").await.unwrap();

        let hash_hex = blake3::hash(b"bytes for an unenrolled drive")
            .to_hex()
            .to_string();
        let subject = db
            .create_resource(
                "https://atomicdata.dev/classes/Folder",
                &drive,
                "a file",
                None,
            )
            .await
            .unwrap();
        let mut resource = db.get_resource(&subject.as_str().into()).await.unwrap();
        resource
            .set_unsafe(
                urls::BLOB.into(),
                atomic_lib::Value::AtomicUrl(format!("did:ad:blob:{hash_hex}").into()),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();

        // Empty allowlist, no bootstrap grace: nothing is enrolled, so
        // `drive` is not admitted — matches the managed-node gate test
        // pattern in `commit.rs`.
        let policy = Arc::new(AllowlistPolicy::new());
        policy.set_grace(Duration::ZERO);
        db.set_sync_policy(policy);

        let err = resolve_blob_write_admission(&db, &hash_hex)
            .await
            .expect_err("a referenced hash on an unadmitted drive must be rejected");
        assert!(
            err.contains("no referencing drive is admitted"),
            "unexpected error message: {err}"
        );
    }

    /// F4 follow-up, second-review edge case: content-addressed bytes can
    /// legitimately be referenced from resources in more than one drive. If
    /// ANY referencing drive is admitted, the write must be allowed — the
    /// verdict must not depend on which of the several referencing resources
    /// a `limit`-ed query happens to return first.
    ///
    /// Subjects are hand-picked (not `create_resource`'s random DIDs) so the
    /// unadmitted resource is guaranteed to sort first in the property-value
    /// index (`{property}|{value}|{subject}` keys, subject-ordered among
    /// ties) — a `limit(1)`/first-result-only implementation is deterministically
    /// forced onto the unadmitted resource here, rather than merely likely to
    /// hit it. Confirmed via revert-and-check: with `Db::init_temp`'s random
    /// DIDs this test failed only ~60% of runs against the reverted logic;
    /// with these forced subjects it fails 100% of runs.
    #[tokio::test]
    async fn referenced_hash_admitted_via_any_matching_drive() {
        let db = Db::init_temp("blob_admission_any_pass").await.unwrap();
        let (_alice, admitted_drive) = db.setup("Alice").await.unwrap();
        let (_bob, unadmitted_drive) = db.setup("Bob").await.unwrap();

        let hash_hex = blake3::hash(b"same bytes, referenced from two drives")
            .to_hex()
            .to_string();

        for (subject, drive) in [
            ("/aaa-unadmitted-sorts-first", &unadmitted_drive),
            ("/zzz-admitted-sorts-last", &admitted_drive),
        ] {
            let mut resource = atomic_lib::Resource::new(subject.to_string());
            resource
                .set_unsafe(
                    urls::IS_A.into(),
                    atomic_lib::Value::ResourceArray(vec!["https://atomicdata.dev/classes/Folder"
                        .to_string()
                        .into()]),
                )
                .unwrap();
            resource
                .set_unsafe(
                    urls::NAME.into(),
                    atomic_lib::Value::String("a file".into()),
                )
                .unwrap();
            resource
                .set_unsafe(
                    urls::DRIVE_PROP.into(),
                    atomic_lib::Value::AtomicUrl(drive.clone().into()),
                )
                .unwrap();
            resource
                .set_unsafe(
                    urls::BLOB.into(),
                    atomic_lib::Value::AtomicUrl(format!("did:ad:blob:{hash_hex}").into()),
                )
                .unwrap();
            db.add_resource(&resource).await.unwrap();
        }

        // Only `admitted_drive` is enrolled; `unadmitted_drive` is not.
        let policy = Arc::new(AllowlistPolicy::new());
        policy.set_grace(Duration::ZERO);
        policy.set_drive_policies([(admitted_drive.clone(), None)]);
        db.set_sync_policy(policy);

        resolve_blob_write_admission(&db, &hash_hex).await.expect(
            "a hash referenced from one admitted drive, among several referencing drives, \
             must be allowed",
        );
    }

    /// A File in `drive` that references `hash_hex`, as a client commit leaves it.
    async fn reference(db: &Db, drive: &str, hash_hex: &str) {
        let subject = db
            .create_resource("https://atomicdata.dev/classes/Folder", drive, "f", None)
            .await
            .unwrap();
        let mut resource = db.get_resource(&subject.as_str().into()).await.unwrap();
        resource
            .set_unsafe(
                urls::BLOB.into(),
                atomic_lib::Value::AtomicUrl(
                    atomic_lib::identifiers::blob_subject(hash_hex).into(),
                ),
            )
            .unwrap();
        db.add_resource(&resource).await.unwrap();
    }

    /// Whose proof of possession a pushed blob is (ontola/atomic-server#2157): a
    /// signed push claims the signer's drives only, and an unsigned one is only
    /// believed when exactly one drive is waiting for the bytes, so creating a
    /// File for a hash cannot piggyback on the real owner's push.
    #[tokio::test]
    async fn a_push_proves_possession_for_the_pusher_only() {
        use atomic_lib::agents::ForAgent;
        let db = Db::init_temp("blob_push_claims").await.unwrap();
        let (alice, alice_drive) = db.setup("Alice").await.unwrap();
        let (_mallory, mallory_drive) = db.setup("Mallory").await.unwrap();
        let hash_hex = blake3::hash(b"alice's bytes").to_hex().to_string();
        reference(&db, &alice_drive, &hash_hex).await;
        reference(&db, &mallory_drive, &hash_hex).await;
        let held = |drive: &str| db.drive_holds_blob(&hash_hex, &db.claim_drive_id(drive));

        // Anonymous, two drives waiting: nobody is claimed.
        claim_pushed_blob(&db, &hash_hex, &ForAgent::Public)
            .await
            .unwrap();
        assert!(!held(&alice_drive) && !held(&mallory_drive));

        // Alice signs her push: her drive, and only hers.
        claim_pushed_blob(
            &db,
            &hash_hex,
            &ForAgent::AgentSubject(alice.subject.clone()),
        )
        .await
        .unwrap();
        assert!(held(&alice_drive));
        assert!(!held(&mallory_drive));

        // One drive waiting and an anonymous push: believed.
        let lonely = blake3::hash(b"only one reference").to_hex().to_string();
        reference(&db, &alice_drive, &lonely).await;
        claim_pushed_blob(&db, &lonely, &ForAgent::Public)
            .await
            .unwrap();
        assert!(db.drive_holds_blob(&lonely, &db.claim_drive_id(&alice_drive)));
    }
}
