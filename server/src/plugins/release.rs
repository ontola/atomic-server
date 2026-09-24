//! Resolving the Release an Installation pins, wherever it was published.
//!
//! A Release is content-addressed, so where it comes from does not matter for
//! integrity: the caller recomputes the id and compares it with the pinned one.
//! It can be a release id already in this node's KV cache, a `Release` resource
//! on this node, or a `Release` resource on another server, fetched through the
//! same SSRF-guarded client as a plugin's `downloadURL`. A remote release is
//! cached in the KV store under its id once fetched, so later runs pinned to
//! the id find it locally.

use atomic_lib::{
    agents::ForAgent,
    client::helpers::{fetch_body_untrusted, fetch_bytes_untrusted},
    db::{plugin_meta::PluginManifest, plugin_release::PluginRelease},
    errors::AtomicResult,
    parse::{parse_json_ad_resource, ParseOpts, SaveOpts},
    urls, AtomicError, Db, Resource, Storelike, Subject, Value,
};

use super::manifest::{plugin_json_capabilities, Capability, CapabilityName, Manifest, World};

/// Largest package (zip) fetched from another server.
pub const PACKAGE_MAX_BYTES: usize = 50 * 1024 * 1024;

pub const JSON_AD: &str = "application/ad+json";

/// `reference` is the URL of a `Release` resource, which is what an
/// Installation's `release` is declared to hold, or a bare release id
/// (`blake3:…`).
///
/// The bare id reads this node's release cache and no resource, so it answers
/// for a release that was never recorded. Every publish records a `Release`
/// now and nothing writes a bare id any more, so the branch is here for
/// Installations written before that; keeping it is what lets them keep
/// running.
///
/// The returned release is validated for shape but not yet compared with any
/// pinned id; that is the caller's decision.
pub async fn resolve(
    db: &Db,
    reference: &str,
    for_agent: &ForAgent,
) -> AtomicResult<PluginRelease> {
    if reference.starts_with("blake3:") {
        return db.get_plugin_release(reference);
    }
    let subject = Subject::from_raw(reference, db.get_base_domain().as_deref());
    let release = if subject.is_local() {
        let resource = db
            .get_resource_extended(&subject, false, for_agent)
            .await?
            .to_single();
        let package = local_package(db, &resource, for_agent).await?;
        PluginRelease::from_resource(&resource, package)?
    } else {
        let resource = fetch_remote_resource(reference, db).await?;
        let package = remote_package(db, &resource).await?;
        PluginRelease::from_resource(&resource, package)?
    };
    // Cache under its own id; publishing is idempotent for identical content.
    db.publish_plugin_release(&release)?;
    Ok(release)
}

/// Bytes of a wasip2 package, from this node's blob store.
pub async fn package_bytes(db: &Db, package: &str) -> AtomicResult<Vec<u8>> {
    let hash = package_hash(package)?;
    db.get_blob(&hash)
        .await?
        .ok_or_else(|| AtomicError::from(format!("package blob {package} is not on this node")))
}

fn package_hash(package: &str) -> AtomicResult<Vec<u8>> {
    match hex::decode(package) {
        Ok(hash) if hash.len() == 32 => Ok(hash),
        _ => Err(AtomicError::from(format!(
            "package {package} is not a blake3 hex hash"
        ))),
    }
}

/// Stores zip bytes content-addressed and returns their blake3 hex.
pub async fn store_package(db: &Db, bytes: &[u8]) -> AtomicResult<String> {
    let hash = blake3::hash(bytes);
    if !db.has_blob(hash.as_bytes()).await? {
        db.put_blob(hash.as_bytes(), bytes).await?;
    }
    Ok(hash.to_hex().to_string())
}

fn string_value(resource: &Resource, prop: &str) -> Option<String> {
    match resource.get(prop) {
        Ok(Value::AtomicUrl(s)) => Some(s.to_string()),
        Ok(Value::String(s)) => Some(s.clone()),
        Ok(other) => Some(other.to_string()),
        Err(_) => None,
    }
}

/// The package hash of a local `Release`, read from the File it points at.
async fn local_package(
    db: &Db,
    release: &Resource,
    for_agent: &ForAgent,
) -> AtomicResult<Option<String>> {
    let Some(file) = string_value(release, urls::PACKAGE) else {
        return Ok(None);
    };
    let file = db
        .get_resource_extended(&file.as_str().into(), false, for_agent)
        .await?
        .to_single();
    let internal_id = string_value(&file, urls::INTERNAL_ID)
        .ok_or("the Release's package File has no internalId")?;
    let hash = package_hash(&internal_id)?;
    if !db.has_blob(&hash).await? {
        return Err(AtomicError::from(format!(
            "package blob {internal_id} is not on this node"
        )));
    }
    Ok(Some(internal_id))
}

