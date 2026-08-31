use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use atomic_lib::storelike::{Query, Storelike};
use atomic_lib::{urls, Db, Subject, Value};

use crate::convert::{resolve_property, string_to_value};
use crate::resource::Resource;
use crate::{block_on, err, AgentInfo, AtomicSdkError, DriveInfo, PeerInfo, SetupInfo, SyncReport};

#[derive(uniffi::Object)]
pub struct Store {
    db: Mutex<Db>,
}

impl Store {
    fn db(&self) -> Db {
        self.db.lock().expect("store db lock").clone()
    }

    fn subject(&self, raw: &str) -> Subject {
        Subject::from_raw(raw, self.db().get_base_domain().as_deref())
    }

    pub(crate) fn wrap(&self, resource: atomic_lib::Resource) -> Arc<Resource> {
        Arc::new(Resource::new(resource, self.db()))
    }
}

#[uniffi::export]
impl Store {
    /// Open a persistent store. `server` is the AtomicServer origin used for
    /// HTTP search and `save_remote()`. Schema `get()` of an `https://`
    /// subject still fetches even when this is unset.
    #[uniffi::constructor(default(server = None))]
    pub fn open(path: String, server: Option<String>) -> Result<Arc<Self>, AtomicSdkError> {
        let base = std::path::Path::new(&path);
        let uploads = base.join("uploads");
        let db = block_on(Db::init_redb_file(base, server, &uploads)).map_err(err)?;
        Ok(Arc::new(Store { db: Mutex::new(db) }))
    }

    #[uniffi::constructor(default(server = None))]
    pub fn in_memory(server: Option<String>) -> Result<Arc<Self>, AtomicSdkError> {
        let db = block_on(Db::init_redb(server)).map_err(err)?;
        Ok(Arc::new(Store { db: Mutex::new(db) }))
    }

    /// AtomicServer origin for HTTP search and `saveRemote()`, or `null`.
    pub fn server(&self) -> Option<String> {
        self.db().get_base_domain()
    }

    /// Set the AtomicServer origin (`https://example.com`).
    pub fn set_server(&self, url: String) {
        let mut guard = self.db.lock().expect("store db lock");
        *guard = guard.clone_with_url(url);
    }

    pub fn setup(&self, name: String) -> Result<SetupInfo, AtomicSdkError> {
        let (agent, drive_subject) = block_on(self.db().setup(&name)).map_err(err)?;
        let secret = agent.build_secret().map_err(err)?;
        Ok(SetupInfo {
            agent_subject: agent.subject.to_string(),
            agent_secret: secret,
            drive_subject,
        })
    }

    pub fn create_agent(&self, name: String) -> Result<AgentInfo, AtomicSdkError> {
        let db = self.db();
        let agent = block_on(db.create_agent(Some(&name))).map_err(err)?;
        db.set_default_agent(agent.clone());
        agent_info(agent, false)
    }

    pub fn load_agent(&self, secret: String) -> Result<AgentInfo, AtomicSdkError> {
        let result = block_on(self.db().load_agent_from_secret(&secret)).map_err(err)?;
        agent_info(result.agent, result.drive_needs_sync)
    }

    pub fn agent(&self) -> Result<Option<AgentInfo>, AtomicSdkError> {
        match self.db().get_default_agent() {
            Ok(agent) => Ok(Some(agent_info(agent, false)?)),
            Err(_) => Ok(None),
        }
    }

    pub fn create_drive(&self, name: String) -> Result<String, AtomicSdkError> {
        block_on(self.db().create_drive(&name)).map_err(err)
    }

    pub fn drives(&self) -> Result<Vec<DriveInfo>, AtomicSdkError> {
        let drives = block_on(self.db().list_drives()).map_err(err)?;
        Ok(drives
            .into_iter()
            .map(|d| DriveInfo {
                subject: d.subject,
                name: d.name,
            })
            .collect())
    }

    pub fn active_drive(&self) -> Option<String> {
        self.db().get_active_drive()
    }

    pub fn set_active_drive(&self, subject: String) -> Result<(), AtomicSdkError> {
        self.db().set_active_drive(&subject).map_err(err)
    }

    pub fn create(
        &self,
        class_url: String,
        name: String,
        parent: Option<String>,
        properties: Option<HashMap<String, String>>,
    ) -> Result<Arc<Resource>, AtomicSdkError> {
        let parent = match parent {
            Some(p) => p,
            None => self.db().get_active_drive().ok_or_else(|| {
                AtomicSdkError::from("create() needs a parent or an active drive")
            })?,
        };
        let extra_owned: Vec<(String, Value)> = properties
            .unwrap_or_default()
            .into_iter()
            .map(|(k, v)| (resolve_property(&k), string_to_value(&v)))
            .collect();
        let extra_refs: Vec<(&str, Value)> = extra_owned
            .iter()
            .map(|(k, v)| (k.as_str(), v.clone()))
            .collect();
        let extra = if extra_refs.is_empty() {
            None
        } else {
            Some(extra_refs)
        };
        let subject =
            block_on(self.db().create_resource(&class_url, &parent, &name, extra)).map_err(err)?;
        self.get(subject)?
            .ok_or_else(|| AtomicSdkError::from("created resource but could not read it back"))
    }

