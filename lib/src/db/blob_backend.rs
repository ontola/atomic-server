//! File bytes have independent storage from transactional graph state.
use super::{trees::Tree, Db};
use crate::errors::AtomicResult;
use crate::{
    agents::ForAgent,
    storelike::{Query, Storelike},
    urls, Resource, Value,
};
use async_trait::async_trait;

/// `Tree::PluginMeta` key prefix of a (blob, drive) proof-of-possession claim.
const BLOB_CLAIM_PREFIX: &str = "blob-claim:";
/// `Tree::PluginMeta` marker: the one-time claim backfill has run.
const BLOB_CLAIMS_BACKFILLED: &[u8] = b"blob-claims-backfilled:v1";

/// The hashes a File's bytes are read from: its non-empty `chunks`, otherwise
/// its `internalId` (and `blob`).
fn served_blob_hashes(propvals: &crate::resources::PropVals) -> Vec<String> {
    let chunks = propvals
        .get(urls::CHUNKS)
        .filter(|c| c.to_subjects(None).is_ok_and(|list| !list.is_empty()));
    match chunks {
        Some(chunks) => {
            let mut only = crate::resources::PropVals::new();
            only.insert(urls::CHUNKS.to_string(), chunks.clone());
            super::blob_hashes(&only)
        }
        None => super::blob_hashes(propvals),
    }
}

#[async_trait]
pub trait BlobBackend: Send + Sync {
    async fn get(&self, key: &[u8]) -> AtomicResult<Option<Vec<u8>>>;
    async fn put(&self, key: &[u8], bytes: &[u8]) -> AtomicResult<()>;
    /// Metadata only: usage accounting must not download every file.
    async fn size(&self, key: &[u8]) -> AtomicResult<Option<u64>>;
    /// Remove the object. Deleting a missing key succeeds. Used by purge
    /// (`Db::purge_unreferenced_blobs`) and nowhere else.
    async fn delete(&self, key: &[u8]) -> AtomicResult<()>;
}

impl Db {
    pub async fn get_blob(&self, key: &[u8]) -> AtomicResult<Option<Vec<u8>>> {
        match &self.blob_backend {
            Some(backend) => backend.get(key).await,
            None => self.kv.get(Tree::Blobs, key),
        }
    }

    pub async fn put_blob(&self, key: &[u8], bytes: &[u8]) -> AtomicResult<()> {
        match &self.blob_backend {
            Some(backend) => backend.put(key, bytes).await,
            None => self.kv.insert(Tree::Blobs, key, bytes),
        }
    }

    /// Remove a blob. Only purge calls this: blobs are content-addressed and
    /// otherwise immutable. Callers must have checked that nothing references
    /// the hash (see [`Self::purge_unreferenced_blobs`]).
    pub async fn delete_blob(&self, key: &[u8]) -> AtomicResult<()> {
        match &self.blob_backend {
            Some(backend) => backend.delete(key).await,
            None => self.kv.remove(Tree::Blobs, key),
        }
    }

    pub async fn blob_size(&self, key: &[u8]) -> AtomicResult<Option<u64>> {
        match &self.blob_backend {
            Some(backend) => backend.size(key).await,
            None => Ok(self.kv.get(Tree::Blobs, key)?.map(|b| b.len() as u64)),
        }
    }