async fn fetch_remote_resource(url: &str, db: &Db) -> AtomicResult<Resource> {
    let body = fetch_body_untrusted(url, JSON_AD).await?;
    parse_json_ad_resource(
        &body,
        db,
        &ParseOpts {
            save: SaveOpts::DontSave,
            for_agent: ForAgent::Public,
            skip_unknown_props: true,
            ..Default::default()
        },
    )
    .await
}

/// The package of a remote `Release`: fetch its File, download the bytes,
/// verify them against the File's blake3 id and keep them locally.
async fn remote_package(db: &Db, release: &Resource) -> AtomicResult<Option<String>> {
    let Some(file_url) = string_value(release, urls::PACKAGE) else {
        return Ok(None);
    };
    let file = fetch_remote_resource(&file_url, db).await?;
    let internal_id = string_value(&file, urls::INTERNAL_ID)
        .ok_or("the remote package File has no internalId")?;
    let expected = package_hash(&internal_id)?;
    if db.has_blob(&expected).await? {
        return Ok(Some(internal_id));
    }
    let download_url = string_value(&file, urls::DOWNLOAD_URL)
        .ok_or("the remote package File has no downloadURL")?;
    let bytes = fetch_bytes_untrusted(&download_url, PACKAGE_MAX_BYTES).await?;
    if blake3::hash(&bytes).as_bytes() != expected.as_slice() {
        return Err(AtomicError::from(format!(
            "downloaded package does not match the File's hash {internal_id}"
        )));
    }
    db.put_blob(&expected, &bytes).await?;
    Ok(Some(internal_id))
}

/// Publishes a wasip2 release from zip bytes: validated like an upload, its
/// `plugin.json` translated into the version-two manifest (with `world` and
/// the extended classes read from the component itself), the bytes stored
/// content-addressed. Returns the release id, the release and the manifest.
/// Publishing identical bytes twice yields the same id.
///
/// `claimed_world` is what the caller believes the package is. Every reason to
/// refuse is checked before the first write, so a refused publish leaves
/// nothing behind: the blob and the cached release record are only written
/// once the package is going to be published. Callers with nothing to claim
/// pass `None`.
pub async fn publish_package(
    db: &Db,
    bytes: &[u8],
    claimed_world: Option<&str>,
) -> AtomicResult<(String, PluginRelease, Manifest)> {
    use atomic_lib::db::plugin_release::RUNTIME_WASIP2;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec()))
        .map_err(|e| AtomicError::from(format!("Body is not a zip archive: {e}")))?;
    let manifest = crate::plugins::wasm::describe_package(db, &mut zip).await?;
    expect_world(&manifest, claimed_world)?;
    let package = store_package(db, bytes).await?;
    let release = PluginRelease {
        source: None,
        package: Some(package),
        manifest: serde_json::to_value(&manifest)?,
        runtime: RUNTIME_WASIP2.into(),
        world: world_name(manifest.world).into(),
        schemas: Default::default(),
        version: manifest.version.clone(),
        previous_release: None,
    };
    let id = db.publish_plugin_release(&release)?;
    Ok((id, release, manifest))
}

/// The bytes of a `File` resource on this node: its content-addressed blob,
/// or, for a File that only has a `downloadURL`, a capped SSRF-guarded fetch.
pub async fn file_bytes(db: &Db, file_subject: &str) -> AtomicResult<Vec<u8>> {
    let file = db
        .get_resource_extended(&file_subject.into(), false, &ForAgent::Sudo)
        .await?
        .to_single();
    if let Some(internal_id) = string_value(&file, urls::INTERNAL_ID) {
        return package_bytes(db, &internal_id).await;
    }
    let download_url = string_value(&file, urls::DOWNLOAD_URL).ok_or_else(|| {
        AtomicError::from(format!(
            "File {file_subject} has no internalId and no downloadURL"
        ))
    })?;
    fetch_bytes_untrusted(&download_url, PACKAGE_MAX_BYTES).await
}

/// The subject of the `Release` resource that records release `id` on this
/// node: `<server>/releases/<id>`, stable and derivable from the id alone.
pub fn release_subject(id: &str) -> Subject {
    Subject::new_local(&format!("/releases/{id}"), None)
}

