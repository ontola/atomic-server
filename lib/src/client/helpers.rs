//! Functions for interacting with an Atomic Server
use crate::{
    agents::Agent,
    commit::sign_message,
    errors::AtomicResult,
    parse::{parse_json_ad_string, ParseOpts},
    storelike::ResourceResponse,
    Resource, Storelike, Subject,
};

#[cfg(not(target_arch = "wasm32"))]
fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(10))
}

#[cfg(target_arch = "wasm32")]
fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
}

/// Fetches a resource, makes sure its subject matches.
/// Checks the datatypes for the Values.
/// Ignores all atoms where the subject is different.
/// WARNING: Calls store methods, and is called by store methods, might get stuck in a loop!
#[tracing::instrument(skip_all)]
pub async fn fetch_resource(
    subject: &str,
    store: &impl Storelike,
    client_agent: Option<&Agent>,
) -> AtomicResult<ResourceResponse> {
    let subject_obj = Subject::from_raw(subject, store.get_base_domain().as_deref());
    let url = if subject_obj.is_did() {
        // Route DID requests through the server's normal resource endpoint.
        // The server's catch-all GET handler parses the DID from the path
        // and resolves it locally or via DHT.
        let server = store.get_server_url();
        format!("{}/{}", server.trim_end_matches('/'), subject)
    } else {
        subject.to_string()
    };

    // DID agents are not understood by old/external servers (they can't resolve
    // `did:ad:agent:` to fetch the public key). Only sign requests to our own server.
    let effective_agent = match client_agent {
        Some(agent) if agent.subject.is_did() => {
            let server = store.get_server_url();
            if url.starts_with(server.trim_end_matches('/')) {
                client_agent
            } else {
                None
            }
        }
        _ => client_agent,
    };

    let body = fetch_body(&url, crate::parse::JSON_AD_MIME, effective_agent).await?;
    let resources = Box::pin(parse_json_ad_string(&body, store, &ParseOpts::default()))
        .await
        .map_err(|e| format!("Error parsing body of {}. {}", subject, e))?;

    if resources.len() == 1 {
        Ok(ResourceResponse::Resource(resources[0].clone()))
    } else {
        let mut main_resource: Option<Resource> = None;
        let mut referenced: Vec<Resource> = Vec::new();

        let pure_subject = if subject_obj.is_did() {
            subject_obj.pure_id()
        } else {
            subject.to_string()
        };

        for r in resources {
            if r.get_subject_enum().pure_id() == pure_subject {
                main_resource = Some(r);
            } else {
                referenced.push(r);
            }
        }

        let Some(main_resource) = main_resource else {
            return Err(format!(
                "Requested subject not found in returned resources: {}",
                subject
            )
            .into());
        };

        Ok(ResourceResponse::ResourceWithReferenced(
            main_resource,
            referenced,
        ))
    }
}

/// Returns the various x-atomic authentication headers, includign agent signature
pub fn get_authentication_headers(url: &str, agent: &Agent) -> AtomicResult<Vec<(String, String)>> {
    let mut headers = Vec::new();
    let now = crate::utils::now().to_string();
    let message = format!("{} {}", url, now);
    let signature = sign_message(
        &message,
        agent
            .private_key
            .as_ref()
            .ok_or("No private key in agent")?,
        &agent.public_key,
    )?;
    headers.push(("x-atomic-public-key".into(), agent.public_key.to_string()));
    headers.push(("x-atomic-signature".into(), signature));
    headers.push(("x-atomic-timestamp".into(), now));
    headers.push(("x-atomic-agent".into(), agent.subject.to_string()));
    Ok(headers)
}

