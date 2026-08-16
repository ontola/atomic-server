use atomic_lib::storelike::{Query, Storelike};
use atomic_lib::{urls, Db, Subject, Value};
use pyo3::exceptions::{PyKeyError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyDict;

use crate::{block_on, py_err, py_to_value, resolve_property, Resource};

/// Agent + personal drive created by [`Store.setup`].
#[pyclass]
#[derive(Clone)]
pub struct SetupInfo {
    #[pyo3(get)]
    pub agent_subject: String,
    #[pyo3(get)]
    pub agent_secret: String,
    #[pyo3(get)]
    pub drive_subject: String,
}

#[pymethods]
impl SetupInfo {
    fn __repr__(&self) -> String {
        format!(
            "SetupInfo(agent_subject={:?}, drive_subject={:?})",
            self.agent_subject, self.drive_subject
        )
    }
}

/// An Atomic agent (keypair) loaded into a store.
#[pyclass]
#[derive(Clone)]
pub struct AgentInfo {
    #[pyo3(get)]
    pub subject: String,
    #[pyo3(get)]
    pub secret: String,
    #[pyo3(get)]
    pub public_key: String,
    #[pyo3(get)]
    pub name: Option<String>,
    /// True when the secret names a drive that is not in this store yet.
    #[pyo3(get)]
    pub drive_needs_sync: bool,
}

#[pymethods]
impl AgentInfo {
    fn __repr__(&self) -> String {
        format!("AgentInfo(subject={:?})", self.subject)
    }
}

/// A drive subject and its display name.
#[pyclass]
#[derive(Clone)]
pub struct DriveInfo {
    #[pyo3(get)]
    pub subject: String,
    #[pyo3(get)]
    pub name: String,
}

#[pymethods]
impl DriveInfo {
    fn __repr__(&self) -> String {
        format!(
            "DriveInfo(name={:?}, subject={:?})",
            self.name, self.subject
        )
    }
}

/// Local Atomic Data store. Backed by redb on disk, or in memory.
///
/// Cheap to clone: every [`Resource`] keeps a handle so `.save()` works
/// without passing the store back in.
#[pyclass]
#[derive(Clone)]
pub struct Store {
    pub(crate) db: Db,
}

impl Store {
    pub(crate) fn wrap_resource(&self, resource: atomic_lib::Resource) -> Resource {
        Resource {
            inner: resource,
            db: self.db.clone(),
        }
    }

    fn subject(&self, raw: &str) -> Subject {
        Subject::from_raw(raw, self.db.get_base_domain().as_deref())
    }
}

#[pymethods]
impl Store {
    /// Open a persistent store at `path`.
    ///
    /// Creates the directory if needed. Data lives in `path/atomic.redb`.
    /// Call [`Store.flush`] (or use the store as a context manager) so recent
    /// writes survive a crash — redb commits are not fsynced on every write.
    #[staticmethod]
    fn open(path: &str) -> PyResult<Self> {
        let base = std::path::Path::new(path);
        let uploads = base.join("uploads");
        let db = block_on(Db::init_redb_file(base, None, &uploads)).map_err(py_err)?;
        Ok(Store { db })
    }

    /// In-memory store. Lost when the process exits. Useful in tests.
    #[staticmethod]
    fn in_memory() -> PyResult<Self> {
        let db = block_on(Db::init_redb(None)).map_err(py_err)?;
        Ok(Store { db })
    }

    /// Create an agent and a personal drive. Pure local — no network.
    ///
    /// Keep `agent_secret`. It is the only way to sign writes after a reopen.
    fn setup(&self, name: &str) -> PyResult<SetupInfo> {
        let (agent, drive_subject) = block_on(self.db.setup(name)).map_err(py_err)?;
        let secret = agent.build_secret().map_err(py_err)?;
        Ok(SetupInfo {
            agent_subject: agent.subject.to_string(),
            agent_secret: secret,
            drive_subject,
        })
    }

    /// Create an agent and set it as the default signer. No drive.
    fn create_agent(&self, name: &str) -> PyResult<AgentInfo> {
        let agent = block_on(self.db.create_agent(Some(name))).map_err(py_err)?;
        self.db.set_default_agent(agent.clone());
        agent_info(agent, false)
    }

    /// Restore an agent from a secret and make it the default signer.
    ///
    /// If the secret names a drive that is not in this store,
    /// `drive_needs_sync` is true — you can still read local data, but you
    /// cannot create resources under that drive until it is synced in.
    fn load_agent(&self, secret: &str) -> PyResult<AgentInfo> {
        let result = block_on(self.db.load_agent_from_secret(secret)).map_err(py_err)?;
        agent_info(result.agent, result.drive_needs_sync)
    }

    /// The currently active agent, if one has been set up or loaded.
    fn agent(&self) -> PyResult<Option<AgentInfo>> {
        match self.db.get_default_agent() {
            Ok(agent) => Ok(Some(agent_info(agent, false)?)),
            Err(_) => Ok(None),
        }
    }

    /// Create a drive and make it active. Requires a default agent.
    fn create_drive(&self, name: &str) -> PyResult<String> {
        block_on(self.db.create_drive(name)).map_err(py_err)
    }

    /// Drives belonging to the current agent.
    fn drives(&self) -> PyResult<Vec<DriveInfo>> {
        let drives = block_on(self.db.list_drives()).map_err(py_err)?;
        Ok(drives
            .into_iter()
            .map(|d| DriveInfo {
                subject: d.subject,
                name: d.name,
            })
            .collect())
    }

    #[getter]
    fn active_drive(&self) -> Option<String> {
        self.db.get_active_drive()
    }

    #[setter]
    fn set_active_drive(&self, subject: &str) -> PyResult<()> {
        self.db.set_active_drive(subject).map_err(py_err)
    }

    /// Create a resource, sign a genesis commit, persist it, and return it.
    ///
    /// Extra keyword arguments become properties (`description="..."`, or a
    /// full property URL). `parent` defaults to the active drive.
    #[pyo3(signature = (class_url, name, parent=None, **properties))]
    fn create(
        &self,
        class_url: &str,
        name: &str,
        parent: Option<&str>,
        properties: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<Resource> {
        let parent = match parent {
            Some(p) => p.to_string(),
            None => self.db.get_active_drive().ok_or_else(|| {
                PyValueError::new_err("create() needs a parent or an active drive")
            })?,
        };

        let mut extra_owned: Vec<(String, Value)> = Vec::new();
        if let Some(props) = properties {
            for (key, val) in props.iter() {
                let key: String = key.extract()?;
                extra_owned.push((resolve_property(&key), py_to_value(&val)?));
            }
        }
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
            block_on(self.db.create_resource(class_url, &parent, name, extra)).map_err(py_err)?;
        self.get(&subject)?
            .ok_or_else(|| py_err(format!("created {subject} but could not read it back")))
    }

    /// Fetch a resource by subject URL / DID. `None` if it is not stored.
    fn get(&self, subject: &str) -> PyResult<Option<Resource>> {
        let subject = self.subject(subject);
        match block_on(self.db.get_resource(&subject)) {
            Ok(resource) => Ok(Some(self.wrap_resource(resource))),
            Err(_) => Ok(None),
        }
    }

    /// True when the subject is already in this store (no network fetch).
    fn has(&self, subject: &str) -> bool {
        self.db.has_resource_locally(subject)
    }

    /// Query local resources.
    ///
    /// Filters AND together. With no filter, lists children of the active
    /// drive. Pass `parent`, `class_url`, and/or `property` + `value`.
    #[pyo3(signature = (parent=None, class_url=None, property=None, value=None, limit=None, offset=0))]
    fn query(
        &self,
        parent: Option<&str>,
        class_url: Option<&str>,
        property: Option<&str>,
        value: Option<&Bound<'_, PyAny>>,
        limit: Option<usize>,
        offset: usize,
    ) -> PyResult<Vec<Resource>> {
        let mut parent = parent.map(|s| s.to_string());
        if parent.is_none() && class_url.is_none() && property.is_none() {
            parent = self.db.get_active_drive();
            if parent.is_none() {
                return Err(PyValueError::new_err(
                    "query() needs a filter or an active drive",
                ));
            }
        }

        let mut q = Query::new();
        q.include_nested = true;
        q.limit = limit;
        q.offset = offset;

        if let Some(class) = class_url {
            q = q.class_filter(class);
        }
        if let Some(parent) = &parent {
            q = q.filter(urls::PARENT, Value::String(parent.clone()));
        }
        if let Some(prop) = property {
            let val = value
                .ok_or_else(|| PyValueError::new_err("query(property=...) also needs value="))?;
            q.property = Some(resolve_property(prop));
            q.value = Some(py_to_value(val)?);
        }

        let result = block_on(self.db.query(&q)).map_err(py_err)?;
        Ok(result
            .resources
            .into_iter()
            .map(|r| self.wrap_resource(r))
            .collect())
    }

    /// Destroy a resource (signed commit). Raises if it is not stored.
    fn delete(&self, subject: &str) -> PyResult<()> {
        let mut resource = self
            .get(subject)?
            .ok_or_else(|| PyKeyError::new_err(subject.to_string()))?;
        resource.destroy()?;
        Ok(())
    }

    /// Persist buffered writes. Call this before exit if you care about
    /// the last few seconds of data.
    fn flush(&self) -> PyResult<()> {
        self.db.flush().map_err(py_err)
    }

    fn __enter__(slf: Py<Self>) -> Py<Self> {
        slf
    }

    fn __exit__(
        &self,
        _exc_type: &Bound<'_, PyAny>,
        _exc: &Bound<'_, PyAny>,
        _tb: &Bound<'_, PyAny>,
    ) -> PyResult<bool> {
        self.flush()?;
        Ok(false)
    }

    fn __repr__(&self) -> String {
        match self.db.get_active_drive() {
            Some(drive) => format!("Store(active_drive={drive:?})"),
            None => "Store()".to_string(),
        }
    }
}

fn agent_info(agent: atomic_lib::agents::Agent, drive_needs_sync: bool) -> PyResult<AgentInfo> {
    let secret = agent.build_secret().map_err(py_err)?;
    Ok(AgentInfo {
        subject: agent.subject.to_string(),
        secret,
        public_key: agent.public_key,
        name: agent.name,
        drive_needs_sync,
    })
}