/// The subject of the `File` resource holding a package's zip, the same one
/// an upload of the same bytes would have created.
fn package_file_subject(package: &str) -> Subject {
    Subject::new_local(&format!("/files/{package}"), None)
}

/// Records a published release as a `Release` resource under `drive`, so an
/// Installation's `release` can point at a URL (and another server can fetch
/// it) instead of a bare id. A wasip2 release's zip gets a `File` resource
/// under the same drive, reused when the same bytes were uploaded before.
/// Idempotent: a release that is already recorded keeps its drive and its
/// publisher, and a later publisher of the same release is granted read on it
/// and on its package File. Returns the resource's subject.
pub async fn record_release(
    db: &Db,
    id: &str,
    release: &PluginRelease,
    drive: &str,
    publisher: Option<&str>,
    origin: &str,
) -> AtomicResult<Subject> {
    let subject = release_subject(id);
    if let Ok(existing) = db.get_resource(&subject).await {
        // The record lives under the first publisher's drive. Anyone else who
        // publishes the same release holds the same bytes, so they may read
        // it too; without this their Installation, which resolves the release
        // as its signer, is refused.
        if let Some(publisher) = publisher {
            if let Some(file) = string_value(&existing, urls::PACKAGE) {
                if let Ok(file) = db.get_resource(&file.as_str().into()).await {
                    grant_read(db, file, publisher).await?;
                }
            }
            grant_read(db, existing, publisher).await?;
        }
        return Ok(subject);
    }
    let package_file = match &release.package {
        Some(package) => Some(ensure_package_file(db, package, drive, publisher, origin).await?),
        None => None,
    };
    let mut resource = Resource::new(subject.to_string());
    release.write_to_resource(&mut resource, package_file.as_deref())?;
    resource.set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.into()))?;
    if let Some(publisher) = publisher {
        resource.set_unsafe(urls::PUBLISHER.into(), Value::AtomicUrl(publisher.into()))?;
    }
    if let Some(name) = release.manifest.get("name").and_then(|v| v.as_str()) {
        resource.set_unsafe(urls::NAME.into(), Value::String(name.to_string()))?;
    }
    if let Some(description) = release.manifest.get("description").and_then(|v| v.as_str()) {
        resource.set_unsafe(
            urls::DESCRIPTION.into(),
            Value::Markdown(description.to_string()),
        )?;
    }
    resource.save_locally(db).await?;
    Ok(subject)
}

/// Adds `agent` to the resource's `read` rights, when it is not there yet.
async fn grant_read(db: &Db, mut resource: Resource, agent: &str) -> AtomicResult<()> {
    let mut readers = match resource.get(urls::READ) {
        Ok(value) => value.to_subjects(None)?,
        Err(_) => Vec::new(),
    };
    if readers.iter().any(|reader| reader == agent) {
        return Ok(());
    }
    readers.push(agent.to_string());
    resource.set_unsafe(
        urls::READ.into(),
        Value::ResourceArray(readers.iter().map(|r| r.as_str().into()).collect()),
    )?;
    resource.save_locally(db).await?;
    Ok(())
}

/// The `File` resource for a stored package blob, created when missing. An
/// existing File may sit in another drive (the same bytes were uploaded
/// there); the publisher is then granted read on it.
async fn ensure_package_file(
    db: &Db,
    package: &str,
    drive: &str,
    publisher: Option<&str>,
    origin: &str,
) -> AtomicResult<String> {
    let subject = package_file_subject(package);
    if let Ok(existing) = db.get_resource(&subject).await {
        if string_value(&existing, urls::INTERNAL_ID).as_deref() == Some(package) {
            if let Some(publisher) = publisher {
                grant_read(db, existing, publisher).await?;
            }
            return Ok(subject.to_string());
        }
    }
    let size = package_bytes(db, package).await?.len() as i64;
    let mut file = Resource::new(subject.to_string());
    file.set_unsafe(
        urls::IS_A.into(),
        Value::ResourceArray(vec![urls::FILE.into()]),
    )?;
    file.set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.into()))?;
    file.set_unsafe(urls::INTERNAL_ID.into(), Value::String(package.into()))?;
    file.set_unsafe(
        urls::BLOB.into(),
        Value::AtomicUrl(atomic_lib::identifiers::blob_subject(package).into()),
    )?;
    file.set_unsafe(urls::FILESIZE.into(), Value::Integer(size))?;
    file.set_unsafe(
        urls::MIMETYPE.into(),
        Value::String("application/zip".into()),
    )?;
    file.set_unsafe(
        urls::FILENAME.into(),
        Value::String(format!("{package}.zip")),
    )?;
    file.set_unsafe(
        urls::DOWNLOAD_URL.into(),
        Value::String(format!("{origin}/download/files/{package}")),
    )?;
    file.save_locally(db).await?;
    Ok(subject.to_string())
}

