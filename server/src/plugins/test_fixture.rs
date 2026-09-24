//! A drive with the plugin vocabulary on it, for tests that need one.
//!
//! The browser creates this through `ensureSchema`; here it is built by hand,
//! because what these tests exercise is what the *server* does with a drive
//! that already has one. Shared between the scheduler and the trigger
//! listener, which need the same drive and would otherwise each grow their own
//! slightly different copy of it.

use std::collections::HashMap;

use atomic_lib::{urls, Db, Resource, Storelike, Value};

use crate::appstate::AppState;
use crate::plugins::scheduler::DriveTerms;

/// A drive with the plugin vocabulary on it.
///
/// The browser creates this through `ensureSchema`; here it is built by
/// hand, because the thing under test is what the server does with a drive
/// that already has one.
///
/// Everything is created through a genesis commit, the way a real drive
/// does it: a fresh server's drive is a DID, and resources under it are
/// identified by signature rather than by path.
pub struct Fixture {
    pub appstate: AppState,
    pub drive: String,
    pub plugin: String,
    pub terms: DriveTerms,
}

/// Creates a resource under a DID parent and returns the subject it got.
pub async fn genesis(store: &Db, propvals: Vec<(&str, Value)>) -> String {
    let mut resource = Resource::new("did:ad:placeholder".into());

    for (property, value) in propvals {
        resource.set_unsafe(property.into(), value).unwrap();
    }

    resource.save_as_genesis(store).await.unwrap();

    resource.get_subject().to_string()
}

pub async fn fixture(name: &str) -> Fixture {
    fixture_with_args(name, &[]).await
}

/// [`fixture`] with extra command-line options, e.g. `--plugin-routes read-only`.
pub async fn fixture_with_args(name: &str, extra_args: &[&str]) -> Fixture {
    use clap::Parser;

    let unique = format!("{name}_{}", atomic_lib::utils::random_string(10));
    let data_dir = format!("./.temp/{unique}/db");
    let config_dir = format!("./.temp/{unique}/config");
    let mut args = vec![
        "atomic-server",
        "--initialize",
        "--data-dir",
        &data_dir,
        "--config-dir",
        &config_dir,
    ];
    args.extend_from_slice(extra_args);
    let opts = crate::config::Opts::parse_from(args);

    let mut config = crate::config::build_config(opts).unwrap();
    config.search_index_path = format!("./.temp/{unique}/search").into();
    config.vector_search_index_path = format!("./.temp/{unique}/vector").into();

    let appstate = AppState::init(config).await.unwrap();
    let store = appstate.store.clone();
    atomic_lib::test_utils::setup_test_env(&store)
        .await
        .unwrap();

    let drive = store
        .get_drive_did("localhost")
        .await
        .unwrap()
        .expect("the test env maps localhost to a drive")
        .to_string();

    let ontology = genesis(
        &store,
        vec![
            (
                urls::IS_A,
                Value::ResourceArray(vec![urls::ONTOLOGY.into()]),
            ),
            (urls::PARENT, Value::AtomicUrl(drive.as_str().into())),
            (urls::SHORTNAME, Value::Slug("plugins".into())),
            (urls::DESCRIPTION, Value::Markdown("Plugins".into())),
        ],
    )
    .await;

    let mut terms = DriveTerms {
        properties: HashMap::new(),
        classes: HashMap::new(),
    };
    let mut properties = Vec::new();

    for (shortname, datatype) in [
        ("plugin-source", urls::MARKDOWN),
        ("plugin-schemas", urls::JSON),
        ("plugin-connection", urls::JSON),
        ("automation-integrations", urls::RESOURCE_ARRAY),
        ("trigger", urls::STRING),
        ("started-at", urls::TIMESTAMP),
        ("run-status", urls::STRING),
        ("run-problems", urls::JSON),
        ("run-outcomes", urls::JSON),
        ("run-cursor", urls::STRING),
    ] {
        let subject = genesis(
            &store,
            vec![
                (
                    urls::IS_A,
                    Value::ResourceArray(vec![urls::PROPERTY.into()]),
                ),
                (urls::PARENT, Value::AtomicUrl(ontology.as_str().into())),
                (urls::SHORTNAME, Value::Slug(shortname.to_string())),
                (urls::DESCRIPTION, Value::Markdown(shortname.to_string())),
                (urls::DATATYPE_PROP, Value::AtomicUrl(datatype.into())),
            ],
        )
        .await;

        terms
            .properties
            .insert(shortname.to_string(), subject.clone());
        properties.push(subject.into());
    }

    let mut classes = Vec::new();

    for shortname in ["plugin-script", "plugin-run"] {
        let subject = genesis(
            &store,
            vec![
                (urls::IS_A, Value::ResourceArray(vec![urls::CLASS.into()])),
                (urls::PARENT, Value::AtomicUrl(ontology.as_str().into())),
                (urls::SHORTNAME, Value::Slug(shortname.to_string())),
                (urls::DESCRIPTION, Value::Markdown(shortname.to_string())),
            ],
        )
        .await;

        terms.classes.insert(shortname.to_string(), subject.clone());
        classes.push(subject.into());
    }

    let mut ontology_resource = store.get_resource(&ontology.as_str().into()).await.unwrap();
    ontology_resource
        .set_unsafe(urls::PROPERTIES.into(), Value::ResourceArray(properties))
        .unwrap();
    ontology_resource
        .set_unsafe(urls::CLASSES.into(), Value::ResourceArray(classes))
        .unwrap();
    ontology_resource.save(&store).await.unwrap();

    let mut drive_resource = store.get_resource(&drive.as_str().into()).await.unwrap();
    drive_resource
        .set_unsafe(
            urls::DEFAULT_ONTOLOGY.into(),
            Value::AtomicUrl(ontology.as_str().into()),
        )
        .unwrap();
    drive_resource.save(&store).await.unwrap();

    Fixture {
        appstate,
        drive,
        plugin: String::new(),
        terms,
    }
}

