//! Local self-hosting adapter. Packages/files and activation state are separate KV entries.
//! Single-process mutations are serialized; redb exclusively owns the database file.
//! SaaS can reuse WebsitePackage with object storage and a transactional control-plane DB.
use super::trees::{Method, Operation, Tree};
use crate::{
    errors::AtomicResult,
    website::{project_id, WebsitePackage},
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
    pub fn website_state(&self, id: &str) -> AtomicResult<Option<WebsiteState>> {
        self.kv
            .get(Tree::PluginMeta, &key(id, "state"))?
            .map(|v| serde_json::from_slice(&v).map_err(Into::into))
            .transpose()
    }
    pub fn website_upload(
        &self,
        project: &str,
        drive: &str,
        package: &WebsitePackage,
    ) -> AtomicResult<WebsiteState> {
        let deployment = package.id()?;
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
        for (path, content) in &package.files {
            ops.push(insert(
                key(&id, &format!("files/{deployment}/{path}")),
                content.as_bytes().to_vec(),
            ));
        }
        ops.push(insert(
            key(&id, &format!("packages/{deployment}")),
            serde_json::to_vec(package)?,
        ));
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
    pub fn website_package(&self, id: &str, deployment: &str) -> AtomicResult<WebsitePackage> {
        let bytes = self
            .kv
            .get(
                Tree::PluginMeta,
                &key(id, &format!("packages/{deployment}")),
            )?
            .ok_or("Website deployment is missing")?;
        let package: WebsitePackage = serde_json::from_slice(&bytes)?;
        if package.id()? != deployment {
            return Err("Website package integrity check failed".into());
        }
        Ok(package)
    }
    /// Versioned assets keep a page on one release during concurrent activation.
    /// Merely uploading an ID never makes that version public; unpublish hides all versions.
    pub fn website_public_version_file(
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
        Ok(self
            .kv
            .get(
                Tree::PluginMeta,
                &key(id, &format!("files/{deployment}/{path}")),
            )?
            .map(|bytes| (deployment.into(), bytes)))
    }
    /// Only an active project can expose files. Private uploaded releases have no public path.
    pub fn website_public_file(
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
        Ok(self
            .kv
            .get(
                Tree::PluginMeta,
                &key(id, &format!("files/{active}/{path}")),
            )?
            .map(|bytes| (active, bytes)))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn upload_activate_rollback_unpublish_and_stale_writers() {
        let db = Db::init_temp("website_deployment").await.unwrap();
        let mut package = WebsitePackage {
            version: 1,
            files: std::collections::BTreeMap::from([("index.html".into(), "First".into())]),
        };
        let id = project_id("project");
        let uploaded = db.website_upload("project", "drive", &package).unwrap();
        assert!(db.website_public_file(&id, "index.html").unwrap().is_none());
        assert!(db
            .website_public_version_file(&id, &uploaded.deployments[0], "index.html")
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
        let next = db.website_upload("project", "drive", &package).unwrap();
        assert_eq!(
            db.website_public_file(&id, "index.html")
                .unwrap()
                .unwrap()
                .1,
            b"First"
        );
        assert!(db
            .website_public_version_file(&id, &next.deployments[1], "index.html")
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
                .unwrap()
                .unwrap()
                .1,
            b"First"
        );
        assert!(db
            .website_upload("project", "different drive", &package)
            .is_err());
        package.files.insert("../escape.js".into(), "Bad".into());
        assert!(db.website_upload("project", "drive", &package).is_err());
        assert_eq!(
            db.website_state(&id).unwrap().unwrap().revision,
            rollback.revision
        );
        db.website_activate(&id, rollback.revision, None, "owner")
            .unwrap()
            .unwrap();
        assert!(db.website_public_file(&id, "index.html").unwrap().is_none());
        assert_eq!(published.history.len(), 1);
    }
}