    /// The resources that reference the blob `hash_hex`, that `for_agent`
    /// may read, and whose drive has proven it holds the bytes (see
    /// [`Self::claim_blob`]): Files whose whole-file `internalId` is the hash,
    /// resources whose `blob` is the hash, and chunked Files listing it in
    /// `chunks`. Empty means the requester has no business with these bytes.
    /// More than one File can share a hash (the same bytes uploaded twice are
    /// stored once), so reading any one of them is enough.
    ///
    /// `internalId`, `blob` and `chunks` are plain properties any writer can set
    /// to any hash, so a reference alone proves nothing: an attacker who knows
    /// a hash would otherwise create a File of their own that "references" it
    /// and read someone else's private bytes. A referrer only counts when its
    /// drive has a claim for the hash, recorded when bytes were handed to this
    /// node on behalf of that drive. That costs one point read per readable
    /// referrer.
    ///
    /// Every lookup is an index read on (property, value) and the rights check
    /// runs through the query's per-call rights cache (a drive's ancestors are
    /// resolved once, not once per referrer); nothing scans the store. The
    /// first query with a readable hit ends the search, so the common case (an
    /// upload carries `internalId`) is a single index lookup.
    ///
    /// Shared by the HTTP download route and the sync `BLOB_REQUEST` frame:
    /// the hash is not a capability on either transport.
    pub async fn readable_blob_referrers(
        &self,
        hash_hex: &str,
        for_agent: &ForAgent,
    ) -> AtomicResult<Vec<Resource>> {
        self.blob_referrers(hash_hex, for_agent, true, false).await
    }

    /// Every resource referencing the blob, readable and claimed or not. For
    /// callers that decide on their own (purge, deciding whom a pushed blob
    /// proves possession for).
    pub async fn all_blob_referrers(&self, hash_hex: &str) -> AtomicResult<Vec<Resource>> {
        self.blob_referrers(hash_hex, &ForAgent::Sudo, false, true)
            .await
    }

    /// The lookup behind [`Self::readable_blob_referrers`]; with
    /// `ForAgent::Sudo` it lists every referrer, readable or not. With
    /// `require_claim` only referrers whose drive holds a claim count; unless
    /// `exhaustive`, the first lookup with a hit ends the search.
    async fn blob_referrers(
        &self,
        hash_hex: &str,
        for_agent: &ForAgent,
        require_claim: bool,
        exhaustive: bool,
    ) -> AtomicResult<Vec<Resource>> {
        let mut queries = vec![Query::new_prop_val(urls::INTERNAL_ID, hash_hex)];
        // Stored references are canonical (`atomic:blob:`), older ones `did:ad:blob:`.
        for prefix in [crate::identifiers::ATOMIC_BLOB_PREFIX, "did:ad:blob:"] {
            for property in [urls::BLOB, urls::CHUNKS] {
                let mut q = Query::new();
                q.property = Some(property.to_string());
                q.value = Some(Value::AtomicUrl(format!("{prefix}{hash_hex}").into()));
                queries.push(q);
            }
        }

        let mut found: Vec<Resource> = Vec::new();
        for mut q in queries {
            q.for_agent = for_agent.clone();
            for resource in self.query(&q).await?.resources {
                if require_claim
                    && !self.drive_holds_blob(hash_hex, &self.claim_drive_of(&resource))
                {
                    continue;
                }
                if !found
                    .iter()
                    .any(|r| r.get_subject() == resource.get_subject())
                {
                    found.push(resource);
                }
            }
            if !exhaustive && !found.is_empty() {
                break;
            }
        }

        Ok(found)
    }

    /// Whether `for_agent` may be handed the bytes of the blob `hash`: it can
    /// read at least one resource referencing it. `Sudo` (this node itself)
    /// always may.
    pub async fn agent_may_read_blob(&self, hash: &[u8], for_agent: &ForAgent) -> bool {
        if matches!(for_agent, ForAgent::Sudo) {
            return true;
        }
        if hash.len() != 32 {
            return false;
        }
        self.readable_blob_referrers(&hex::encode(hash), for_agent)
            .await
            .is_ok_and(|found| !found.is_empty())
    }