/// The subject of the `Listing` resource that lists release `id` in this
/// server's marketplace: `<server>/listings/<id>`, next to `/releases/<id>`.
pub fn listing_subject(id: &str) -> Subject {
    Subject::new_local(&format!("/listings/{id}"), None)
}

/// What a publisher says about a release when listing it in the marketplace.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ListingInput {
    pub name: String,
    pub emoji: Option<String>,
    pub description: String,
    pub domains: Vec<String>,
    /// Links to the documentation of the standards the release implements.
    pub standards: Vec<String>,
}

impl ListingInput {
    /// Name and description from a manifest, for a package that is listed
    /// as it describes itself.
    pub fn from_manifest(manifest: &Manifest) -> Self {
        Self {
            name: manifest.name.clone().unwrap_or_else(|| "Plugin".into()),
            emoji: None,
            description: manifest.description.clone().unwrap_or_default(),
            domains: Vec::new(),
            standards: Vec::new(),
        }
    }

    fn validate(&self) -> AtomicResult<()> {
        for standard in &self.standards {
            let url = url::Url::parse(standard)
                .map_err(|e| AtomicError::from(format!("standard {standard}: {e}")))?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err(AtomicError::from(
                    "Standards must link to HTTP documentation",
                ));
            }
        }
        Ok(())
    }
}

/// A release recorded on this node, and where.
#[derive(Clone, Debug, PartialEq)]
pub struct Published {
    pub id: String,
    /// The `Release` resource.
    pub subject: Subject,
    /// The `Listing` resource, when the release was published publicly.
    pub listing: Option<Subject>,
}

/// Publishes a release on this node: caches it under its id, records it as a
/// `Release` resource under `drive` and, when `listing` is given, lists it
/// publicly. This is the one path behind publishing a JS draft, uploading a
/// zip and pinning a private release; the handlers only differ in how they
/// build the release.
pub async fn publish_release(
    db: &Db,
    release: &PluginRelease,
    drive: &str,
    publisher: Option<&str>,
    origin: &str,
    listing: Option<ListingInput>,
) -> AtomicResult<Published> {
    if let Some(listing) = &listing {
        listing.validate()?;
    }
    let id = db.publish_plugin_release(release)?;
    let subject = record_release(db, &id, release, drive, publisher, origin).await?;
    let listing = match listing {
        Some(listing) => Some(
            record_listing(
                db,
                &id,
                &subject.resolve(origin),
                drive,
                publisher,
                &listing,
            )
            .await?,
        ),
        None => None,
    };
    Ok(Published {
        id,
        subject,
        listing,
    })
}

/// Records a `Listing` for release `id`, readable by everyone: a public
/// publish is a marketplace entry, whatever the drive's own rights say.
/// Idempotent: an existing Listing is left as it is.
pub(crate) async fn record_listing(
    db: &Db,
    id: &str,
    release_url: &str,
    drive: &str,
    publisher: Option<&str>,
    listing: &ListingInput,
) -> AtomicResult<Subject> {
    let subject = listing_subject(id);
    if db.get_resource(&subject).await.is_ok() {
        return Ok(subject);
    }
    let mut resource = Resource::new(subject.to_string());
    resource.set_unsafe(
        urls::IS_A.into(),
        Value::ResourceArray(vec![urls::LISTING.into()]),
    )?;
    resource.set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.into()))?;
    resource.set_unsafe(
        urls::READ.into(),
        Value::ResourceArray(vec![urls::PUBLIC_AGENT.into()]),
    )?;
    resource.set_unsafe(urls::NAME.into(), Value::String(listing.name.clone()))?;
    resource.set_unsafe(
        urls::DESCRIPTION.into(),
        Value::Markdown(listing.description.clone()),
    )?;
    if let Some(emoji) = &listing.emoji {
        resource.set_unsafe(urls::EMOJI.into(), Value::String(emoji.clone()))?;
    }
    if let Some(publisher) = publisher {
        resource.set_unsafe(urls::PUBLISHER.into(), Value::AtomicUrl(publisher.into()))?;
    }
    resource.set_unsafe(
        urls::RELEASE_PROP.into(),
        Value::AtomicUrl(release_url.into()),
    )?;
    resource.set_unsafe(urls::RELEASE_ID.into(), Value::String(id.to_string()))?;
    resource.set_unsafe(
        urls::DOMAINS.into(),
        Value::Json(serde_json::json!(listing.domains)),
    )?;
    resource.set_unsafe(
        urls::STANDARDS.into(),
        Value::ResourceArray(
            listing
                .standards
                .iter()
                .map(|s| s.as_str().into())
                .collect(),
        ),
    )?;
    resource.save_locally(db).await?;
    Ok(subject)
}

