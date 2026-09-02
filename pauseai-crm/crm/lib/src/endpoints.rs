//! Endpoints are experimental plugin-like objects, that allow for dynamic resources.
//! An endpoint is a resource that accepts one or more query parameters, and returns a resource that is probably calculated at runtime.
//! Examples of endpoints are versions for resources, or (pages for) collections.
//! See https://docs.atomicdata.dev/endpoints.html or https://atomicdata.dev/classes/Endpoint

use crate::{
    agents::ForAgent, errors::AtomicResult, storelike::ResourceResponse, urls, Db, Resource,
    Storelike, Value,
};
use std::sync::Arc;

pub use crate::plugins::BoxFuture;

/// The function that is called when a GET request matches the path.
/// This is a closure rather than a plain fn pointer, so handlers can capture
/// state they need (config, handles to running services) at registration time.
pub type HandleGet = Arc<
    dyn for<'a> Fn(HandleGetContext<'a>) -> BoxFuture<'a, AtomicResult<ResourceResponse>>
        + Send
        + Sync,
>;

/// The function that is called when a POST request matches the path.
pub type HandlePost = Arc<
    dyn for<'a> Fn(HandlePostContext<'a>) -> BoxFuture<'a, AtomicResult<ResourceResponse>>
        + Send
        + Sync,
>;

/// Passed to an Endpoint GET request handler.
#[derive(Debug)]
pub struct HandleGetContext<'a> {
    /// The requested URL, including query parameters
    pub subject: url::Url,
    pub store: &'a Db,
    pub for_agent: &'a ForAgent,
}

/// Passed to an Endpoint POST request handler for.
#[derive(Debug)]
pub struct HandlePostContext<'a> {
    /// The requested URL, including query parameters
    pub subject: url::Url,
    pub store: &'a Db,
    pub for_agent: &'a ForAgent,
    pub body: Vec<u8>,
}
/// An API endpoint at some path which accepts requests and returns some Resource.
#[derive(Clone)]
pub struct Endpoint {
    /// The part behind the server domain, e.g. '/versions' or '/collections'. Include the slash.
    pub path: String,
    /// Called when a GET request matches the path.
    /// If none is given, the endpoint will return the basic Endpoint resource.
    pub handle: Option<HandleGet>,
    /// Called when a POST request matches the path.
    pub handle_post: Option<HandlePost>,
    /// The list of properties that can be passed to the Endpoint as Query parameters
    pub params: Vec<String>,
    pub description: String,
    pub shortname: String,
    /// Query keys the GET handler cannot work without. When any is absent, the
    /// Endpoint resource itself is returned — which clients render as a form to
    /// fill in — instead of calling the handler. See [EndpointBuilder::form_when_missing].
    pub form_when_missing: Vec<String>,
}

/// Builds an [Endpoint]. The path is the endpoint's identity, so it is required;
/// everything else is optional and chained on. The shortname defaults to the path
/// without its leading slash.
pub struct EndpointBuilder {
    path: String,
    handle: Option<HandleGet>,
    handle_post: Option<HandlePost>,
    params: Vec<String>,
    description: String,
    shortname: Option<String>,
    form_when_missing: Vec<String>,
}

impl EndpointBuilder {
    fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            handle: None,
            handle_post: None,
            params: Vec::new(),
            description: String::new(),
            shortname: None,
            form_when_missing: Vec::new(),
        }
    }

    /// The query keys the GET handler cannot work without, e.g. `["subject"]`.
    /// When any of them is missing from the request, the Endpoint resource is
    /// returned instead of calling the handler — clients render that as a form.
    ///
    /// These are the query keys the handler reads, not the property URLs in
    /// [Self::params]; a handler asking for `?commit=` needs `"commit"` here.
    pub fn form_when_missing(mut self, keys: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.form_when_missing = keys.into_iter().map(Into::into).collect();
        self
    }

    /// Overrides the shortname, which defaults to the path without its leading slash.
    pub fn shortname(mut self, shortname: impl Into<String>) -> Self {
        self.shortname = Some(shortname.into());
        self
    }

    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }

    /// The properties that can be passed to the Endpoint as query parameters.
    pub fn params(mut self, params: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.params = params.into_iter().map(Into::into).collect();
        self
    }

    /// Called when a GET request matches the path.
    /// If none is set, the endpoint returns the basic Endpoint resource.
    pub fn handle<F>(mut self, handler: F) -> Self
    where
        F: for<'a> Fn(HandleGetContext<'a>) -> BoxFuture<'a, AtomicResult<ResourceResponse>>
            + Send
            + Sync
            + 'static,
    {
        self.handle = Some(Arc::new(handler));
        self
    }

    /// Called when a POST request matches the path.
    pub fn handle_post<F>(mut self, handler: F) -> Self
    where
        F: for<'a> Fn(HandlePostContext<'a>) -> BoxFuture<'a, AtomicResult<ResourceResponse>>
            + Send
            + Sync
            + 'static,
    {
        self.handle_post = Some(Arc::new(handler));
        self
    }

    pub fn build(self) -> Endpoint {
        let shortname = self
            .shortname
            .unwrap_or_else(|| self.path.trim_start_matches('/').to_string());
        Endpoint {
            path: self.path,
            handle: self.handle,
            handle_post: self.handle_post,
            params: self.params,
            description: self.description,
            shortname,
            form_when_missing: self.form_when_missing,
        }
    }
}

impl Endpoint {
    /// Start building an Endpoint served at `path`, e.g. `/versions`. Include the slash.
    pub fn builder(path: impl Into<String>) -> EndpointBuilder {
        EndpointBuilder::new(path)
    }

    /// Converts Endpoint to resource. Does not save it.
    pub async fn to_resource(
        &self,
        store: &impl Storelike,
        subject: &str,
    ) -> AtomicResult<Resource> {
        let mut resource = Resource::new(subject.to_string());
        resource
            .set_string(urls::DESCRIPTION.into(), &self.description, store)
            .await?;
        resource
            .set_string(urls::SHORTNAME.into(), &self.shortname, store)
            .await?;
        let is_a = [urls::ENDPOINT.to_string()].to_vec();
        resource.set(urls::IS_A.into(), is_a.into(), store).await?;
        let params_vec: Vec<String> = self.params.clone();
        resource
            .set(
                urls::ENDPOINT_PARAMETERS.into(),
                Value::from(params_vec),
                store,
            )
            .await?;
        if self.handle_post.is_some() {
            resource
                .set(urls::ENDPOINT_IS_POST.into(), Value::Boolean(true), store)
                .await?;
        }
        Ok(resource)
    }

    pub async fn to_resource_response(
        &self,
        store: &impl Storelike,
        subject: &str,
    ) -> AtomicResult<ResourceResponse> {
        let resource = self.to_resource(store, subject).await?;
        Ok(resource.into())
    }
}