    /// Delete the blobs `candidates` (hex BLAKE3 hashes) that no remaining
    /// resource references, after a purge removed the referrers. Uses the
    /// same referrer lookup as [`Self::readable_blob_referrers`], as `Sudo`
    /// (every referrer counts, readable or not). A blob some other resource
    /// still points at is kept. Returns the hashes that were deleted.
    ///
    /// Not transactional with the graph: a File created for the same bytes
    /// between the lookup and the delete loses its content. Purge is rare and
    /// this window is a few milliseconds.
    pub async fn purge_unreferenced_blobs(
        &self,
        candidates: &[String],
    ) -> AtomicResult<Vec<String>> {
        let mut deleted = Vec::new();
        for hash_hex in candidates {
            let Ok(key) = hex::decode(hash_hex) else {
                continue;
            };
            if key.len() != 32
                || !self
                    .blob_referrers(hash_hex, &ForAgent::Sudo, false, false)
                    .await?
                    .is_empty()
            {
                continue;
            }
            self.delete_blob(&key).await?;
            self.remove_blob_claims(hash_hex)?;
            deleted.push(hash_hex.clone());
        }
        Ok(deleted)
    }

    // ── Proof of possession ─────────────────────────────────────────────────
    //
    // A claim `(hash, drive)` says: bytes with this hash were handed to this
    // node on behalf of that drive (an authenticated upload into it, a signed
    // `PUT /blob` for a File in it, or a sync pull for it). Only the drive's
    // own Files may then expose those bytes. Claims live in `Tree::PluginMeta`
    // under `blob-claim:<hash>:<drive>` and are never part of any resource, so
    // they cannot leak over the API or be written by a commit.

    /// The claim-store key for a hash held on behalf of a drive.
    fn blob_claim_key(hash_hex: &str, drive_id: &str) -> Vec<u8> {
        format!(
            "{BLOB_CLAIM_PREFIX}{}:{drive_id}",
            hash_hex.to_ascii_lowercase()
        )
        .into_bytes()
    }

    /// Normalise a drive reference the way claims are keyed.
    pub fn claim_drive_id(&self, drive: &str) -> String {
        let canonical = crate::identifiers::canonicalize_scheme(drive);
        crate::Subject::from_raw(&canonical, self.get_base_domain().as_deref()).pure_id()
    }

    /// The drive a resource's bytes are attributed to: its `drive` stamp, else
    /// the top of its `parent` chain (the drive has no parent), as rights
    /// checks do. The stamp is derived from `parent` when a commit is applied,
    /// so a writer cannot aim a File at another drive. Reads stored rows only
    /// (no Loro decode); a resource without a stamp costs one read per
    /// ancestor.
    pub fn claim_drive_of(&self, resource: &Resource) -> String {
        self.claim_drive_from_propvals(resource.get_propvals(), &resource.get_subject().pure_id())
    }

    fn claim_drive_from_propvals(
        &self,
        propvals: &crate::resources::PropVals,
        own_key: &str,
    ) -> String {
        let mut root = own_key.to_string();
        let mut owned: Option<crate::resources::PropVals> = None;
        for _ in 0..64 {
            let current = owned.as_ref().unwrap_or(propvals);
            if let Some(drive) = current.get(urls::DRIVE_PROP) {
                return self.claim_drive_id(&drive.to_string());
            }
            let Some(parent) = current.get(urls::PARENT).map(|p| p.to_string()) else {
                break;
            };
            root = self.claim_drive_id(&parent);
            match self.get_propvals(&root) {
                Ok(parent_propvals) => owned = Some(parent_propvals),
                Err(_) => break,
            }
        }
        self.claim_drive_id(&root)
    }

    /// Record that `drive` proved it holds the blob `hash_hex`. Idempotent.
    pub fn claim_blob(&self, hash_hex: &str, drive: &str) -> AtomicResult<()> {
        let key = Self::blob_claim_key(hash_hex, &self.claim_drive_id(drive));
        self.kv.insert(Tree::PluginMeta, &key, &[])
    }

    /// Whether `drive_id` (already normalised) holds a claim on the blob. One
    /// point read.
    pub fn drive_holds_blob(&self, hash_hex: &str, drive_id: &str) -> bool {
        self.kv
            .contains_key(Tree::PluginMeta, &Self::blob_claim_key(hash_hex, drive_id))
            .unwrap_or(false)
    }