/// Fetches a URL, returns its body.
/// Uses the store's Agent agent (if set) to sign the request.
#[tracing::instrument(skip_all)]
pub async fn fetch_body(
    url: &str,
    content_type: &str,
    client_agent: Option<&Agent>,
) -> AtomicResult<String> {
    if !url.starts_with("http") {
        return Err(format!("Could not fetch url '{}', must start with http.", url).into());
    }

    let client = http_client_builder()
        .build()
        .map_err(|e| format!("Could not build HTTP client: {}", e))?;

    let mut req = client.get(url).header("Accept", content_type);
    if let Some(agent) = client_agent {
        if should_sign_request(url, agent) {
            let headers = get_authentication_headers(url, agent)?;
            for (key, value) in headers {
                req = req.header(key, value);
            }
        } else {
            tracing::warn!(
                "Skipping signed auth headers for cross-origin fetch. url={}, agent={}",
                url,
                agent.subject
            );
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Error when fetching {}: {}", url, e))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Could not parse HTTP response for {}: {}", url, e))?;
    if status != 200 {
        return Err(format!(
            "Could not fetch url '{}'. Status: {}. Body: {}",
            url, status, body
        )
        .into());
    };
    crate::metrics::external_fetch();
    Ok(body)
}

fn should_sign_request(url: &str, agent: &Agent) -> bool {
    // DID agents can be verified without fetching an HTTP subject.
    if agent.subject.is_did() {
        return true;
    }

    let Ok(target) = url::Url::parse(url) else {
        return false;
    };

    let Ok(agent_url) = url::Url::parse(agent.subject.as_str()) else {
        return false;
    };

    target.scheme() == agent_url.scheme()
        && target.host_str() == agent_url.host_str()
        && target.port_or_known_default() == agent_url.port_or_known_default()
}

/// JSON-AD body for posting a commit (HTTP or WS). Includes signature; omits `@id`.
pub async fn commit_to_wire_json(
    commit: &crate::Commit,
    store: &impl Storelike,
) -> AtomicResult<String> {
    let mut json_val: serde_json::Value =
        serde_json::from_str(&commit.into_resource(store).await?.to_json_ad(None)?)?;
    if let Some(obj) = json_val.as_object_mut() {
        obj.remove("@id");
    }
    Ok(serde_json::to_string(&json_val)?)
}

/// Posts a Commit to the endpoint of the Subject from the Commit
pub async fn post_commit(commit: &crate::Commit, store: &impl Storelike) -> AtomicResult<()> {
    let subject_str = commit.get_subject();
    let subject = Subject::from_raw(subject_str.as_str(), store.get_base_domain().as_deref());
    let server_url = if subject.is_did() {
        let mut url = store.get_server_url().to_string();
        if !url.ends_with('/') {
            url.push('/');
        }
        url
    } else {
        crate::utils::server_url(subject_str.as_str())?
    };
    // Default Commit endpoint is `https://example.com/commit`
    let endpoint = format!("{}commit", server_url);
    post_commit_custom_endpoint(&endpoint, commit, store).await
}

/// Posts a Commit to an endpoint
/// Default commit endpoint is `https://example.com/commit`
async fn post_commit_custom_endpoint(
    endpoint: &str,
    commit: &crate::Commit,
    store: &impl Storelike,
) -> AtomicResult<()> {
    let json = commit_to_wire_json(commit, store).await?;

    let client = http_client_builder()
        .build()
        .map_err(|e| format!("Could not build HTTP client: {}", e))?;

    let resp = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .body(json)
        .send()
        .await
        .map_err(|e| format!("Error when posting commit to {}: {}", endpoint, e))?;

    let status = resp.status().as_u16();
    if status != 200 {
        let body = resp.text().await.unwrap_or_default();
        Err(format!(
            "Failed applying commit to {}. Status: {} Body: {}",
            endpoint, status, body
        )
        .into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn fetch_resource_basic() {
        let store = crate::Store::init().await.unwrap();
        let resource = fetch_resource(crate::urls::SHORTNAME, &store, None)
            .await
            .unwrap()
            .to_single();

        let shortname = resource.get(crate::urls::SHORTNAME).unwrap();
        assert!(shortname.to_string() == "shortname");
    }

    #[tokio::test]
    #[ignore]
    async fn post_commit_basic() {
        // let store = Store::init().unwrap();
        // // TODO actually make this work
        // let commit = crate::commit::CommitBuilder::new("subject".into())
        //     .sign(&agent)
        //     .unwrap();
        // post_commit(&commit).unwrap();
    }
}