/// `testdata/plugin-routes/hello-route/`: a version-three JS plugin with one
/// anonymous `GET /hello/{name}` on the `drive-prefix` mount. It needs
/// `--plugin-routes read-only`. Shared by the gate, registry and (AS-05)
/// route execution tests; `server/tests/it/plugin_routes.rs` loads the same
/// files.
pub const HELLO_ROUTE_SOURCE: &str =
    include_str!("../../../testdata/plugin-routes/hello-route/plugin.js");
pub const HELLO_ROUTE_MANIFEST: &str =
    include_str!("../../../testdata/plugin-routes/hello-route/manifest.json");

/// The hello-route fixture as a release.
pub fn hello_route_release() -> atomic_lib::db::plugin_release::PluginRelease {
    js_release(serde_json::from_str(HELLO_ROUTE_MANIFEST).unwrap())
}

/// `testdata/plugin-routes/well-known/`: a `drive-host` plugin that claims
/// `/.well-known/nodeinfo` and `/.well-known/webfinger` (for `acct:`).
pub const WELL_KNOWN_SOURCE: &str =
    include_str!("../../../testdata/plugin-routes/well-known/plugin.js");
pub const WELL_KNOWN_MANIFEST: &str =
    include_str!("../../../testdata/plugin-routes/well-known/manifest.json");

/// The well-known fixture as a release.
pub fn well_known_release() -> atomic_lib::db::plugin_release::PluginRelease {
    js_release_with_source(
        WELL_KNOWN_SOURCE,
        serde_json::from_str(WELL_KNOWN_MANIFEST).unwrap(),
    )
}

/// `testdata/plugin-routes/inbox/`: a `drive-prefix` plugin whose `POST
/// /inbox` creates a PlainText under `config.inbox`, and whose `PUT` /
/// `DELETE /item` change or destroy one. Needs `--plugin-routes read-write`
/// and a route grant.
pub const INBOX_SOURCE: &str = include_str!("../../../testdata/plugin-routes/inbox/plugin.js");
pub const INBOX_MANIFEST: &str =
    include_str!("../../../testdata/plugin-routes/inbox/manifest.json");

/// The inbox fixture as a release.
pub fn inbox_release() -> atomic_lib::db::plugin_release::PluginRelease {
    js_release_with_source(INBOX_SOURCE, serde_json::from_str(INBOX_MANIFEST).unwrap())
}

/// `testdata/plugin-routes/files/`: a remoteStorage-like `drive-prefix`
/// plugin whose `PUT /files/{*path}` takes a blob body and stores a File
/// under `config.folder`, and whose `GET /files/{*path}` answers with that
/// blob. Needs `--plugin-routes read-write` and a route grant.
pub const FILES_SOURCE: &str = include_str!("../../../testdata/plugin-routes/files/plugin.js");
pub const FILES_MANIFEST: &str =
    include_str!("../../../testdata/plugin-routes/files/manifest.json");

