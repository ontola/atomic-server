//! Publish an immutable package from an authorized plugin draft.
use crate::{
    appstate::AppState,
    context::RequestContext,
    errors::{AtomicServerError, AtomicServerResult},
    plugins::js_runtime,
};
use actix_web::{web, HttpResponse};
use atomic_lib::{db::plugin_release::PluginRelease, hierarchy::check_read, Storelike};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Publish {
    pub drive: String,
    pub plugin: String,
    #[serde(default)]
    pub schemas: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub standards: Vec<String>,
}

pub async fn publish(
    appstate: web::Data<AppState>,
    body: web::Json<Publish>,
    req: actix_web::HttpRequest,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    create(appstate, body, req, context, true).await
}

pub async fn pin(
    appstate: web::Data<AppState>,
    body: web::Json<Publish>,
    req: actix_web::HttpRequest,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    create(appstate, body, req, context, false).await
}
async fn create(
    appstate: web::Data<AppState>,
    body: web::Json<Publish>,
    req: actix_web::HttpRequest,
    context: RequestContext,
    public: bool,
) -> AtomicServerResult<HttpResponse> {
    let agent = super::plugin_schedule::authorize(&appstate, &req, &context, &body.plugin).await?;
    let source =
        crate::plugins::scheduler::plugin_source(&appstate.store, &body.drive, &body.plugin)
            .await
            .ok_or_else(|| AtomicServerError::bad_request("Plugin has no source"))?;
    let manifest = js_runtime::describe_manifest(&source)
        .await?
        .ok_or_else(|| {
            AtomicServerError::bad_request("Published releases require a versioned manifest")
        })?;
    let host = js_runtime::StoreHost {
        db: std::sync::Arc::new(appstate.store.clone()),
        plugin: body.plugin.clone(),
        drive: body.drive.clone(),
        for_agent: agent.clone(),
        manifest: Some(manifest.clone()),
    };
    host.validate_binding().await?;
    let schemas = match &body.schemas {
        Some(schemas) => schemas.clone(),
        None => {
            crate::plugins::scheduler::plugin_schema_bindings(
                &appstate.store,
                &body.drive,
                &body.plugin,
            )
            .await?
        }
    };
    for subject in schemas.values() {
        let resource = appstate
            .store
            .get_resource(&subject.as_str().into())
            .await?;
        check_read(&appstate.store, &resource, &agent).await?;
    }
    let release = PluginRelease::js(source, serde_json::json!(manifest), schemas);
    for standard in &body.standards {
        let url =
            url::Url::parse(standard).map_err(|e| AtomicServerError::bad_request(e.to_string()))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(AtomicServerError::bad_request(
                "Standards must link to HTTP documentation",
            ));
        }
    }
    let id = appstate.store.publish_plugin_release(&release)?;
    let subject = record(&appstate, &id, &release, &body.drive, &agent, &context).await?;
    let resource = appstate
        .store
        .get_resource(&body.plugin.as_str().into())
        .await?;
    if public {
        appstate.store.publish_plugin_catalog_entry(
            &atomic_lib::db::plugin_release::CatalogEntry {
                release: id.clone(),
                emoji: resource
                    .get("https://atomicdata.dev/properties/emoji")
                    .ok()
                    .map(|v| v.to_string()),
                name: resource
                    .get(atomic_lib::urls::NAME)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| "Plugin".into()),
                description: resource
                    .get(atomic_lib::urls::DESCRIPTION)
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
                publisher: agent.to_string(),
                domains: body.domains.clone(),
                standards: body.standards.clone(),
            },
        )?;
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({"id":id,"subject":subject,"release":release})))
}

