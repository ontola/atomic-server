//! File bytes have independent storage from transactional graph state.
use super::{trees::Tree, Db};
use crate::errors::AtomicResult;
use crate::{
    agents::ForAgent,
    storelike::{Query, Storelike},
    urls, Resource, Value,
};
use async_trait::async_trait;

#[async_trait]
pub trait BlobBackend: Send + Sync {
    async fn get(&self, key: &[u8]) -> AtomicResult<Option<Vec<u8>>>;
    async fn put(&self, key: &[u8], bytes: &[u8]) -> AtomicResult<()>;
    /// Metadata only: usage accounting must not download every file.
    async fn size(&self, key: &[u8]) -> AtomicResult<Option<u64>>;
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

    pub async fn blob_size(&self, key: &[u8]) -> AtomicResult<Option<u64>> {
        match &self.blob_backend {
            Some(backend) => backend.size(key).await,
            None => Ok(self.kv.get(Tree::Blobs, key)?.map(|b| b.len() as u64)),
        }
    }

    /// The resources that reference the blob `hash_hex` and that `for_agent`
    /// may read: Files whose whole-file `internalId` is the hash, resources
    /// whose `blob` is the hash, and chunked Files listing it in `chunks`.
    /// Empty means the requester has no business with these bytes. More than
    /// one File can share a hash (the same bytes uploaded twice are stored
    /// once), so reading any one of them is enough.
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
                if !found
                    .iter()
                    .any(|r| r.get_subject() == resource.get_subject())
                {
                    found.push(resource);
                }
            }
            if !found.is_empty() {
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
