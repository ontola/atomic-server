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
//! resource.set_name("My first resource")?;
//! resource.save(&client, &agent).await?;
//! # Ok(())
//! # }
//! ```

use crate::{
    agents::Agent,
    commit::{Commit, CommitBuilder},
    errors::AtomicResult,
    loro::AtomicLoroDoc,
    urls, Resource, Storelike, Value,
    values::SubResource,
};

/// A connected client to an AtomicServer.
/// Manages the HTTP connection, agent, and optionally a WebSocket for real-time sync.
pub struct Client {
    /// The base URL of the server (e.g. "http://localhost:9883")
    server_url: String,
    /// In-memory store for caching resources and ontologies
    store: crate::Store,
}

impl Client {
    /// Create a new client pointing at a server. Does not connect yet.
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

    /// Access the underlying store (for advanced use).
    pub fn store(&self) -> &crate::Store {
        &self.store
    }

    /// Generate a new Agent (Ed25519 keypair) with the given name.
    /// The agent is not yet known to the server — it becomes known when it
    /// signs its first commit.
    pub async fn new_agent(&self, name: &str) -> AtomicResult<Agent> {
        let agent = self.store.create_agent(Some(name)).await?;
        self.store.set_default_agent(agent.clone());
        Ok(agent)
    }

    /// Create a new Drive on the server, owned by the given agent.
    /// Returns the drive's subject (a `did:ad:` URL).
    pub async fn new_drive(&self, agent: &Agent, name: &str) -> AtomicResult<String> {
        self.store.set_default_agent(agent.clone());

        let doc = AtomicLoroDoc::new();
        doc.set_property(urls::IS_A, &Value::ResourceArray(vec![urls::DRIVE.into()]))?;
        doc.set_property(urls::NAME, &Value::String(name.into()))?;
        doc.set_property(
            urls::WRITE,
            &Value::ResourceArray(vec![agent.subject.to_string().into()]),
        )?;
        doc.set_property(
            urls::READ,
            &Value::ResourceArray(vec![agent.subject.to_string().into()]),
        )?;

        let mut builder = CommitBuilder::new("did:ad:placeholder".into());
        builder.is_genesis = true;
        builder.set_loro_update(doc.export_snapshot());

        let commit = Commit::create_did(builder, agent, &self.store).await?;
        let subject = commit.subject.clone();

        crate::client::post_commit(&commit, &self.store).await?;

        Ok(subject)
    }

    /// Create a new resource in the given drive. Returns a `LiveResource` that
    /// can be edited and saved.
    pub fn new_resource(&self, parent: &str) -> LiveResource {
        LiveResource {
            subject: None,
            parent: parent.to_string(),
            doc: AtomicLoroDoc::new(),
            is_genesis: true,
        }
    }

    /// Fetch a resource from the server and return it as a `LiveResource`
    /// that can be edited and saved.
    pub async fn get_resource(&self, subject: &str) -> AtomicResult<LiveResource> {
        let response = crate::client::fetch_resource(
            subject,
            &self.store,
            self.store.get_default_agent().ok().as_ref(),
        )
        .await?;

        let res = response.to_single();

        // Load the Loro snapshot if present
        let doc = if let Ok(Value::LoroDoc(snapshot)) = res.get(urls::LORO_UPDATE) {
            AtomicLoroDoc::from_snapshot(snapshot)?
        } else {
            // Build a Loro doc from the existing propvals
            let doc = AtomicLoroDoc::new();
            for (prop, val) in res.get_propvals() {
                let _ = doc.set_property(prop, val);
            }
            doc
        };

        Ok(LiveResource {
            subject: Some(res.get_subject().to_string()),
            parent: res
                .get(urls::PARENT)
                .map(|v| v.to_string())
                .unwrap_or_default(),
            doc,
            is_genesis: false,
        })
    }
}

/// A resource being edited locally. Backed by a Loro document.
///
/// Changes are accumulated in the Loro doc. Call `save()` to create a signed
/// commit and post it to the server.
pub struct LiveResource {
    /// The subject URL. None for new resources (assigned on first save via genesis commit).
    subject: Option<String>,
    /// Parent resource (drive) URL.
    parent: String,
    /// The Loro document holding all property state.
    doc: AtomicLoroDoc,
    /// Whether this is a new resource that needs a genesis commit.
    is_genesis: bool,
}

impl LiveResource {
    /// The subject URL of this resource, if it has been saved.
    pub fn subject(&self) -> Option<&str> {
        self.subject.as_deref()
    }

    /// Set a string property.
    pub fn set_string(&self, property: &str, value: &str) -> AtomicResult<()> {
        self.doc.set_property(property, &Value::String(value.into()))
    }

    /// Set the name property.
    pub fn set_name(&self, name: &str) -> AtomicResult<()> {
        self.doc.set_property(urls::NAME, &Value::String(name.into()))
    }

    /// Set a property to a Value.
    pub fn set(&self, property: &str, value: &Value) -> AtomicResult<()> {
        self.doc.set_property(property, value)
    }

    /// Get a string property from the Loro doc.
    pub fn get_string(&self, property: &str) -> Option<String> {
        self.doc.get_string_property(property)
    }

    /// Get the name property.
    pub fn get_name(&self) -> Option<String> {
        self.doc.get_string_property(urls::NAME)
    }

    /// Get an integer property from the Loro doc.
    pub fn get_integer(&self, property: &str) -> Option<i64> {
        self.doc.get_integer_property(property)
    }

    /// Access the internal Loro document (for advanced use / real-time sync).
    pub fn loro_doc(&self) -> &AtomicLoroDoc {
        &self.doc
    }

    /// Save this resource to the server. Creates a genesis commit for new
    /// resources, or a regular commit for existing ones.
    ///
    /// Returns the subject URL of the resource.
    pub async fn save(&mut self, client: &Client, agent: &Agent) -> AtomicResult<String> {
        let store = client.store();
        let update = self.doc.export_snapshot();

        if self.is_genesis {
            // Set parent
            self.doc
                .set_property(urls::PARENT, &Value::AtomicUrl(self.parent.clone().into()))?;

            let full_update = self.doc.export_snapshot();

            let mut builder = CommitBuilder::new("did:ad:placeholder".into());
            builder.is_genesis = true;
            builder.set_loro_update(full_update);

            let resource = Resource::new("did:ad:placeholder".into());
            let commit = Commit::create_did(builder, agent, store).await?;
            let subject = commit.subject.clone();

            crate::client::post_commit(&commit, store).await?;

            self.subject = Some(subject.clone());
            self.is_genesis = false;

            Ok(subject)
        } else {
            let subject = self
                .subject
                .as_ref()
                .ok_or("Cannot save: resource has no subject")?
                .clone();

            let mut builder = CommitBuilder::new(subject.clone());
            builder.set_loro_update(update);

            // Get the last commit for chaining
            let existing = crate::client::fetch_resource(
                &subject,
                store,
                Some(agent),
            )
            .await
            .ok();
            let resource = if let Some(resp) = existing {
                resp.to_single()
            } else {
                Resource::new(subject.clone().into())
            };

            let commit = builder.sign(agent, store, &resource).await?;
            crate::client::post_commit(&commit, store).await?;

            Ok(subject)
        }
    }
}
