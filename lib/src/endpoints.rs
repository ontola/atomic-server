//! Endpoints are experimental plugin-like objects, that allow for dynamic resources.
//! An endpoint is a resource that accepts one or more query parameters, and returns a resource that is probably calculated at runtime.
//! Examples of endpoints are versions for resources, or (pages for) collections.
//! See https://docs.atomicdata.dev/endpoints.html or https://atomicdata.dev/classes/Endpoint

use crate::{
    agents::ForAgent, errors::AtomicResult, storelike::ResourceResponse, urls, Db, Resource,
    Storelike, Value,
};
use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The function that is called when a GET request matches the path
pub type HandleGet =
    for<'a> fn(context: HandleGetContext<'a>) -> BoxFuture<'a, AtomicResult<ResourceResponse>>;

/// The function that is called when a POST request matches the path
pub type HandlePost =
    for<'a> fn(context: HandlePostContext<'a>) -> BoxFuture<'a, AtomicResult<ResourceResponse>>;

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
}

pub struct PostEndpoint {
    pub path: String,
    pub handle: Option<HandlePost>,
    pub params: Vec<String>,
    pub description: String,
    pub shortname: String,
}

impl Endpoint {
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