    /// Claim every blob `resource` references for its drive. For a node that
    /// stores the bytes itself on behalf of its own user (the desktop file
    /// system view): the owner writing both the bytes and the File is the
    /// proof, there is no upload to hang it on.
    pub fn claim_blobs_of(&self, resource: &Resource) -> AtomicResult<()> {
        let drive = self.claim_drive_of(resource);
        for hash in super::blob_hashes(resource.get_propvals()) {
            self.kv
                .insert(Tree::PluginMeta, &Self::blob_claim_key(&hash, &drive), &[])?;
        }
        Ok(())
    }

    /// Drop every claim on a blob whose bytes are gone.
    fn remove_blob_claims(&self, hash_hex: &str) -> AtomicResult<()> {
        let prefix = format!("{BLOB_CLAIM_PREFIX}{}:", hash_hex.to_ascii_lowercase());
        let keys: Vec<Vec<u8>> = self
            .kv
            .scan_prefix(Tree::PluginMeta, prefix.as_bytes())
            .filter_map(|item| item.ok().map(|(k, _)| k))
            .collect();
        for key in keys {
            self.kv.remove(Tree::PluginMeta, &key)?;
        }
        Ok(())
    }

    /// Whether the bytes behind this File may be served from the File itself:
    /// the hashes it would read (its `chunks`, else its `internalId`) are all
    /// claimed by its drive. Guards the by-subject download route, which would
    /// otherwise hand a File with a copied `internalId` someone else's bytes.
    pub fn resource_holds_its_blobs(&self, resource: &Resource) -> bool {
        let drive = self.claim_drive_of(resource);
        let hashes = served_blob_hashes(resource.get_propvals());
        !hashes.is_empty() && hashes.iter().all(|h| self.drive_holds_blob(h, &drive))
    }

    /// One-time backfill for stores that predate claims: every stored resource
    /// that references a blob claims it for its drive, so installations do not
    /// lose access to their existing files. Whatever was stored before this
    /// ran is trusted as it was (a File already pointing at a hash has to be
    /// treated as legitimate); from here on only proof adds claims. Runs once,
    /// marked in `Tree::PluginMeta`.
    pub fn backfill_blob_claims(&self) -> AtomicResult<usize> {
        if self
            .kv
            .contains_key(Tree::PluginMeta, BLOB_CLAIMS_BACKFILLED)?
        {
            return Ok(0);
        }
        let mut claimed = 0;
        for item in self.kv.iter_tree(Tree::Resources) {
            let (key, value) = item?;
            let Ok(propvals) = super::decode_propvals(&value) else {
                continue;
            };
            let hashes = super::blob_hashes(&propvals);
            if hashes.is_empty() {
                continue;
            }
            let drive = self.claim_drive_from_propvals(&propvals, &String::from_utf8_lossy(&key));
            for hash in hashes {
                self.kv
                    .insert(Tree::PluginMeta, &Self::blob_claim_key(&hash, &drive), &[])?;
                claimed += 1;
            }
        }
        self.kv
            .insert(Tree::PluginMeta, BLOB_CLAIMS_BACKFILLED, &[1])?;
        self.kv.flush()?;
        Ok(claimed)
    }

    pub async fn has_blob(&self, key: &[u8]) -> AtomicResult<bool> {
        Ok(self.blob_size(key).await?.is_some())
    }

    /// Run before starting transports. Copy and verify each existing local blob
    /// before removing it. A failed/interrupted migration is safe to retry.
    /// Never fall back to local storage after selecting a remote backend.
    pub async fn migrate_blobs_to_backend(&self) -> AtomicResult<usize> {
        let Some(backend) = &self.blob_backend else {
            return Ok(0);
        };
        let mut migrated = 0;
        while let Some((key, bytes)) = self.kv.first_entry(Tree::Blobs)? {
            backend.put(&key, &bytes).await?;
            let stored = backend
                .get(&key)
                .await?
                .ok_or("Blob migration verification: object missing")?;
            if stored != bytes {
                return Err("Blob migration verification: contents differ".into());
            }
            self.kv.remove(Tree::Blobs, &key)?;
            self.kv.flush()?;
            migrated += 1;
        }
        Ok(migrated)
    }
}