/// Whether release `id` is listed in this server's marketplace, that is,
/// whether it has a Listing the public can read.
pub async fn is_listed(db: &Db, id: &str) -> bool {
    match db.get_resource(&listing_subject(id)).await {
        Ok(listing) => atomic_lib::hierarchy::check_read(db, &listing, &ForAgent::Public)
            .await
            .is_ok(),
        Err(_) => false,
    }
}

/// Refuses a publish whose caller believes the package is one world when the
/// component says another, rather than mislabeling it.
///
/// Read from the manifest rather than from the release, so that
/// [`publish_package`] can ask before it has anything to store.
pub fn expect_world(manifest: &Manifest, claimed: Option<&str>) -> AtomicResult<()> {
    let actual = world_name(manifest.world);
    match claimed {
        Some(claimed) if claimed != actual => Err(AtomicError::from(format!(
            "the package is a {actual} (its component extends {} classes), but the publish claimed {claimed}",
            manifest.entrypoints.class_urls().len()
        ))),
        _ => Ok(()),
    }
}

/// The release record's spelling of a manifest world.
pub fn world_name(world: World) -> &'static str {
    use atomic_lib::db::plugin_release::{WORLD_EXTENSION, WORLD_SERVER_EXTENSION};
    match world {
        World::Extension => WORLD_EXTENSION,
        World::ServerExtension => WORLD_SERVER_EXTENSION,
    }
}

/// The capabilities a release manifest declares, with their reasons.
///
/// A release manifest is the version-two form, or a version-one JS manifest
/// (which declares none). A manifest without `schemaVersion` is a legacy
/// `plugin.json` stored by an earlier publish; its permissions are read the
/// way translation reads them, so old releases keep installing.
pub fn declared_capabilities(manifest: &serde_json::Value) -> AtomicResult<Vec<Capability>> {
    match Manifest::parse(manifest.clone()) {
        Ok(Some(parsed)) => Ok(parsed.capabilities),
        Ok(None) => {
            let plugin_json: PluginManifest =
                serde_json::from_value(manifest.clone()).map_err(|e| {
                    AtomicError::from(format!("release manifest is not a plugin manifest: {e}"))
                })?;
            Ok(plugin_json_capabilities(&plugin_json))
        }
        Err(e) => Err(AtomicError::from(format!(
            "release manifest is invalid: {e}"
        ))),
    }
}

/// The set of capabilities an Installation grants must be exactly the set its
/// release declares.
///
/// A grant the manifest never asked for is refused, since nothing would use
/// it. A declared capability that was not granted is refused too, naming each
/// missing capability with the reason the manifest gives for it: the review
/// UI shows the reasons, the server enforces the set. `network.origins` and
/// `secrets` are shown at review but not granted here; the host enforces them
/// from the manifest at every fetch.
///
/// `grants` is a JSON array of capability names, an object keyed by them, or
/// null (no grants). The Installation stores them as the approved set. Either
/// form may also carry the route grant
/// ([`super::manifest_http::ROUTE_WRITES_GRANT`]). That is not a capability:
/// it is checked against the release's write targets instead.
pub fn check_grants(manifest: &serde_json::Value, grants: &serde_json::Value) -> AtomicResult<()> {
    use super::manifest_http::{check_route_grant, is_route_grant_element, ROUTE_WRITES_GRANT};
    let declared = declared_capabilities(manifest)?;
    let http = match Manifest::parse(manifest.clone()) {
        Ok(Some(parsed)) => parsed.http,
        _ => None,
    };
    check_route_grant(http.as_ref(), grants).map_err(AtomicError::from)?;
    let granted: Vec<String> = match grants {
        serde_json::Value::Null => Vec::new(),
        serde_json::Value::Array(items) => items
            .iter()
            .filter(|item| !is_route_grant_element(item))
            .map(|item| match item {
                serde_json::Value::String(s) => Ok(s.clone()),
                other => Err(AtomicError::from(format!(
                    "grant {other} is not a capability name"
                ))),
            })
            .collect::<AtomicResult<_>>()?,
        serde_json::Value::Object(map) => map
            .keys()
            .filter(|key| *key != ROUTE_WRITES_GRANT)
            .cloned()
            .collect(),
        other => {
            return Err(AtomicError::from(format!(
                "grants must be a JSON array or object, got {other}"
            )))
        }
    };
    for grant in &granted {
        let known = CapabilityName::parse(grant);
        if !known.is_some_and(|name| declared.iter().any(|c| c.name == name)) {
            return Err(AtomicError::from(format!(
                "grant '{grant}' is not declared by the plugin manifest"
            )));
        }
    }
    let missing: Vec<String> = declared
        .iter()
        .filter(|c| !granted.iter().any(|g| g == c.name.as_str()))
        .map(|c| match &c.reason {
            Some(reason) => format!("{} ({reason})", c.name.as_str()),
            None => c.name.as_str().to_string(),
        })
        .collect();
    if !missing.is_empty() {
        return Err(AtomicError::from(format!(
            "the Installation does not grant every capability the plugin declares; missing: {}",
            missing.join(", ")
        )));
    }
    Ok(())
}

