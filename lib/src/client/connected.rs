//! High-level client for connecting to an AtomicServer.
//!
//! `Client` is the main entry point for app developers. It connects to a server,
//! manages an agent identity, and provides methods to create, fetch, edit and
//! subscribe to resources. All CRDT state is managed internally via Loro.
//!
//! ```no_run
//! # async fn example() -> atomic_lib::errors::AtomicResult<()> {
//! use atomic_lib::client::connected::Client;
//!
//! let client = Client::new("http://localhost:9883").await?;
//! let agent = client.new_agent("Alice").await?;
//! let drive = client.new_drive(&agent, "Alice's Drive").await?;
//!
//! let mut resource = client.new_resource(&drive);
//! resource.set_name("My first resource");
//! resource.save_remote(client.store()).await?;
//! # Ok(())
//! # }
//! ```

use crate::{agents::Agent, errors::AtomicResult, urls, Resource, Storelike, Value};

/// A connected client to an AtomicServer.
pub struct Client {
    /// The base URL of the server (e.g. "http://localhost:9883")
    server_url: String,
    /// In-memory store for caching resources and ontologies
    store: crate::Store,
}

impl Client {
    /// Create a new client pointing at a server.
    pub async fn new(server_url: &str) -> AtomicResult<Self> {
        let store = crate::Store::init().await?;
        store.set_base_url(server_url);
        store.populate().await?;

        Ok(Self {
            server_url: server_url.to_string(),
            store,
        })
    }

    /// The server URL this client is connected to.
    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    /// Access the underlying store.
    pub fn store(&self) -> &crate::Store {
        &self.store
    }

    /// Generate a new Agent (Ed25519 keypair) with the given name.
    pub async fn new_agent(&self, name: &str) -> AtomicResult<Agent> {
        let agent = self.store.create_agent(Some(name)).await?;
        self.store.set_default_agent(agent.clone());
        Ok(agent)
    }

    /// Create a new private Drive (only the agent can read and write).
    /// Returns the drive's subject (a `did:ad:` URL).
    pub async fn new_drive(&self, agent: &Agent, name: &str) -> AtomicResult<String> {
        self.store.set_default_agent(agent.clone());
        let mut drive = Resource::new("did:ad:placeholder".into());
        drive.set_unsafe(
            urls::IS_A.into(),
            Value::ResourceArray(vec![urls::DRIVE.into()]),
        );
        drive.set_name(name);
        drive.set_unsafe(
            urls::WRITE.into(),
            Value::ResourceArray(vec![agent.subject.to_string().into()]),
        );
        drive.set_unsafe(
            urls::READ.into(),
            Value::ResourceArray(vec![agent.subject.to_string().into()]),
        );
        drive.save_remote(&self.store).await
    }

    /// Create a new public Drive (readable by anyone, writable by the agent).
    /// Returns the drive's subject (a `did:ad:` URL).
    pub async fn new_public_drive(&self, agent: &Agent, name: &str) -> AtomicResult<String> {
        self.store.set_default_agent(agent.clone());
        let mut drive = Resource::new("did:ad:placeholder".into());
        drive.set_unsafe(
            urls::IS_A.into(),
            Value::ResourceArray(vec![urls::DRIVE.into()]),
        );
        drive.set_name(name);
        drive.set_unsafe(
            urls::WRITE.into(),
            Value::ResourceArray(vec![agent.subject.to_string().into()]),
        );
        drive.set_unsafe(
            urls::READ.into(),
            Value::ResourceArray(vec![urls::PUBLIC_AGENT.into()]),
        );
        drive.save_remote(&self.store).await
    }

    /// Create a new resource in the given drive.
    pub fn new_resource(&self, parent: &str) -> Resource {
        let mut resource = Resource::new("did:ad:placeholder".into());
        resource.set_unsafe(urls::PARENT.into(), Value::AtomicUrl(parent.into()));
        resource
    }

    /// Fetch a resource from the server.
    pub async fn get_resource(&self, subject: &str) -> AtomicResult<Resource> {
        let response = crate::client::fetch_resource(
            subject,
            &self.store,
            self.store.get_default_agent().ok().as_ref(),
        )
        .await?;

        Ok(response.to_single())
    }
}
