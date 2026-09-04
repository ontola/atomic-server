//! [`AtomicNode`]: a thin, named surface over [`Db`].
//!
//! Every method here delegates to a function that already existed before the
//! runtime module did (the doc comment on each one names it). The point of
//! this slice is not new behaviour but one place for adapters to bind, so
//! that `wasm/src/lib.rs`, `flutter/rust/src/api/simple.rs`, `ffi/`,
//! `python/` and the Actix handlers stop each re-wrapping `Db` with their own
//! copy of the commit-validation knobs.

use tokio::sync::broadcast;

use crate::{
    agents::{Agent, ForAgent},
    commit::CommitResponse,
    db::{Db, DbEvent},
    errors::AtomicResult,
    storelike::{Query, QueryResult, ResourceResponse},
    sync::engine::{ingest_commit, CommitIngestOpts},
    Resource, Storelike, Subject,
};

/// Where a node keeps its data. Each variant maps to exactly one existing
/// `Db` constructor.
#[derive(Debug, Clone)]
pub enum NodeStorage {
    /// `Db::init_memory` — BTreeMap store, no persistence. Tests and small
    /// embedded runtimes.
    Memory,
    /// `Db::init_redb` — redb with an in-memory backend. What the WASM
    /// `ClientDb.newInMemory` uses.
    #[cfg(feature = "db-redb")]
    RedbMemory,
    /// `Db::init_redb_file` — redb on disk. Native servers and apps.
    #[cfg(all(feature = "db-redb", not(target_arch = "wasm32")))]
    RedbFile {
        path: std::path::PathBuf,
        uploads_path: std::path::PathBuf,
    },
    /// `Db::init_redb_opfs` — redb in the browser's OPFS, optionally
    /// encrypted at rest. What the WASM `ClientDb` constructor uses.
    #[cfg(all(feature = "db-redb", target_arch = "wasm32"))]
    Opfs {
        filename: String,
        encryption_key: Option<[u8; 32]>,
    },
}

/// How to open an [`AtomicNode`].
#[derive(Debug, Clone)]
pub struct NodeConfig {
    pub storage: NodeStorage,
    /// The node's own origin (`https://example.com`). `None` for a pure
    /// client cache that owns no subjects.
    pub base_domain: Option<String>,
    /// The local agent that signs [`AtomicNode::mutate`] commits. Set as the
    /// store's default agent; `None` leaves the node read-only for local
    /// edits until one is set via [`AtomicNode::set_agent`].
    pub agent: Option<Agent>,
}

impl NodeConfig {
    /// In-memory node with no owned domain and no agent.
    pub fn memory() -> Self {
        Self {
            storage: NodeStorage::Memory,
            base_domain: None,
            agent: None,
        }
    }

    pub fn with_base_domain(mut self, base_domain: impl Into<String>) -> Self {
        self.base_domain = Some(base_domain.into());
        self
    }

    pub fn with_agent(mut self, agent: Agent) -> Self {
        self.agent = Some(agent);
        self
    }
}

/// The trust role under which a signed commit is ingested. Names follow
/// `CommitIngestOpts::{hub, peer, replica}` (PR #1274); `LocalCache` is the
/// "fourth policy" that PR left out — the browser's WASM cache applying a
/// commit the server already accepted.
///
/// | policy | signature | rights | timestamp | ownership | loro causality | live echo |
/// | --- | --- | --- | --- | --- | --- | --- |
/// | `Hub` | yes | yes | yes | yes | yes | fan out |
/// | `Peer` | yes | yes | yes | no | no | suppressed |
/// | `LocalCache` | no | no | no | no | no | fan out |
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum IngestPolicy {
    /// This node owns the subject and is the authority: HTTP `/commit` and
    /// hub WS `COMMIT`. `source_id` is the connection the commit came from,
    /// so the commit monitor does not echo it back; `response_origin`
    /// resolves `internal:/` subjects in the response.
    Hub {
        source_id: Option<String>,
        response_origin: Option<String>,
    },
    /// A signed commit from another full node (Iroh / peer `COMMIT` frame).
    /// Fully validated, but this node may host subjects it does not own and
    /// concurrent writes are expected.
    #[default]
    Peer,
    /// A trusted local cache (browser WASM/OPFS) mirroring what its hub
    /// already accepted. Nothing is validated; only the index is updated.
    LocalCache,
}