/// Why this node can't run a release's public endpoints, if it can't (design
/// 0.4). A version-one or version-two manifest, and a legacy `plugin.json`,
/// need no gate.
pub fn gate_refusal(
    manifest: &serde_json::Value,
    node: &crate::plugin_routes::PluginRoutesConfig,
) -> AtomicResult<Option<super::manifest_http::HostFeatureUnavailable>> {
    match Manifest::parse(manifest.clone()) {
        Ok(Some(parsed)) => Ok(parsed.gate().check(node).err()),
        Ok(None) => Ok(None),
        Err(e) => Err(AtomicError::from(format!(
            "release manifest is invalid: {e}"
        ))),
    }
}

/// Refuses, with the message of design 0.4, a release that needs gates this
/// node does not open. Checked at install, upgrade and resume, so an upgrade
/// that raises the needed level is refused and the old release keeps running.
///
/// The error is a commit error, so it carries the typed problem the way
/// commit errors can: appended to the message after
/// [`atomic_lib::sync::protocol::PROBLEM_MARKER`]. Both wire paths then
/// classify it as `HOST_FEATURE_UNAVAILABLE` (the `/commit` response as
/// `409`), and `@tomic/lib` raises `HostFeatureUnavailableError` from it, as
/// it does for the `409` of `/plugin-release-pin`.
pub fn check_host_features(
    manifest: &serde_json::Value,
    node: &crate::plugin_routes::PluginRoutesConfig,
) -> AtomicResult<()> {
    match gate_refusal(manifest, node)? {
        Some(refusal) => Err(AtomicError::from(host_feature_commit_error(&refusal))),
        None => Ok(()),
    }
}

/// The commit error message for a gate refusal: the sentence of design 0.4,
/// then the typed problem (with `detail`, as `/plugin-release-pin` sends it).
pub fn host_feature_commit_error(refusal: &super::manifest_http::HostFeatureUnavailable) -> String {
    let message = refusal.message();
    let mut problem = refusal.to_json();
    problem["detail"] = message.clone().into();
    atomic_lib::sync::protocol::with_problem(&message, &problem)
}

/// What a catalog entry says a release needs, as JSON: the derived list; null
/// for a manifest without versioned declarations (a legacy `plugin.json`),
/// which needs no gate; or [`REQUIRES_UNKNOWN`] for a manifest this node can't
/// parse.
pub fn catalog_requires(manifest: &serde_json::Value) -> serde_json::Value {
    match Manifest::parse(manifest.clone()) {
        Ok(Some(parsed)) => serde_json::json!(parsed.requires()),
        Ok(None) => serde_json::Value::Null,
        Err(_) => REQUIRES_UNKNOWN.into(),
    }
}

/// The `requires` of a catalog entry whose release this node couldn't read
/// or verify. A client treats it conservatively: it marks the entry, never
/// hides it, and the review reads the manifest before anything is installed.
pub const REQUIRES_UNKNOWN: &str = "unknown";

