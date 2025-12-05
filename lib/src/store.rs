//! In-memory store of Atomic data.
//! This provides many methods for finding, changing, serializing and parsing Atomic Data.

use crate::agents::Agent;
use crate::storelike::QueryResult;
use crate::Value;
use crate::{atoms::Atom, storelike::Storelike};
use crate::{errors::AtomicResult, Resource};
use async_trait::async_trait;
use std::{collections::HashMap, sync::Arc, sync::Mutex};

/// The in-memory store of data, containing the Resources, Properties and Classes
/// It uses the `default_agent` as the default client.
#[derive(Clone)]
pub struct Store {
    // The store currently holds two stores - that is not ideal
    hashmap: Arc<Mutex<HashMap<String, Resource>>>,
    default_agent: Arc<Mutex<Option<crate::agents::Agent>>>,
    server_url: Arc<Mutex<Option<String>>>,
}

impl Store {
    /// Creates an empty Store.
    /// Run `.populate()` to get useful standard models loaded into your store.
    pub async fn init() -> AtomicResult<Store> {
        let store = Store {
            hashmap: Arc::new(Mutex::new(HashMap::new())),
            default_agent: Arc::new(Mutex::new(None)),
            server_url: Arc::new(Mutex::new(None)),
        };
        crate::populate::populate_base_models(&store).await?;
        Ok(store)
    }

    /// Set the URL of the server which endpoint we are using.
    /// This is needed for generating correct URLs for Commits, Search, etc.
    pub fn set_server_url(&self, server_url: &str) {
        self.server_url.lock().unwrap().replace(server_url.into());
    }

    /// Triple Pattern Fragments interface.
    /// Use this for most queries, e.g. finding all items with some property / value combination.
    /// Returns an empty array if nothing is found.
    // Very costly, slow implementation.
    // Does not assume any indexing.
    async fn tpf(
        &self,
        q_subject: Option<&str>,
        q_property: Option<&str>,
        q_value: Option<&Value>,
        // Whether resources from outside the store should be searched through
        include_external: bool,
    ) -> AtomicResult<Vec<Atom>> {
        let mut vec: Vec<Atom> = Vec::new();

        let hassub = q_subject.is_some();
        let hasprop = q_property.is_some();
        let hasval = q_value.is_some();

        // Simply return all the atoms
        if !hassub && !hasprop && !hasval {
            for resource in self.all_resources(include_external) {
                for (property, value) in resource.get_propvals() {
                    vec.push(Atom::new(
                        resource.get_subject().clone(),
                        property.clone(),
                        value.clone(),
                    ))
                }
            }
            return Ok(vec);
        }

        // Find atoms matching the TPF query in a single resource
        let mut find_in_resource = |resource: &Resource| {
            let subj = resource.get_subject();
            for (prop, val) in resource.get_propvals().iter() {
                if hasprop && q_property.as_ref().unwrap() == prop {
                    if hasval {
                        if val.contains_value(q_value.unwrap()) {
                            vec.push(Atom::new(subj.into(), prop.into(), val.clone()))
                        }
                        break;
                    } else {
                        vec.push(Atom::new(subj.into(), prop.into(), val.clone()))
                    }
                    break;
                } else if hasval && !hasprop && val.contains_value(q_value.unwrap()) {
                    vec.push(Atom::new(subj.into(), prop.into(), val.clone()))
                }
            }
        };

        match q_subject {
            Some(sub) => match self.get_resource(sub).await {
                Ok(resource) => {
                    if hasprop | hasval {
                        find_in_resource(&resource);
                        Ok(vec)
                    } else {
                        Ok(resource.to_atoms())
                    }
                }
                Err(_) => Ok(vec),
            },
            None => {
                for resource in self.all_resources(include_external) {
                    find_in_resource(&resource);
                }
                Ok(vec)
            }
        }
    }
}

#[async_trait]
impl Storelike for Store {
    async fn add_atoms(&self, atoms: Vec<Atom>) -> AtomicResult<()> {
        // Start with a nested HashMap, containing only strings.
        let mut map: HashMap<String, Resource> = HashMap::new();
        for atom in atoms {
            match map.get_mut(&atom.subject) {
                // Resource exists in map
                Some(resource) => {
                    resource.set_unsafe(atom.property, atom.value);
                }
                // Resource does not exist
                None => {
                    let mut resource = Resource::new(atom.subject.clone());
                    resource.set_unsafe(atom.property, atom.value);
                    map.insert(atom.subject, resource);
                }
            }
        }
        for (_subject, resource) in map.iter() {
            self.add_resource(resource).await?
        }
        Ok(())
    }