/// The files fixture as a release.
pub fn files_release() -> atomic_lib::db::plugin_release::PluginRelease {
    js_release_with_source(FILES_SOURCE, serde_json::from_str(FILES_MANIFEST).unwrap())
}

/// A JS `extension` release of the trivial source with this manifest.
pub fn js_release(manifest: serde_json::Value) -> atomic_lib::db::plugin_release::PluginRelease {
    js_release_with_source(HELLO_ROUTE_SOURCE, manifest)
}

/// A JS `extension` release of `source` with this manifest.
pub fn js_release_with_source(
    source: &str,
    manifest: serde_json::Value,
) -> atomic_lib::db::plugin_release::PluginRelease {
    let mut release = atomic_lib::db::plugin_release::PluginRelease::js(
        source.into(),
        manifest,
        Default::default(),
    );
    release.world = atomic_lib::db::plugin_release::WORLD_EXTENSION.into();
    release
}

/// Publishes `release` and installs it on the fixture's drive as an active
/// Installation, granting every capability it declares. Namespace and name
/// come from the manifest. Returns the Installation's subject, or the
/// commit's refusal.
pub async fn install_release(
    fixture: &Fixture,
    release: &atomic_lib::db::plugin_release::PluginRelease,
) -> Result<String, String> {
    install_release_with(fixture, release, None, None).await
}

/// [`install_release`], also granting `route_grant` (the value of the
/// `route-writes` grant: the approved write targets) and with this `config`.
pub async fn install_release_with(
    fixture: &Fixture,
    release: &atomic_lib::db::plugin_release::PluginRelease,
    route_grant: Option<serde_json::Value>,
    config: Option<serde_json::Value>,
) -> Result<String, String> {
    let store = &fixture.appstate.store;
    let id = store
        .publish_plugin_release(release)
        .map_err(|e| e.to_string())?;
    let mut grants: Vec<serde_json::Value> = release
        .manifest
        .get("capabilities")
        .and_then(|c| c.as_array())
        .into_iter()
        .flatten()
        .filter_map(|c| c.get("name").cloned())
        .collect();
    if let Some(targets) = route_grant {
        grants.push(serde_json::json!({ "route-writes": targets }));
    }
    let mut resource = Resource::new("did:ad:placeholder".into());
    if let Some(config) = config {
        resource
            .set_unsafe(urls::CONFIG.into(), Value::Json(config))
            .map_err(|e| e.to_string())?;
    }
    for (property, value) in [
        (
            urls::IS_A,
            Value::ResourceArray(vec![urls::INSTALLATION.into()]),
        ),
        (
            urls::PARENT,
            Value::AtomicUrl(fixture.drive.as_str().into()),
        ),
        (urls::RELEASE_PROP, Value::String(id.clone())),
        (urls::RELEASE_ID, Value::String(id)),
        (urls::INSTALLATION_STATUS, Value::String("active".into())),
        (urls::GRANTS, Value::Json(grants.into())),
    ] {
        resource
            .set_unsafe(property.into(), value)
            .map_err(|e| e.to_string())?;
    }
    resource
        .save_as_genesis(store)
        .await
        .map_err(|e| e.to_string())?;
    Ok(resource.get_subject().to_string())
}

/// A plugin whose every run proposes one new resource with this name.
pub async fn write_plugin(fixture: &mut Fixture, creates: &str) {
    let source = format!(
        r#"export function run(ctx) {{
            return {{ intents: [{{ op: 'create', localId: 'made',
                parent: {:?}, isA: [],
                set: {{ "https://atomicdata.dev/properties/name": {creates:?} }} }}] }};
        }}"#,
        fixture.drive,
    );

    fixture.plugin = genesis(
        &fixture.appstate.store,
        vec![
            (
                urls::IS_A,
                Value::ResourceArray(vec![fixture.terms.class("plugin-script").unwrap().into()]),
            ),
            (
                urls::PARENT,
                Value::AtomicUrl(fixture.drive.as_str().into()),
            ),
            (urls::NAME, Value::String("Importer".into())),
            (
                fixture.terms.property("plugin-source").unwrap(),
                Value::Markdown(source),
            ),
        ],
    )
    .await;
}

pub async fn children_named(fixture: &Fixture, parent: &str, name: &str) -> usize {
    fixture
        .appstate
        .store
        .get_resource(&parent.into())
        .await
        .unwrap()
        .get_children(&fixture.appstate.store)
        .await
        .unwrap()
        .iter()
        .filter(|child| {
            child
                .get(urls::NAME)
                .is_ok_and(|value| value.to_string() == name)
        })
        .count()
}