    /// Fetch a resource by subject URL / DID.
    ///
    /// Local first. If the subject is an `http(s)://` URL that is not in
    /// this store, this GETs JSON-AD over HTTP, caches it, and returns it.
    /// That is how unknown Class / Property schema items are loaded.
    pub fn get(&self, subject: String) -> Result<Option<Arc<Resource>>, AtomicSdkError> {
        let subject = self.subject(&subject);
        match block_on(self.db().get_resource(&subject)) {
            Ok(resource) => Ok(Some(self.wrap(resource))),
            Err(_) => Ok(None),
        }
    }

    /// True when the subject is already in this store (no network fetch).
    pub fn has(&self, subject: String) -> bool {
        self.db().has_resource_locally(&subject)
    }

    pub fn query(
        &self,
        parent: Option<String>,
        class_url: Option<String>,
        property: Option<String>,
        value: Option<String>,
        limit: Option<u32>,
        offset: u32,
    ) -> Result<Vec<Arc<Resource>>, AtomicSdkError> {
        let mut parent = parent;
        if parent.is_none() && class_url.is_none() && property.is_none() {
            parent = self.db().get_active_drive();
            if parent.is_none() {
                return Err(AtomicSdkError::from(
                    "query() needs a filter or an active drive",
                ));
            }
        }

        let mut q = Query::new();
        q.include_nested = true;
        q.limit = limit.map(|n| n as usize);
        q.offset = offset as usize;
        if let Some(drive) = self.db().get_active_drive().or_else(|| parent.clone()) {
            q.drive = Some(self.subject(&drive));
        }
        if let Some(class) = &class_url {
            q = q.class_filter(class);
        }
        if let Some(parent) = &parent {
            q = q.filter(urls::PARENT, Value::String(parent.clone()));
        }
        if let Some(prop) = property {
            let val = value
                .ok_or_else(|| AtomicSdkError::from("query(property=...) also needs value="))?;
            q.property = Some(resolve_property(&prop));
            q.value = Some(string_to_value(&val));
        }

        let result = block_on(self.db().query(&q)).map_err(err)?;
        Ok(result.resources.into_iter().map(|r| self.wrap(r)).collect())
    }

    /// Full-text search on the configured AtomicServer `/search` endpoint.
    ///
    /// Requires `server` (constructor or `setServer`).
    pub fn search(
        &self,
        query: String,
        limit: Option<u32>,
    ) -> Result<Vec<Arc<Resource>>, AtomicSdkError> {
        if self.db().get_base_domain().is_none() {
            return Err(AtomicSdkError::from(
                "search() needs a server URL (Store.open(..., server=...) or store.setServer(...))",
            ));
        }
        let opts = atomic_lib::client::search::SearchOpts {
            limit,
            ..Default::default()
        };
        let resources = block_on(self.db().search(&query, opts)).map_err(err)?;
        Ok(resources.into_iter().map(|r| self.wrap(r)).collect())
    }

    pub fn delete(&self, subject: String) -> Result<(), AtomicSdkError> {
        let resource = self
            .get(subject.clone())?
            .ok_or_else(|| AtomicSdkError::from(format!("not found: {subject}")))?;
        resource.destroy_resource()
    }

    pub fn flush(&self) -> Result<(), AtomicSdkError> {
        self.db().flush().map_err(err)
    }

    pub fn start_peer(&self) -> Result<String, AtomicSdkError> {
        crate::peer::start_peer(&self.db())
    }

    pub fn peer_id(&self) -> Option<String> {
        crate::peer::peer_id()
    }

    pub fn announce(&self, drive: Option<String>) -> Result<(), AtomicSdkError> {
        crate::peer::announce(&self.db(), drive.as_deref())
    }

    pub fn sync_with(
        &self,
        node_id: String,
        drive: Option<String>,
    ) -> Result<SyncReport, AtomicSdkError> {
        crate::peer::sync_with(&self.db(), &node_id, drive.as_deref())
    }

    pub fn add_peer(&self, node_id: String, name: String) {
        atomic_lib::sync::peer::add_known_peer(&self.db(), &node_id, &name);
    }

    pub fn peers(&self) -> Vec<PeerInfo> {
        atomic_lib::sync::peer::get_known_peers(&self.db())
            .into_iter()
            .map(|p| PeerInfo {
                node_id: crate::peer::node_uri(&p.node_id),
                name: p.name,
            })
            .collect()
    }

    pub fn live_peers(&self) -> Vec<String> {
        atomic_lib::sync::peer::live_peer_ids()
            .into_iter()
            .map(|id| crate::peer::node_uri(&id))
            .collect()
    }

    pub fn wait_for(&self, subject: String, timeout_secs: f64) -> Result<String, AtomicSdkError> {
        crate::peer::wait_for(&self.db(), &subject, timeout_secs)
    }

    pub fn device_name(&self) -> String {
        atomic_lib::sync::peer::get_device_name(&self.db())
    }

    pub fn set_device_name(&self, name: String) {
        atomic_lib::sync::peer::set_device_name(&self.db(), &name);
    }
}

fn agent_info(
    agent: atomic_lib::agents::Agent,
    drive_needs_sync: bool,
) -> Result<AgentInfo, AtomicSdkError> {
    let secret = agent.build_secret().map_err(err)?;
    Ok(AgentInfo {
        subject: agent.subject.to_string(),
        secret,
        public_key: agent.public_key,
        name: agent.name,
        drive_needs_sync,
    })
}