impl IngestPolicy {
    /// Hub policy with no source id and the store's own base domain as origin.
    pub fn hub() -> Self {
        Self::Hub {
            source_id: None,
            response_origin: None,
        }
    }
}

/// A local edit for [`AtomicNode::mutate`]. Both arms sign with the node's
/// agent and apply locally, without validating the signature or rights
/// again (the node trusts its own agent) and without any network I/O.
pub enum ResourceEdit<'a> {
    /// Sign and apply the pending changes on an existing resource
    /// (`Resource::save_locally`).
    Update(&'a mut Resource),
    /// Mint a new DID resource from this draft; its subject becomes
    /// `did:ad:{signature}` (`Resource::save_as_genesis`).
    Genesis(&'a mut Resource),
}

/// A running Atomic node: durable store plus the local agent that signs for
/// it. Cheap to clone (`Db` is a bundle of `Arc`s); clones share the store,
/// its event channel and its default agent.
#[derive(Clone)]
pub struct AtomicNode {
    db: Db,
}

impl AtomicNode {
    /// Open a node. Delegates to `Db::init_memory` / `init_redb` /
    /// `init_redb_file` / `init_redb_opfs` depending on
    /// [`NodeConfig::storage`], then installs the agent as the store's
    /// default agent.
    pub async fn open(config: NodeConfig) -> AtomicResult<Self> {
        let NodeConfig {
            storage,
            base_domain,
            agent,
        } = config;
        let db = match storage {
            NodeStorage::Memory => Db::init_memory(base_domain).await?,
            #[cfg(feature = "db-redb")]
            NodeStorage::RedbMemory => Db::init_redb(base_domain).await?,
            #[cfg(all(feature = "db-redb", not(target_arch = "wasm32")))]
            NodeStorage::RedbFile { path, uploads_path } => {
                Db::init_redb_file(&path, base_domain, &uploads_path).await?
            }
            #[cfg(all(feature = "db-redb", target_arch = "wasm32"))]
            NodeStorage::Opfs {
                filename,
                encryption_key,
            } => Db::init_redb_opfs(base_domain, &filename, encryption_key.as_ref()).await?,
        };
        let node = Self::from_db(db);
        if let Some(agent) = agent {
            node.set_agent(agent);
        }
        Ok(node)
    }

    /// Wrap an already-opened store. For adapters that still construct `Db`
    /// themselves (the WASM `ClientDb`, the server's `AppState`) while they
    /// migrate to [`AtomicNode::open`].
    pub fn from_db(db: Db) -> Self {
        Self { db }
    }

    /// The underlying store, for operations this slice does not name yet
    /// (blobs, version vectors, import/export, drive setup).
    pub fn db(&self) -> &Db {
        &self.db
    }

    /// The agent that signs local edits (`Storelike::get_default_agent`).
    pub fn agent(&self) -> Option<Agent> {
        self.db.get_default_agent().ok()
    }

    /// Install (or replace) the agent that signs local edits
    /// (`Storelike::set_default_agent`).
    pub fn set_agent(&self, agent: Agent) {
        self.db.set_default_agent(agent);
    }

    /// Read a resource as `for_agent` would see it, including dynamic
    /// (endpoint / class-extender) properties and the read-rights check
    /// (`Storelike::get_resource_extended` with `skip_dynamic = false`).
    pub async fn get(
        &self,
        subject: &Subject,
        for_agent: &ForAgent,
    ) -> AtomicResult<ResourceResponse> {
        self.db
            .get_resource_extended(subject, false, for_agent)
            .await
    }

    /// Run an indexed query (`Storelike::query`). Rights are checked per hit
    /// via `Query::for_agent`.
    pub async fn query(&self, q: &Query) -> AtomicResult<QueryResult> {
        self.db.query(q).await
    }

    /// Ingest a signed JSON-AD commit under `policy`.
    ///
    /// - `Hub` / `Peer`: `sync::engine::ingest_commit` with the matching
    ///   `CommitIngestOpts` — the path `server/src/handlers/commit.rs` and
    ///   the peer `COMMIT` frame handler already use.
    /// - `LocalCache`: `Db::apply_commit` with every `validate_*` off — the
    ///   options the WASM `ClientDb.applyCommit` used to carry inline.
    pub async fn apply_commit(
        &self,
        commit_json: &str,
        policy: IngestPolicy,
    ) -> AtomicResult<CommitResponse> {
        match policy {
            IngestPolicy::Hub {
                source_id,
                response_origin,
            } => {
                ingest_commit(
                    &self.db,
                    commit_json,
                    &CommitIngestOpts::hub(source_id, response_origin),
                )
                .await
            }
            IngestPolicy::Peer => {
                ingest_commit(&self.db, commit_json, &CommitIngestOpts::peer()).await
            }
            IngestPolicy::LocalCache => {
                // `DontSave`: the default would persist the parsed Commit
                // resource (validating required props) before `apply_commit`
                // runs; `apply_commit` is the persistence step here.
                let commit_resource = crate::parse::parse_json_ad_resource(
                    commit_json,
                    &self.db,
                    &crate::parse::ParseOpts {
                        save: crate::parse::SaveOpts::DontSave,
                        ..Default::default()
                    },
                )
                .await?;
                let commit = crate::Commit::from_resource(commit_resource)?;
                let opts = crate::commit::CommitOpts {
                    update_index: true,
                    ..crate::commit::CommitOpts::no_validations_no_index()
                };
                self.db.apply_commit(commit, &opts).await
            }
        }
    }

    /// Sign a local edit with the node's agent and apply it to this store
    /// (`Resource::save_locally` / `Resource::save_as_genesis`). Nothing is
    /// sent anywhere: hand `CommitResponse::commit` to a transport (or to
    /// another node's [`apply_commit`](Self::apply_commit)) to propagate it.
    ///
    /// Fails with the store's "No agent set" error when the node has no agent.
    pub async fn mutate(&self, edit: ResourceEdit<'_>) -> AtomicResult<CommitResponse> {
        match edit {
            ResourceEdit::Update(resource) => resource.save_locally(&self.db).await,
            ResourceEdit::Genesis(resource) => resource.save_as_genesis(&self.db).await,
        }
    }

    /// Change notifications for every write to this store, whatever path it
    /// came in on (`Db::subscribe_events`). Lagging receivers drop the
    /// oldest events, as with any `tokio::sync::broadcast` channel.
    pub fn subscribe(&self) -> broadcast::Receiver<DbEvent> {
        self.db.subscribe_events()
    }

    /// Bulk-sync `drive` with an Iroh peer
    /// (`sync::peer::sync_drive_with_peer_outcome`). Requires the global Iroh
    /// endpoint to be running (`sync::peer::start`); that lifecycle is not
    /// owned by the node yet.
    #[cfg(feature = "iroh")]
    pub async fn sync_with_peer(
        &self,
        node_id: &str,
        drive: &Subject,
    ) -> AtomicResult<crate::sync::peer::PeerSyncOutcome> {
        crate::sync::peer::sync_drive_with_peer_outcome(node_id, drive.as_str(), &self.db).await
    }
}

#[cfg(all(test, feature = "db-redb"))]
mod tests {
    use super::*;
    use crate::{client::commit_to_wire_json, urls, Value};

    async fn open_test_node(label: &str) -> AtomicNode {
        let node = AtomicNode::open(NodeConfig {
            storage: NodeStorage::RedbMemory,
            ..NodeConfig::memory().with_base_domain("https://localhost")
        })
        .await
        .unwrap_or_else(|e| panic!("{label}: open failed: {e}"));
        node.db().populate().await.unwrap();
        node
    }

    /// Two nodes in one process, no Actix: a genesis commit minted on one via
    /// `mutate` is ingested on the other via `apply_commit(Peer)`, after which
    /// `query` and `get` on the second node reflect it and `subscribe` on the
    /// second node saw exactly one change.
    #[tokio::test]
    async fn two_nodes_mutate_then_peer_ingest() {
        let alice_node = open_test_node("alice").await;
        let (alice, drive) = alice_node.db().setup("Alice").await.unwrap();
        let drive = Subject::from(drive);
        assert_eq!(
            alice_node.agent().map(|a| a.subject),
            Some(alice.subject.clone())
        );

        let bob_node = open_test_node("bob").await;
        bob_node.db().setup("Bob").await.unwrap();
        let mut bob_events = bob_node.subscribe();

        // Alice mints a classless DID document under her drive.
        let mut draft = Resource::new("did:ad:placeholder".into());
        draft
            .set_unsafe(urls::NAME.into(), Value::String("Peer Doc".into()))
            .unwrap();
        draft
            .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.clone()))
            .unwrap();
        let response = alice_node
            .mutate(ResourceEdit::Genesis(&mut draft))
            .await
            .unwrap();
        let subject = response.commit.subject.clone();
        assert!(subject.as_str().starts_with("did:ad:"), "got {subject}");
        assert!(
            bob_node.db().get_resource(&subject).await.is_err(),
            "bob must not see alice's write before ingesting it"
        );

        // The commit crosses the (in-process) wire as JSON-AD.
        let wire = commit_to_wire_json(&response.commit, alice_node.db())
            .await
            .unwrap();
        let ingested = bob_node
            .apply_commit(&wire, IngestPolicy::Peer)
            .await
            .expect("bob must accept alice's signed genesis commit under Peer policy");
        assert_eq!(ingested.commit.signer, alice.subject);

        // `get` sees it (as sudo: bob has no rights on alice's doc).
        let got = bob_node
            .get(&subject, &ForAgent::Sudo)
            .await
            .unwrap()
            .to_single();
        assert_eq!(got.get(urls::NAME).unwrap().to_string(), "Peer Doc");

        // `query` sees it.
        let result = bob_node
            .query(&Query {
                property: Some(urls::PARENT.into()),
                value: Some(Value::AtomicUrl(drive.clone())),
                for_agent: ForAgent::Sudo,
                ..Query::new()
            })
            .await
            .unwrap();
        assert_eq!(result.subjects, vec![subject.clone()]);

        // `subscribe` saw the ingest: the ingest stores the commit resource
        // and the document, each emitting a `Changed` event.
        let mut changed = Vec::new();
        while let Ok(event) = bob_events.try_recv() {
            if let DbEvent::Changed { subject, .. } = event {
                changed.push(subject.pure_id());
            }
        }
        assert!(
            changed.contains(&subject.pure_id()),
            "expected a Changed event for {subject}, got {changed:?}"
        );
    }

    /// `LocalCache` is today's WASM `applyCommit`: it applies an unsigned,
    /// unauthorized commit without complaint, because the cache trusts its
    /// hub. `Peer` must reject the very same bytes.
    #[tokio::test]
    async fn local_cache_skips_validation_peer_does_not() {
        let hub = open_test_node("hub").await;
        let (_alice, drive) = hub.db().setup("Alice").await.unwrap();
        let drive = Subject::from(drive);
        let mut draft = Resource::new("did:ad:placeholder".into());
        draft
            .set_unsafe(urls::NAME.into(), Value::String("Cached".into()))
            .unwrap();
        draft
            .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive))
            .unwrap();
        let response = hub.mutate(ResourceEdit::Genesis(&mut draft)).await.unwrap();
        // What the hub pushes to its caches over WS: the stored commit
        // resource, `@id` included (`ingest_commit_json`'s return value).
        let mut wire: serde_json::Value =
            serde_json::from_str(&response.commit_resource.to_json_ad(None).unwrap()).unwrap();
        // Corrupt the signature: a peer must notice, a local cache does not check.
        wire[urls::SIGNATURE] = serde_json::Value::String("AAAA".into());
        let tampered = wire.to_string();

        let cache = open_test_node("cache").await;
        cache
            .apply_commit(&tampered, IngestPolicy::LocalCache)
            .await
            .expect("LocalCache applies without validating the signature");
        cache
            .get(&response.commit.subject, &ForAgent::Sudo)
            .await
            .expect("cached resource is readable");

        let peer = open_test_node("peer").await;
        peer.apply_commit(&tampered, IngestPolicy::Peer)
            .await
            .expect_err("Peer validates the signature and must reject the tampered commit");
    }

    /// Without an agent, `mutate` fails with the store's own error instead
    /// of panicking or silently signing with nothing.
    #[tokio::test]
    async fn mutate_without_agent_is_an_error() {
        let node = AtomicNode::open(NodeConfig::memory()).await.unwrap();
        assert!(node.agent().is_none());
        let mut draft = Resource::new("did:ad:placeholder".into());
        let err = node
            .mutate(ResourceEdit::Genesis(&mut draft))
            .await
            .expect_err("no agent, no signature");
        assert!(err.to_string().contains("No agent set"), "got: {err}");
    }
}
