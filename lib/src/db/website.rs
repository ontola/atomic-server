//! Blob-backed immutable manifests/files with lightweight activation state in KV.
//! Single-process mutations are serialized; redb exclusively owns the database file.
//! SaaS can reuse WebsitePackage with object storage and a transactional control-plane DB.
use super::trees::{Method, Operation, Tree};
use crate::{
    errors::AtomicResult,
    website::{project_id, WebsiteManifest, WebsitePackage},
    Db,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteState {
    pub project: String,
    pub drive: String,
    pub revision: u64,
    pub active: Option<String>,
    pub deployments: Vec<String>,
    pub history: Vec<Activation>,
    #[serde(default)]
    pub versions: std::collections::BTreeMap<String, i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub deployment: Option<String>,
    pub actor: String,
    pub at: i64,
}
fn key(id: &str, suffix: &str) -> Vec<u8> {
    format!("website/v1/{id}/{suffix}").into_bytes()
}
fn insert(key: Vec<u8>, val: Vec<u8>) -> Operation {
    Operation {
        tree: Tree::PluginMeta,
        method: Method::Insert,
        key,
        val: Some(val),
    }
}
impl Db {
    pub async fn website_put_asset(
        &self,
        project: &str,
        hash: &str,
        bytes: &[u8],
    ) -> AtomicResult<()> {
        if bytes.len() > 2_000_000 || blake3::hash(bytes).to_hex().as_str() != hash {
            return Err("Invalid image hash or image exceeds the 2 MB derivative limit".into());
        }
        let key_bytes = hex::decode(hash).map_err(|e| e.to_string())?;
        self.put_blob(&key_bytes, bytes).await?;
        self.kv.apply_batch(&[insert(
            key(&project_id(project), &format!("assets/{hash}")),
            vec![1],
        )])?;
        self.kv.flush()?;
        Ok(())
    }
    pub async fn website_asset(&self, id: &str, hash: &str) -> AtomicResult<Option<Vec<u8>>> {
        if self
            .kv
            .get(Tree::PluginMeta, &key(id, &format!("assets/{hash}")))?
            .is_none()
        {
            return Ok(None);
        }
        self.get_blob(&hex::decode(hash).map_err(|e| e.to_string())?)
            .await
    }
    pub async fn website_public_asset(
        &self,
        id: &str,
        deployment: Option<&str>,
        path: &str,
    ) -> AtomicResult<Option<(String, Vec<u8>)>> {
        if !crate::website::valid_asset(path) {
            return Ok(None);
        }
        let Some(state) = self.website_state(id)? else {
            return Ok(None);
        };
        let Some(active) = state.active else {
            return Ok(None);
        };
        let version = deployment.unwrap_or(&active);
        if version != active
            && !state
                .history
                .iter()
                .any(|h| h.deployment.as_deref() == Some(version))
        {
            return Ok(None);
        }
        let assets = if self
            .kv
            .get(Tree::PluginMeta, &key(id, &format!("manifests/{version}")))?
            .is_some()
        {
            self.website_manifest(id, version).await?.assets
        } else {
            self.website_package(id, version).await?.assets
        };
        let Some(hash) = assets.get(path) else {
            return Ok(None);
        };
        Ok(self
            .website_asset(id, hash)
            .await?
            .map(|bytes| (version.to_owned(), bytes)))
    }
    pub fn website_state(&self, id: &str) -> AtomicResult<Option<WebsiteState>> {
        self.kv
            .get(Tree::PluginMeta, &key(id, "state"))?
            .map(|v| serde_json::from_slice(&v).map_err(Into::into))
            .transpose()
    }
    pub async fn website_upload(
        &self,
        project: &str,
        drive: &str,
        package: &WebsitePackage,
    ) -> AtomicResult<WebsiteState> {
        let deployment = package.id()?;
        for hash in package.assets.values() {
            if self
                .kv
                .get(
                    Tree::PluginMeta,
                    &key(&project_id(project), &format!("assets/{hash}")),
                )?
                .is_none()
            {
                return Err("Upload this project's image blobs before its deployment".into());
            }
        }
        // Complete immutable writes before committing membership and the revision.
        // Failed writes leave the active pointer and history unchanged.
        let manifest = serde_json::to_vec(&package.manifest())?;
        for content in package.files.values() {
            let hash = blake3::hash(content.as_bytes());
            self.put_blob(hash.as_bytes(), content.as_bytes()).await?;
        }
        self.put_blob(blake3::hash(&manifest).as_bytes(), &manifest)
            .await?;
        let id = project_id(project);
        let _lock = WRITES
            .lock()
            .map_err(|_| "Website publication lock failed")?;
        let mut state = self.website_state(&id)?.unwrap_or_else(|| WebsiteState {
            project: project.into(),
            drive: drive.into(),
            ..Default::default()
        });
        if state.project != project || state.drive != drive {
            return Err("Website ownership binding differs".into());
        }
        if state.deployments.contains(&deployment) {
            return Ok(state);
        }
        if state.deployments.len() >= 20 {
            return Err("Pilot limit: 20 deployments per website".into());
        }
        let mut ops = Vec::new();
        ops.push(insert(
            key(&id, &format!("manifests/{deployment}")),
            vec![1],
        ));
        state
            .versions
            .insert(deployment.clone(), crate::utils::now());
        state.deployments.push(deployment);
        state.revision += 1;
        ops.push(insert(key(&id, "state"), serde_json::to_vec(&state)?));
        self.kv.apply_batch(&ops)?;
        self.kv.flush()?;
        Ok(state)
    }
    pub fn website_activate(
        &self,
        id: &str,
        expected_revision: u64,
        deployment: Option<String>,
        actor: &str,
    ) -> AtomicResult<Option<WebsiteState>> {
        let _lock = WRITES
            .lock()
            .map_err(|_| "Website publication lock failed")?;
        let mut state = self
            .website_state(id)?
            .ok_or("Website has no uploaded deployment")?;
        if state.revision != expected_revision {
            return Ok(None);
        }
        if deployment
            .as_ref()
            .is_some_and(|d| !state.deployments.contains(d))
        {
            return Err("Deployment does not belong to this website".into());
        }
        state.active = deployment.clone();
        state.history.push(Activation {
            deployment,
            actor: actor.into(),
            at: crate::utils::now(),
        });
        if state.history.len() > 100 {
            state.history.remove(0);
        }
        state.revision += 1;
        self.kv.insert(
            Tree::PluginMeta,
            &key(id, "state"),
            &serde_json::to_vec(&state)?,
        )?;
        self.kv.flush()?;
        Ok(Some(state))
    }
    pub async fn website_package(
        &self,
        id: &str,
        deployment: &str,
    ) -> AtomicResult<WebsitePackage> {
        if self
            .kv
            .get(
                Tree::PluginMeta,
                &key(id, &format!("manifests/{deployment}")),
            )?
            .is_some()
        {
            let manifest = self.website_manifest(id, deployment).await?;
            let mut files = std::collections::BTreeMap::new();
            for (path, hash) in manifest.files {
                files.insert(
                    path,
                    String::from_utf8(self.website_verified_blob(&hash).await?)
                        .map_err(|e| e.to_string())?,
                );
            }
            return Ok(WebsitePackage {
                version: 1,
                files,
                assets: manifest.assets,
                metadata: manifest.metadata,
            });
        }
        let bytes = self
            .kv
            .get(
                Tree::PluginMeta,
                &key(id, &format!("packages/{deployment}")),
            )?
            .ok_or("Website deployment is missing")?;
        let package: WebsitePackage = serde_json::from_slice(&bytes)?;
        if blake3::hash(&serde_json::to_vec(&package)?)
            .to_hex()
            .as_str()
            != deployment
        {
            return Err("Website package integrity check failed".into());
        }
        Ok(package)
    }
    async fn website_verified_blob(&self, hash: &str) -> AtomicResult<Vec<u8>> {
        let bytes = self
            .get_blob(&hex::decode(hash).map_err(|e| e.to_string())?)
            .await?
            .ok_or("Website blob is missing")?;
        if blake3::hash(&bytes).to_hex().as_str() != hash {
            return Err("Website blob integrity check failed".into());
        }
        Ok(bytes)
    }
    async fn website_manifest(&self, id: &str, deployment: &str) -> AtomicResult<WebsiteManifest> {
        if self
            .kv
            .get(
                Tree::PluginMeta,
                &key(id, &format!("manifests/{deployment}")),
            )?
            .is_none()
        {
            return Err("Website deployment does not belong to project".into());
        }
        Ok(serde_json::from_slice(
            &self.website_verified_blob(deployment).await?,
        )?)
    }
    async fn website_file(
        &self,
        id: &str,
        deployment: &str,
        path: &str,
    ) -> AtomicResult<Option<(String, Vec<u8>)>> {
        if self
            .kv
            .get(
                Tree::PluginMeta,
                &key(id, &format!("manifests/{deployment}")),
            )?
            .is_some()
        {
            let manifest = self.website_manifest(id, deployment).await?;
            return match manifest.files.get(path) {
                Some(hash) => Ok(Some((
                    deployment.into(),
                    self.website_verified_blob(hash).await?,
                ))),
                None => Ok(None),
            };
        }
        Ok(self
            .kv
            .get(
                Tree::PluginMeta,
                &key(id, &format!("files/{deployment}/{path}")),
            )?
            .map(|bytes| (deployment.into(), bytes)))
    }
    /// Versioned assets keep a page on one release during concurrent activation.
    /// Merely uploading an ID never makes that version public; unpublish hides all versions.
    pub async fn website_public_version_file(
        &self,
        id: &str,
        deployment: &str,
        path: &str,
    ) -> AtomicResult<Option<(String, Vec<u8>)>> {
        if !crate::website::valid_path(path) {
            return Ok(None);
        }
        let Some(state) = self.website_state(id)? else {
            return Ok(None);
        };
        if state.active.is_none()
            || (state.active.as_deref() != Some(deployment)
                && !state
                    .history
                    .iter()
                    .any(|h| h.deployment.as_deref() == Some(deployment)))
        {
            return Ok(None);
        }
        self.website_file(id, deployment, path).await
    }
    /// Only an active project can expose files. Private uploaded releases have no public path.
    pub async fn website_public_file(
        &self,
        id: &str,
        path: &str,
    ) -> AtomicResult<Option<(String, Vec<u8>)>> {
        if !crate::website::valid_path(path) {
            return Ok(None);
        }
        let Some(active) = self.website_state(id)?.and_then(|s| s.active) else {
            return Ok(None);
        };
        self.website_file(id, &active, path).await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn manifests_are_blobs_and_legacy_packages_remain_readable() {
        let db = Db::init_temp("website_manifest").await.unwrap();
        let package = WebsitePackage {
            version: 1,
            files: [("index.html".into(), "Hello".into())].into(),
            assets: Default::default(),
            metadata: Some(serde_json::json!({"private": "authoring"})),
        };
        let id = project_id("project");
        let uploaded = db
            .website_upload("project", "drive", &package)
            .await
            .unwrap();
        let deployment = package.id().unwrap();
        assert_eq!(uploaded.versions.len(), 1);
        assert!(db
            .kv
            .get(
                Tree::PluginMeta,
                &key(&id, &format!("packages/{deployment}"))
            )
            .unwrap()
            .is_none());
        assert!(db
            .kv
            .get(
                Tree::PluginMeta,
                &key(&id, &format!("files/{deployment}/index.html"))
            )
            .unwrap()
            .is_none());
        let manifest = db.website_verified_blob(&deployment).await.unwrap();
        assert_eq!(manifest, serde_json::to_vec(&package.manifest()).unwrap());
        assert_eq!(
            db.website_verified_blob(blake3::hash(b"Hello").to_hex().as_str())
                .await
                .unwrap(),
            b"Hello"
        );
        assert!(db
            .website_package(&project_id("other"), &deployment)
            .await
            .is_err());
        let duplicate = db
            .website_upload("project", "drive", &package)
            .await
            .unwrap();
        assert_eq!(duplicate.revision, uploaded.revision);
        assert_eq!(duplicate.versions, uploaded.versions);
        assert_eq!(
            db.website_package(&id, &deployment).await.unwrap().metadata,
            package.metadata
        );
        let legacy = WebsitePackage {
            metadata: None,
            ..package
        };
        let bytes = serde_json::to_vec(&legacy).unwrap();
        let legacy_id = blake3::hash(&bytes).to_hex().to_string();
        db.kv
            .insert(
                Tree::PluginMeta,
                &key(&id, &format!("packages/{legacy_id}")),
                &bytes,
            )
            .unwrap();
        assert_eq!(
            db.website_package(&id, &legacy_id).await.unwrap().files,
            legacy.files
        );
    }
    #[tokio::test]
    async fn upload_activate_rollback_unpublish_and_stale_writers() {
        let db = Db::init_temp("website_deployment").await.unwrap();
        let mut package = WebsitePackage {
            version: 1,
            assets: Default::default(),
            metadata: None,
            files: std::collections::BTreeMap::from([("index.html".into(), "First".into())]),
        };
        let id = project_id("project");
        let uploaded = db
            .website_upload("project", "drive", &package)
            .await
            .unwrap();
        assert!(db
            .website_public_file(&id, "index.html")
            .await
            .unwrap()
            .is_none());
        assert!(db
            .website_public_version_file(&id, &uploaded.deployments[0], "index.html")
            .await
            .unwrap()
            .is_none());
        let first = uploaded.deployments[0].clone();
        let published = db
            .website_activate(&id, uploaded.revision, Some(first.clone()), "owner")
            .unwrap()
            .unwrap();
        assert!(db
            .website_activate(&id, uploaded.revision, None, "stale")
            .unwrap()
            .is_none());
        package.files.insert("index.html".into(), "Second".into());
        let next = db
            .website_upload("project", "drive", &package)
            .await
            .unwrap();
        assert_eq!(
            db.website_public_file(&id, "index.html")
                .await
                .unwrap()
                .unwrap()
                .1,
            b"First"
        );
        assert!(db
            .website_public_version_file(&id, &next.deployments[1], "index.html")
            .await
            .unwrap()
            .is_none());
        let second = db
            .website_activate(
                &id,
                next.revision,
                Some(next.deployments[1].clone()),
                "owner",
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            db.website_public_file(&id, "index.html")
                .await
                .unwrap()
                .unwrap()
                .1,
            b"Second"
        );
        let rollback = db
            .website_activate(&id, second.revision, Some(first), "owner")
            .unwrap()
            .unwrap();
        assert_eq!(
            db.website_public_file(&id, "index.html")
                .await
                .unwrap()
                .unwrap()
                .1,
            b"First"
        );
        assert!(db
            .website_upload("project", "different drive", &package)
            .await
            .is_err());
        package.files.insert("../escape.js".into(), "Bad".into());
        assert!(db
            .website_upload("project", "drive", &package)
            .await
            .is_err());
        assert_eq!(
            db.website_state(&id).unwrap().unwrap().revision,
            rollback.revision
        );
        db.website_activate(&id, rollback.revision, None, "owner")
            .unwrap()
            .unwrap();
        assert!(db
            .website_public_file(&id, "index.html")
            .await
            .unwrap()
            .is_none());
        assert_eq!(published.history.len(), 1);
    }
}