/// How long `/plugin-catalog` waits for another server's `Release` resource
/// (and its package `File`) before answering `requires: "unknown"`.
pub const REMOTE_RELEASE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// How many remote `Release` resources one `/plugin-catalog` request fetches,
/// concurrently. Entries past the budget answer `requires: "unknown"`, so a
/// catalog of remote listings costs at most one timeout, not one per entry.
pub const REMOTE_RELEASE_BUDGET: usize = 4;

/// A listed release that is not in this node's cache, read from the `Release`
/// resource its Listing points at and verified against the listed id, without
/// caching it or fetching its package bytes. The id covers the manifest, so a
/// record that hashes to `release_id` carries the manifest `requires` is
/// derived from. `None` when the resource can't be read in time, doesn't
/// describe a release, or hashes to another id.
///
/// A local `Release` is read directly: it belongs to a public Listing, and
/// only what the catalog shows of it leaves this node. A remote one is fetched
/// through the SSRF-guarded client, within [`REMOTE_RELEASE_TIMEOUT`], and
/// only when `fetch_remote` (the request's [`REMOTE_RELEASE_BUDGET`]).
pub async fn uncached_release(
    db: &Db,
    reference: &str,
    release_id: &str,
    fetch_remote: bool,
) -> Option<PluginRelease> {
    let subject = Subject::from_raw(reference, db.get_base_domain().as_deref());
    let release = if subject.is_local() {
        let resource = db.get_resource(&subject).await.ok()?;
        let package = match string_value(&resource, urls::PACKAGE) {
            Some(file) => {
                let file = db.get_resource(&file.as_str().into()).await.ok()?;
                Some(string_value(&file, urls::INTERNAL_ID)?)
            }
            None => None,
        };
        PluginRelease::from_resource(&resource, package).ok()?
    } else if fetch_remote {
        let fetch = async {
            let resource = fetch_remote_resource(reference, db).await.ok()?;
            let package = match string_value(&resource, urls::PACKAGE) {
                Some(file_url) => {
                    let file = fetch_remote_resource(&file_url, db).await.ok()?;
                    Some(string_value(&file, urls::INTERNAL_ID)?)
                }
                None => None,
            };
            PluginRelease::from_resource(&resource, package).ok()
        };
        tokio::time::timeout(REMOTE_RELEASE_TIMEOUT, fetch)
            .await
            .ok()
            .flatten()?
    } else {
        return None;
    };
    (release.id().ok()? == release_id).then_some(release)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_route_grant_must_cover_every_write_target() {
        let inbox: serde_json::Value = serde_json::from_str(include_str!(
            "../../../testdata/plugin-routes/inbox/manifest.json"
        ))
        .unwrap();
        let targets = inbox["http"]["writeTargets"].clone();
        // Array form (an object element) and object form; or no grant at all.
        check_grants(&inbox, &json!(["storage", {"route-writes": targets}])).unwrap();
        check_grants(&inbox, &json!({"storage": true, "route-writes": targets})).unwrap();
        check_grants(&inbox, &json!(["storage"])).unwrap();
        // A grant for fewer classes than the release asks: a widened upgrade.
        let mut narrower = targets.clone();
        narrower[0]["classes"] = json!([]);
        let err = check_grants(&inbox, &json!(["storage", {"route-writes": narrower}]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("does not cover (inbox-items)"), "{err}");
        // Not a list of targets.
        assert!(check_grants(&inbox, &json!(["storage", {"route-writes": "yes"}])).is_err());
        // Anything else that is not a capability is still refused.
        assert!(check_grants(&inbox, &json!(["storage", {"other": []}])).is_err());
    }

    fn v2() -> serde_json::Value {
        json!({
            "schemaVersion": 2,
            "capabilities": [
                {"name": "storage", "reason": "keeps a cursor"},
                "extended-fuel"
            ]
        })
    }

    #[test]
    fn the_granted_set_must_equal_the_declared_set() {
        check_grants(&v2(), &json!(["storage", "extended-fuel"])).unwrap();
        check_grants(&v2(), &json!({"storage": true, "extended-fuel": true})).unwrap();
        // Order does not matter.
        check_grants(&v2(), &json!(["extended-fuel", "storage"])).unwrap();
    }

    #[test]
    fn a_missing_grant_is_refused_with_its_reason() {
        let err = check_grants(&v2(), &json!(["extended-fuel"]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("missing: storage (keeps a cursor)"), "{err}");
        let err = check_grants(&v2(), &json!(null)).unwrap_err().to_string();
        assert!(err.contains("storage (keeps a cursor)"), "{err}");
        assert!(err.contains("extended-fuel"), "{err}");
    }

    #[test]
    fn an_undeclared_or_unknown_grant_is_refused() {
        let err = check_grants(
            &v2(),
            &json!(["storage", "extended-fuel", "full-drive-access"]),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("'full-drive-access' is not declared"), "{err}");
        assert!(check_grants(&v2(), &json!(["storage", "extended-fuel", "root"])).is_err());
        assert!(check_grants(&v2(), &json!("storage")).is_err());
        assert!(check_grants(&v2(), &json!([1])).is_err());
    }

    #[test]
    fn a_manifest_declaring_nothing_accepts_only_no_grants() {
        check_grants(&json!({"schemaVersion": 1}), &json!(null)).unwrap();
        check_grants(&json!({"schemaVersion": 1}), &json!([])).unwrap();
        check_grants(&json!({"schemaVersion": 2}), &json!({})).unwrap();
        assert!(check_grants(&json!({"schemaVersion": 1}), &json!(["storage"])).is_err());
        // A version-one manifest has no capability field at all.
        assert!(check_grants(
            &json!({"schemaVersion": 1, "capabilities": ["storage"]}),
            &json!(["storage"])
        )
        .is_err());
    }

    #[test]
    fn a_legacy_plugin_json_release_reads_its_permissions() {
        let plugin_json = json!({
            "name": "legacy", "namespace": "acme", "version": "1.0.0",
            "permissions": [
                {"permission": "storage", "reason": "state"},
                {"permission": "network", "reason": "not a capability"}
            ],
            "network": {"origins": ["https://api.test"]}
        });
        check_grants(&plugin_json, &json!(["storage"])).unwrap();
        let err = check_grants(&plugin_json, &json!([]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("storage (state)"), "{err}");
        assert!(check_grants(&plugin_json, &json!(["storage", "network"])).is_err());
        assert!(check_grants(&json!({"not": "a manifest"}), &json!(null)).is_err());
    }

    #[test]
    fn an_upgraded_v1_manifest_keeps_the_release_id() {
        // A JS release published from a version-one draft stored the struct's
        // serialization: `schemaVersion`, `secrets` and `operations`, nothing
        // else. Parsing it into the version-two model and serializing again
        // must give the same bytes, or every existing release id would move.
        let raw = json!({"schemaVersion": 1});
        let upgraded = serde_json::json!(Manifest::parse(raw).unwrap().unwrap());
        assert_eq!(
            upgraded,
            json!({"schemaVersion": 1, "secrets": [], "operations": []})
        );
        let source = "export function run() { return {}; }".to_string();
        let before = PluginRelease::js(
            source.clone(),
            json!({"schemaVersion": 1, "secrets": [], "operations": []}),
            Default::default(),
        );
        let after = PluginRelease::js(source, upgraded, Default::default());
        assert_eq!(before.id().unwrap(), after.id().unwrap());

        let full = json!({
            "schemaVersion": 1,
            "secrets": [{"name": "token", "origin": "https://api.test"}],
            "operations": [
                {"id": "list", "method": "GET", "url": "https://api.test/items", "effect": "read"}
            ]
        });
        let again = serde_json::json!(Manifest::parse(full.clone()).unwrap().unwrap());
        assert_eq!(again, full);
    }

    #[test]
    fn accepts_without_as_keeps_the_release_id() {
        // `as` is optional and text by default. A manifest that leaves it out,
        // and one written for #1691 that spells out `"as": "text"`, must both
        // serialize to exactly what was published.
        let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/../testdata/plugin-manifest");
        for file in [
            "v2-accepts-default-text.json",
            "v2-accepts-destination.json",
        ] {
            let path = format!("{fixtures}/{file}");
            let raw: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let parsed = serde_json::json!(Manifest::parse(raw.clone()).unwrap().unwrap());
            let source = "export function run() { return {}; }".to_string();
            let before = PluginRelease::js(source.clone(), raw.clone(), Default::default());
            let after = PluginRelease::js(source, parsed.clone(), Default::default());
            assert_eq!(before.id().unwrap(), after.id().unwrap(), "{file}");
            assert_eq!(
                parsed["accepts"][0].get("as"),
                raw["accepts"][0].get("as"),
                "{file}"
            );
        }
    }

    #[test]
    fn package_hashes_are_blake3_hex() {
        assert!(package_hash(&"ab".repeat(32)).is_ok());
        assert!(package_hash("ab").is_err());
        assert!(package_hash(&"zz".repeat(32)).is_err());
    }
}