    async fn add_resource_opts(
        &self,
        resource: &Resource,
        check_required_props: bool,
        update_index: bool,
        overwrite_existing: bool,
    ) -> AtomicResult<()> {
        if check_required_props {
            resource.check_required_props(self).await?;
        }
        if !overwrite_existing {
            let subject = resource.get_subject();
            if let Some(_r) = self.hashmap.lock().unwrap().get(subject) {
                return Err(format!("{} already present, will not overwrite.", subject).into());
            }
        }
        let _ = update_index;
        // This store has no index, so we don't need to update it.
        self.hashmap
            .lock()
            .unwrap()
            .insert(resource.get_subject().into(), resource.clone());
        Ok(())
    }

    // TODO: Fix this for local stores, include external does not make sense here
    fn all_resources(&self, _include_external: bool) -> Box<dyn Iterator<Item = Resource> + Send> {
        Box::new(self.hashmap.lock().unwrap().clone().into_values())
    }

    fn get_server_url(&self) -> AtomicResult<String> {
        self.server_url
            .lock()
            .unwrap()
            .clone()
            .ok_or("No server URL found. Set it using `store.set_server_url`.".into())
    }

    fn get_self_url(&self) -> Option<String> {
        None
    }

    fn get_default_agent(&self) -> AtomicResult<Agent> {
        match self.default_agent.lock().unwrap().to_owned() {
            Some(agent) => Ok(agent),
            None => Err("No default agent has been set.".into()),
        }
    }

    async fn get_resource(&self, subject: &str) -> AtomicResult<Resource> {
        if let Some(resource) = self.hashmap.lock().unwrap().get(subject) {
            return Ok(resource.clone());
        }

        if let Ok(resource) = self
            .fetch_resource(subject, self.get_default_agent().ok().as_ref())
            .await
        {
            return Ok(resource);
        };

        self.handle_not_found(
            subject,
            "Not found in HashMap.".into(),
            self.get_default_agent().ok().as_ref(),
        )
        .await
    }

    async fn remove_resource(&self, subject: &str) -> AtomicResult<()> {
        let resource = self.get_resource(subject).await?;
        for child in resource.get_children(self).await? {
            Box::pin(self.remove_resource(child.get_subject())).await?;
        }
        self.hashmap
            .lock()
            .unwrap()
            .remove_entry(subject)
            .ok_or(format!(
                "Resource {} could not be deleted, because it is not found",
                subject
            ))?;
        Ok(())
    }

    fn set_default_agent(&self, agent: Agent) {
        self.default_agent.lock().unwrap().replace(agent);
    }