/// Records the release as a `Release` resource under the publisher's drive
/// and returns its URL, which an Installation's `release` can point at.
async fn record(
    appstate: &AppState,
    id: &str,
    release: &PluginRelease,
    drive: &str,
    agent: &atomic_lib::agents::ForAgent,
    context: &RequestContext,
) -> AtomicServerResult<String> {
    let publisher = match agent {
        atomic_lib::agents::ForAgent::AgentSubject(subject) => Some(subject.to_string()),
        _ => None,
    };
    let subject = crate::plugins::release::record_release(
        &appstate.store,
        id,
        release,
        drive,
        publisher.as_deref(),
        &context.origin,
    )
    .await?;
    Ok(subject.resolve(&context.origin))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishPackage {
    /// The drive the publisher must be able to write to.
    pub drive: String,
    /// What the publisher believes the world is. The world is read from the
    /// component (a package extending classes is a `server-extension`); when
    /// this is given and disagrees, the publish is refused rather than
    /// mislabeled.
    #[serde(default)]
    pub world: Option<String>,
    /// Also list the release in this server's catalog.
    #[serde(default)]
    pub public: bool,
}

/// Publish a wasip2 release from zip bytes: the body is the zip, validated
/// like an upload, its `plugin.json` translated into the version-two manifest,
/// stored content-addressed, and wrapped in a release whose id covers the
/// package hash and manifest. `atomic-plugin` can publish with one POST
/// instead of producing a file to upload.
pub async fn publish_package(
    appstate: web::Data<AppState>,
    query: web::Query<PublishPackage>,
    body: web::Bytes,
    req: actix_web::HttpRequest,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let agent = super::plugin_schedule::authorize(&appstate, &req, &context, &query.drive).await?;
    let (id, release, manifest) = crate::plugins::release::publish_package(&appstate.store, &body)
        .await
        .map_err(|e| AtomicServerError::bad_request(e.to_string()))?;
    if let Some(claimed) = &query.world {
        if claimed != &release.world {
            return Err(AtomicServerError::bad_request(format!(
                "the package is a {} (its component extends {} classes), not a {claimed}",
                release.world,
                manifest.entrypoints.class_urls().len()
            )));
        }
    }
    let subject = record(&appstate, &id, &release, &query.drive, &agent, &context).await?;
    if query.public {
        appstate.store.publish_plugin_catalog_entry(
            &atomic_lib::db::plugin_release::CatalogEntry {
                release: id.clone(),
                emoji: None,
                name: manifest.name.clone().unwrap_or_else(|| "Plugin".into()),
                description: manifest.description.clone().unwrap_or_default(),
                publisher: agent.to_string(),
                domains: vec![],
                standards: vec![],
            },
        )?;
    }
    Ok(HttpResponse::Ok().json(serde_json::json!({"id":id,"subject":subject,"release":release})))
}

/// Catalog entries are explicitly public; private approval-only packages are absent.
///
/// Still the KV catalog: `Listing` resources exist as a class, but a marketplace
/// container is not configured on the server yet, so they are not merged here.
pub async fn catalog(appstate: web::Data<AppState>) -> AtomicServerResult<HttpResponse> {
    let entries = appstate.store.plugin_catalog()?;
    let entries: Vec<_> = entries
        .into_iter()
        .map(|entry| serde_json::json!({"metadata":entry,"verification":"unverified"}))
        .collect();
    Ok(HttpResponse::Ok().json(entries))
}

/// A release the caller may see: one listed in this server's catalog, or a
/// private one whose `Release` resource the signing agent can read (its
/// publisher's drive), so an Installation view can re-fetch the manifest and
/// runtime it pinned. The read check is the resource's own; there is no
/// separate rule for releases.
async fn readable_release(
    appstate: &AppState,
    req: &actix_web::HttpRequest,
    context: &RequestContext,
    id: &str,
) -> AtomicServerResult<PluginRelease> {
    let store = &appstate.store;
    if store
        .plugin_catalog()?
        .iter()
        .any(|entry| entry.release == id)
    {
        return Ok(store.get_plugin_release(id)?);
    }
    let subject = crate::plugins::release::release_subject(id);
    let Ok(resource) = store.get_resource(&subject).await else {
        return Err(AtomicServerError::bad_request(
            "This package has not been published",
        ));
    };
    let path_and_query = req
        .head()
        .uri
        .path_and_query()
        .ok_or("Path must be given")?
        .to_string();
    let signed_subject =
        atomic_lib::Subject::from_raw(&path_and_query, None).resolve(&context.origin);
    let agent = crate::helpers::get_client_agent(req.headers(), appstate, &signed_subject).await?;
    check_read(store, &resource, &agent).await?;
    Ok(store.get_plugin_release(id)?)
}

/// The release record: source for JS releases, the `package` hash (never the
/// bytes) for wasip2 releases, which `GET /plugin-package/{id}/zip` serves.
pub async fn package(
    appstate: web::Data<AppState>,
    id: web::Path<String>,
    req: actix_web::HttpRequest,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    Ok(HttpResponse::Ok().json(readable_release(&appstate, &req, &context, &id).await?))
}

/// The zip of a published wasip2 release, byte for byte what was published,
/// so a client can verify it against the release's `package` hash.
pub async fn package_zip(
    appstate: web::Data<AppState>,
    id: web::Path<String>,
    req: actix_web::HttpRequest,
    context: RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let release = readable_release(&appstate, &req, &context, &id).await?;
    let Some(package) = release.package.as_deref() else {
        return Err(AtomicServerError::bad_request(
            "This release is a JS release; it has no package",
        ));
    };
    let bytes = crate::plugins::release::package_bytes(&appstate.store, package).await?;
    Ok(HttpResponse::Ok()
        .content_type("application/zip")
        .insert_header(("Cache-Control", "public, max-age=31536000, immutable"))
        .body(bytes))
}
