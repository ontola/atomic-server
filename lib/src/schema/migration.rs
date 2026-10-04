//! Trusted, explicit copy migrations. Sync never executes migration code.
//! Persistence adapters own permissions, local serialization and durable progress.
use super::app::AppSchema;
use crate::{errors::AtomicResult, Resource};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use std::collections::BTreeSet;

#[derive(Clone, Debug)]
pub struct CopyItem {
    pub key: String,
    pub schema: AppSchema,
    pub fields: serde_json::Map<String, Json>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MigrationPreview {
    pub migration: String,
    pub source: String,
    pub revision: String,
    pub target_schema: String,
    pub items: usize,
    pub preserves_original: bool,
}
/// Constructed locally from authoritative, permission-checked snapshots and
/// trusted transformed output. Never deserialized from a peer.
pub struct CopyPlan {
    preview: MigrationPreview,
    items: Vec<CopyItem>,
}
struct PlanDigest {
    hasher: blake3::Hasher,
    remaining: usize,
}
impl std::io::Write for PlanDigest {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(std::io::Error::other("Migration plan exceeds 64 MiB"));
        }
        self.remaining -= bytes.len();
        self.hasher.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl PlanDigest {
    fn record(&mut self, value: &Json) -> AtomicResult<()> {
        // A zero delimiter cannot occur in canonical JSON (NUL is escaped).
        std::io::Write::write_all(self, &[0])?;
        serde_jcs::to_writer(self, value)?;
        Ok(())
    }
}
impl CopyPlan {
    pub fn prepare(
        migration: &str,
        source: &str,
        target_schema: &str,
        snapshots: &[Resource],
        items: Vec<CopyItem>,
    ) -> AtomicResult<Self> {
        if migration.is_empty()
            || migration.len() > 256
            || snapshots.len() > 100_000
            || items.len() > 100_000
        {
            return Err("Invalid migration bounds".into());
        }
        let mut digest = PlanDigest {
            hasher: blake3::Hasher::new(),
            remaining: 64 * 1024 * 1024,
        };
        digest.record(
            &json!({"format":1,"migration":migration,"source":source,"target":target_schema}),
        )?;
        let mut ordered: Vec<_> = snapshots.iter().collect();
        ordered.sort_by(|a, b| a.get_subject().as_str().cmp(b.get_subject().as_str()));
        let mut subjects = BTreeSet::new();
        for resource in ordered {
            if !subjects.insert(resource.get_subject().to_string()) {
                return Err("Duplicate source snapshot".into());
            }
            let version = resource
                .materialized_state()
                .map(|bytes| crate::loro::AtomicLoroDoc::vv_map_from_snapshot(&bytes))
                .transpose()?;
            let mut values = resource.get_propvals().clone();
            values.remove(crate::urls::LORO_UPDATE);
            digest.record(&json!({"input":resource.get_subject().to_string(),"version":version,"values":crate::serialize::propvals_to_json_ad_map(&values,None,"http://localhost",true)?}))?;
        }
        if !subjects.contains(source) {
            return Err("Missing source root snapshot".into());
        }
        let mut keys = BTreeSet::new();
        for item in &items {
            if item.key.is_empty() || item.key.len() > 1024 || !keys.insert(item.key.clone()) {
                return Err("Invalid or duplicate migration item key".into());
            }
            for (key, value) in &item.fields {
                item.schema.encode_field(key, value)?;
            }
            for field in item.schema.fields.keys() {
                if item.schema.binding(field)?.required && !item.fields.contains_key(field) {
                    return Err(format!("Missing required migration field {field}").into());
                }
            }
            digest.record(&json!({"output":item.key,"schema":item.schema.class_id,"bindings":item.schema.fields,"fields":item.fields}))?;
        }
        // Pin both input and trusted transformation output. Changing a transform,
        // target schema or schema binding invalidates an earlier preview.
        let revision = digest.hasher.finalize().to_hex().to_string();
        Ok(Self {
            preview: MigrationPreview {
                migration: migration.into(),
                source: source.into(),
                revision,
                target_schema: target_schema.into(),
                items: items.len(),
                preserves_original: true,
            },
            items,
        })
    }
    pub fn preview(&self) -> &MigrationPreview {
        &self.preview
    }
    pub fn check_revision(&self, expected: &str) -> AtomicResult<()> {
        if expected != self.preview.revision {
            return Err("Migration changed since preview; preview it again".into());
        }
        Ok(())
    }
    /// Rebuild prepare() from current source membership/snapshots before calling.
    /// The adapter serializes local runs and durably records each write before
    /// returning. Original resources remain intact; this is not a distributed CAS.
    pub async fn apply(
        &self,
        expected: &str,
        target: &mut impl CopyTarget,
    ) -> AtomicResult<CopyProgress> {
        self.check_revision(expected)?;
        let mut progress = target.begin(self.preview()).await?;
        if progress.complete {
            return Ok(progress);
        }
        for item in &self.items {
            if progress.completed.contains(&item.key) {
                continue;
            }
            target.write(&progress.subject, item).await?;
            progress.completed.insert(item.key.clone());
        }
        target.finish(&progress.subject).await?;
        progress.complete = true;
        Ok(progress)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CopyProgress {
    pub subject: String,
    pub completed: BTreeSet<String>,
    pub complete: bool,
}
#[allow(async_fn_in_trait)]
pub trait CopyTarget {
    /// Find/create a pending destination by source + revision; return durable
    /// completed item keys. Completed destinations make retries idempotent.
    async fn begin(&mut self, preview: &MigrationPreview) -> AtomicResult<CopyProgress>;
    /// Idempotent durable write by item.key. An error leaves the copy pending.
    async fn write(&mut self, subject: &str, item: &CopyItem) -> AtomicResult<()>;
    /// Mark visible only after every item has been persisted successfully.
    async fn finish(&mut self, subject: &str) -> AtomicResult<()>;
}