    async fn query(
        &self,
        q: &crate::storelike::Query,
    ) -> AtomicResult<crate::storelike::QueryResult> {
        let atoms = self
            .tpf(
                None,
                q.property.as_deref(),
                q.value.as_ref(),
                q.include_external,
            )
            .await?;

        // Remove duplicate subjects
        let mut subjects_deduplicated: Vec<String> = atoms
            .iter()
            .map(|atom| atom.subject.clone())
            .collect::<std::collections::HashSet<String>>()
            .into_iter()
            .collect();

        // Sort by subject, better than no sorting
        subjects_deduplicated.sort();

        // WARNING: Entering expensive loop!
        // This is needed for sorting, authorization and including nested resources.
        // It could be skipped if there is no authorization and sorting requirement.
        let mut resources = Vec::new();
        for subject in subjects_deduplicated.iter() {
            // These nested resources are not fully calculated - they will be presented as -is
            match self
                .get_resource_extended(subject, true, &q.for_agent)
                .await
            {
                Ok(resource) => {
                    resources.push(resource.to_single());
                }
                Err(e) => match &e.error_type {
                    crate::AtomicErrorType::NotFoundError => {}
                    crate::AtomicErrorType::UnauthorizedError => {}
                    _other => {
                        return Err(
                            format!("Error when getting resource in collection: {}", e).into()
                        )
                    }
                },
            }
        }

        if let Some(sort) = &q.sort_by {
            resources = crate::collections::sort_resources(resources, sort, q.sort_desc);
        }
        let mut subjects = Vec::new();
        for r in resources.iter() {
            subjects.push(r.get_subject().clone())
        }

        Ok(QueryResult {
            count: atoms.len(),
            subjects,
            resources,
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::{agents::ForAgent, urls, Value};

    async fn init_store() -> Store {
        let store = Store::init().await.unwrap();
        store.populate().await.unwrap();
        store
    }

    #[tokio::test]
    async fn populate_base_models() {
        let store = Store::init().await.unwrap();
        crate::populate::populate_base_models(&store).await.unwrap();
        let property = store.get_property(urls::DESCRIPTION).await.unwrap();
        assert_eq!(property.shortname, "description")
    }

    #[tokio::test]
    async fn single_get_empty_server_to_class() {
        let store = Store::init().await.unwrap();
        crate::populate::populate_base_models(&store).await.unwrap();
        // Should fetch the agent class, since it's not in the store
        let agent = store.get_class(urls::AGENT).await.unwrap();
        assert_eq!(agent.shortname, "agent")
    }

    #[tokio::test]
    async fn get_full_resource_and_shortname() {
        let store = init_store().await;
        let resource = store.get_resource(urls::CLASS).await.unwrap();
        let shortname = resource
            .get_shortname("shortname", &store)
            .await
            .unwrap()
            .to_string();
        assert!(shortname == "class");
    }

    #[tokio::test]
    async fn serialize() {
        let store = init_store().await;
        let subject = urls::CLASS;
        let resource = store.get_resource(subject).await.unwrap();
        resource.to_json_ad().unwrap();
    }

    #[tokio::test]
    async fn tpf() {
        let store = init_store().await;
        let val = &Value::Slug("class".into());
        let val_url = &Value::AtomicUrl(urls::CLASS.into());
        // All atoms
        let atoms = store.tpf(None, None, None, true).await.unwrap();
        assert!(atoms.len() > 10);
        // Find by subject
        let atoms = store
            .tpf(Some(urls::CLASS), None, None, true)
            .await
            .unwrap();
        assert_eq!(atoms.len(), 6);
        // Find by value
        let atoms = store.tpf(None, None, Some(val), true).await.unwrap();
        assert_eq!(atoms[0].subject, urls::CLASS);
        assert_eq!(atoms.len(), 1);
        // Find by property and value
        let atoms = store
            .tpf(None, Some(urls::SHORTNAME), Some(val), true)
            .await
            .unwrap();
        assert!(atoms[0].subject == urls::CLASS);
        assert_eq!(atoms.len(), 1);
        // Find item in array
        let atoms = store
            .tpf(None, Some(urls::IS_A), Some(val_url), true)
            .await
            .unwrap();
        println!("{:?}", atoms);
        assert!(atoms.len() > 3, "Find item in array");
    }

    #[tokio::test]
    async fn path() {
        let store = init_store().await;
        let res = store
            .get_path(
                "https://atomicdata.dev/classes/Class shortname",
                None,
                &ForAgent::Sudo,
            )
            .await
            .unwrap();
        match res {
            crate::storelike::PathReturn::Subject(_) => panic!("Should be an Atom"),
            crate::storelike::PathReturn::Atom(atom) => {
                assert_eq!(atom.value.to_string(), "class");
            }
        }
        let res = store
            .get_path(
                "https://atomicdata.dev/classes/Class requires 0",
                None,
                &ForAgent::Sudo,
            )
            .await
            .unwrap();
        match res {
            crate::storelike::PathReturn::Subject(sub) => {
                assert_eq!(sub, urls::SHORTNAME);
            }
            crate::storelike::PathReturn::Atom(_) => panic!("Should be an Subject"),
        }
    }

    #[test]
    fn get_external_resource() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let store = Store::init().await.unwrap();
            store.populate().await.unwrap();
            // If nothing happens - this night be deadlock.
            store.get_resource(urls::CLASS).await.unwrap();
        });
    }

    #[tokio::test]
    #[should_panic]
    async fn path_fail() {
        let store = init_store().await;
        store
            .get_path(
                "https://atomicdata.dev/classes/Class requires isa description",
                None,
                &ForAgent::Sudo,
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    #[should_panic]
    async fn path_fail2() {
        let store = init_store().await;
        store
            .get_path(
                "https://atomicdata.dev/classes/Class requires requires",
                None,
                &ForAgent::Sudo,
            )
            .await
            .unwrap();
    }
}
