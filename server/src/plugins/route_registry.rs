//! The registry of installed plugins' HTTP routes: which installation answers
//! which `(host, method, pattern)`, and in what state.
//!
//! Design: atomic-plugins `docs/design/server-plugin-routes.md`, sections 0.4,
//! 2.3 and 2.9, decision D1. Compiled only with the `plugin-routes` feature;
//! nothing registers or answers unless `--plugin-routes` is at least
//! `read-only`. Running a matched route is AS-05 (#1715): until then a match
//! answers `501` with a problem that says so.
//!
//! - **Mounts.** `installation-origin` serves an installation at
//!   `<slug>.<ATOMIC_ROUTES_ORIGIN>`; `drive-prefix` at
//!   `/_routes/<slug>/` on the API origin. `drive-host` is #1716 and is
//!   refused at activation until then.
//! - **Slugs** are derived from the Installation subject, so two
//!   installations never share one, and a retired slug is never reused.
//! - **Activation** checks the release's routes against reserved paths and
//!   against every other active installation, before the installation hook
//!   materializes anything, and refuses the commit with a typed problem. The
//!   routes are registered after the commit is stored.
//! - **Pause** clears the routes and answers `503` + `Retry-After: 3600`;
//!   **revoke** and uninstall answer `410` for 30 days, then `404`; an
//!   installation whose release needs more than the gates now allow is
//!   **degraded** at startup and answers `404`.
//! - **Execution owner.** Only the node the activation was committed on
//!   registers the routes. An activation that arrives from a peer (inside a
//!   sync import) registers nothing, so two nodes never answer as the same
//!   public identity. The owner keeps a record per installation in
//!   `Tree::PluginMeta`, from which [`RouteRegistry::rebuild`] restores the
//!   registry at startup.
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use atomic_lib::{
    agents::ForAgent,
    class_extender::{BoxFuture, ClassExtender, CommitExtenderContext},
    db::trees::Tree,
    errors::AtomicResult,
    urls, Db, Resource, Storelike, Subject, Value,
};

use super::manifest::Manifest;
use super::manifest_http::{
    overlaps, pattern, Http, Mount, Segment, EXCLUSIVE_WELL_KNOWN, SHARED_WELL_KNOWN,
};
use super::plugin::{STATUS_ACTIVE, STATUS_DRAFT, STATUS_PAUSED, STATUS_REVOKED};
use crate::plugin_routes::{PluginRoutesConfig, PluginRoutesLevel};

/// How long a revoked or uninstalled installation's URLs answer `410 Gone`
/// before they answer `404` (*proposed* in the design: 30 days).
pub const GONE_FOR_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// `Retry-After` of a paused installation, so peers retry instead of
/// forgetting the actor.
pub const PAUSED_RETRY_AFTER_SECS: u64 = 3600;

/// Prefix of this registry's records in `Tree::PluginMeta`.
const RECORD_PREFIX: &str = "plugin-routes:";

/// The installation slug: 32 lowercase hex characters of the blake3 hash of
/// the Installation's subject. A DNS label, the same on every node, and
/// never shared by two installations, so a new package can never inherit an
/// old one's public identity.
pub fn slug(installation: &str) -> String {
    let pure = Subject::from(installation).pure_id();
    blake3::hash(pure.as_bytes()).to_hex()[..32].to_string()
}

fn is_slug(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The host part of a registry key.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Host {
    /// The API origin (`drive-prefix` routes, under `/_routes/<slug>/`).
    Api,
    /// A named host: `<slug>.<routes origin host>` for `installation-origin`.
    Named(String),
}

/// One registered route: the key `(host, methods, normalized pattern)` and
/// the route it belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub route: String,
    pub host: Host,
    pub methods: Vec<String>,
    /// The whole path on `host`, `/_routes/<slug>` included for
    /// `drive-prefix`.
    pub segments: Vec<Segment>,
}

/// What an installation's URLs answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Active,
    /// `503` + `Retry-After`.
    Paused,
    /// The gates no longer allow the release (or the routes origin is gone):
    /// `404`, and nothing registered. Turning the gate back on and restarting
    /// restores it without a new review.
    Degraded(String),
    /// Revoked or uninstalled at this time (ms): `410`, then `404`.
    Retired {
        at: i64,
    },
}

#[derive(Clone, Debug)]
struct Registered {
    subject: String,
    mount: Mount,
    state: State,
    /// Empty unless `state` is `Active`.
    entries: Vec<Entry>,
}

/// Why an activation is refused. Each is a typed problem
/// ([`Refusal::to_json`]); the commit error carries [`Refusal::message`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `installation-origin` without `ATOMIC_ROUTES_ORIGIN` (design D1).
    RoutesOriginUnavailable,
    /// A mount this server does not serve yet (`drive-host`, #1716).
    MountUnavailable(&'static str),
    /// The route's path is one the server keeps for itself.
    Reserved {
        route: String,
        path: String,
        reason: String,
    },
    /// Another installation already answers an overlapping pattern on the
    /// same host for one of the same methods.
    Conflict {
        route: String,
        path: String,
        other_installation: String,
        other_route: String,
    },
}

impl Refusal {
    pub fn problem_type(&self) -> &'static str {
        match self {
            Refusal::RoutesOriginUnavailable => "routes-origin-unavailable",
            Refusal::MountUnavailable(_) => "route-mount-unavailable",
            Refusal::Reserved { .. } => "route-path-reserved",
            Refusal::Conflict { .. } => "route-conflict",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Refusal::RoutesOriginUnavailable => "This plugin serves its public endpoints on its own origin (mount `installation-origin`), but this AtomicServer has no routes origin. To allow it, set `ATOMIC_ROUTES_ORIGIN` (or `--routes-origin`) to a separate origin with wildcard DNS and TLS.".to_string(),
            Refusal::MountUnavailable(mount) => format!(
                "This plugin asks for the `{mount}` mount, which this AtomicServer does not serve yet."
            ),
            Refusal::Reserved { route, path, reason } => format!(
                "The plugin's route `{route}` (`{path}`) uses a path the server reserves: {reason}."
            ),
            Refusal::Conflict {
                route,
                path,
                other_installation,
                other_route,
            } => format!(
                "The plugin's route `{route}` (`{path}`) overlaps route `{other_route}` of installation {other_installation} on the same host. Uninstall or pause that installation first."
            ),
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        let mut body = serde_json::json!({
            "type": self.problem_type(),
            "detail": self.message(),
        });
        match self {
            Refusal::RoutesOriginUnavailable => {
                body["option"] = "ATOMIC_ROUTES_ORIGIN".into();
            }
            Refusal::MountUnavailable(mount) => body["mount"] = (*mount).into(),
            Refusal::Reserved { route, path, .. } => {
                body["route"] = route.as_str().into();
                body["path"] = path.as_str().into();
            }
            Refusal::Conflict {
                route,
                path,
                other_installation,
                other_route,
            } => {
                body["route"] = route.as_str().into();
                body["path"] = path.as_str().into();
                body["otherInstallation"] = other_installation.as_str().into();
                body["otherRoute"] = other_route.as_str().into();
            }
        }
        body
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// First path segments `server/src/routes.rs` (and the website control
/// routes) serve on the API origin. A test keeps this list in step with
/// `routes.rs`.
pub const SERVER_ROUTES: [&str; 17] = [
    "app-agent",
    "app-write",
    "bind-drive",
    "blob",
    "commit",
    "download",
    "drive-usage",
    "export",
    "forget-peer",
    "history-attribution",
    "iroh-sync",
    "plugin-secret",
    "search",
    "upload",
    "vector_search",
    "website-hosting",
    "ws",
];
/// Prefixes of whole families of server routes.
pub const SERVER_ROUTE_PREFIXES: [&str; 2] = ["plugin-", "integration-"];

/// The server route a path's first segment names, if any.
pub fn server_route(first: &str) -> Option<String> {
    if SERVER_ROUTES.contains(&first) || SERVER_ROUTE_PREFIXES.iter().any(|p| first.starts_with(p))
    {
        Some(format!("/{first}"))
    } else {
        None
    }
}

/// Why `segments` on `host` is reserved for the server, if it is. `slug` is
/// the installation's own.
fn reserved(host: &Host, segments: &[Segment], slug: &str) -> Option<String> {
    let literal = |i: usize| match segments.get(i) {
        Some(Segment::Literal(s)) => Some(s.as_str()),
        _ => None,
    };
    match host {
        // The API origin's path space is the server's: its routes and its
        // resources. An installation only gets `/_routes/<its slug>/`.
        Host::Api => {
            if literal(0) == Some(atomic_lib::subject::PLUGIN_ROUTES_SEGMENT)
                && literal(1) == Some(slug)
            {
                return None;
            }
            Some(match literal(0).and_then(server_route) {
                Some(route) => format!("`{route}` is a server route on the API origin"),
                None => format!(
                    "on the API origin a plugin only gets `/_routes/{slug}/`; the rest is the server's routes and resources"
                ),
            })
        }
        // An installation's own origin is all its own, except the
        // `/.well-known/` names other software on the host would interpret.
        Host::Named(_) => {
            if literal(0) != Some(".well-known") {
                return None;
            }
            match literal(1) {
                Some("acme-challenge") => Some(
                    "`/.well-known/acme-challenge/` belongs to the server's certificates".into(),
                ),
                Some(name)
                    if SHARED_WELL_KNOWN.contains(&name)
                        || EXCLUSIVE_WELL_KNOWN.contains(&name) =>
                {
                    None
                }
                Some(name) => Some(format!(
                    "`/.well-known/{name}` is not a name a plugin may claim"
                )),
                None => {
                    Some("a `/.well-known/` name must be literal and one a plugin may claim".into())
                }
            }
        }
    }
}

/// Whether a request path (split on `/`, without the leading one) matches a
/// pattern. `{param}` is one non-empty segment; `{*rest}` one or more.
pub fn matches(pattern: &[Segment], request: &[&str]) -> bool {
    match (pattern.first(), request.first()) {
        (None, None) => true,
        (Some(Segment::Rest), Some(_)) => request.iter().all(|s| !s.is_empty()),
        (Some(Segment::Literal(l)), Some(r)) if l == r => matches(&pattern[1..], &request[1..]),
        (Some(Segment::Param), Some(r)) if !r.is_empty() => matches(&pattern[1..], &request[1..]),
        _ => false,
    }
}

fn request_segments(path: &str) -> Vec<&str> {
    let path = path.strip_prefix('/').unwrap_or(path);
    if path.is_empty() {
        Vec::new()
    } else {
        path.split('/').collect()
    }
}

/// The host name without a port, lowercased, without a trailing dot.
fn host_name(host: &str) -> String {
    let host = host.trim();
    let name = match host.strip_prefix('[') {
        // An IPv6 literal: `[::1]:80`.
        Some(rest) => rest
            .split_once(']')
            .map(|(inner, _)| &host[..inner.len() + 2])
            .unwrap_or(host),
        None => host.split(':').next().unwrap_or(host),
    };
    name.trim_end_matches('.').to_ascii_lowercase()
}

/// The in-memory table. Keyed by installation subject.
#[derive(Default)]
struct Table {
    installations: HashMap<String, Registered>,
    by_slug: HashMap<String, String>,
}

impl Table {
    fn conflict(&self, subject: &str, entries: &[Entry]) -> Option<Refusal> {
        for other in self.installations.values() {
            if other.subject == subject || other.state != State::Active {
                continue;
            }
            for theirs in &other.entries {
                for ours in entries {
                    if ours.host == theirs.host
                        && ours.methods.iter().any(|m| theirs.methods.contains(m))
                        && overlaps(&ours.segments, &theirs.segments)
                    {
                        return Some(Refusal::Conflict {
                            route: ours.route.clone(),
                            path: display(&ours.segments),
                            other_installation: other.subject.clone(),
                            other_route: theirs.route.clone(),
                        });
                    }
                }
            }
        }
        None
    }

    fn set(&mut self, subject: &str, mount: Mount, state: State, entries: Vec<Entry>) {
        self.by_slug.insert(slug(subject), subject.to_string());
        self.installations.insert(
            subject.to_string(),
            Registered {
                subject: subject.to_string(),
                mount,
                state,
                entries,
            },
        );
    }

    fn update_state(&mut self, subject: &str, state: State) {
        if let Some(registered) = self.installations.get_mut(subject) {
            registered.state = state;
            registered.entries.clear();
        }
    }
}

fn display(segments: &[Segment]) -> String {
    if segments.is_empty() {
        return "/".into();
    }
    segments
        .iter()
        .map(|s| match s {
            Segment::Literal(l) => format!("/{l}"),
            Segment::Param => "/{}".into(),
            Segment::Rest => "/{*}".into(),
        })
        .collect()
}

/// What a request to a plugin mount gets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    /// A route matched. Running it is AS-05; until then, `501`.
    Matched {
        route: String,
    },
    /// The path matches a route, the method does not.
    MethodNotAllowed {
        allow: Vec<String>,
    },
    Paused,
    Gone,
    NotFound,
}

/// The persisted record of an installation this node owns.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Record {
    slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    retired_at: Option<i64>,
}

/// The node's route registry. One per `AppState`.
pub struct RouteRegistry {
    config: PluginRoutesConfig,
    table: RwLock<Table>,
}

impl RouteRegistry {
    pub fn new(config: PluginRoutesConfig) -> Self {
        Self {
            config,
            table: RwLock::new(Table::default()),
        }
    }

    /// Whether routes are served at all: the build gate is here, so this is
    /// the runtime level.
    pub fn enabled(&self) -> bool {
        self.config.level() != PluginRoutesLevel::Off
    }

    /// The routes origin's host name, if one is configured.
    fn routes_host(&self) -> Option<String> {
        self.config
            .routes_origin()
            .and_then(|u| u.host_str())
            .map(|h| h.to_ascii_lowercase())
    }

    /// The installation slug a request's `Host` names on the routes origin,
    /// or `Some("")` for the bare routes origin. `None`: not a routes host.
    pub fn routes_host_label(&self, host: &str) -> Option<String> {
        if !self.enabled() {
            return None;
        }
        let routes = self.routes_host()?;
        let host = host_name(host);
        if host == routes {
            return Some(String::new());
        }
        host.strip_suffix(&format!(".{routes}")).map(str::to_string)
    }

    /// The entries an installation's `http` block registers, or why it
    /// can't. Checks mounts and reserved paths, not other installations.
    pub fn plan(&self, subject: &str, http: &Http) -> Result<Vec<Entry>, Refusal> {
        let slug = slug(subject);
        let (host, prefix) = match http.mount {
            Mount::InstallationOrigin => {
                let routes = self.routes_host().ok_or(Refusal::RoutesOriginUnavailable)?;
                (Host::Named(format!("{slug}.{routes}")), Vec::new())
            }
            Mount::DrivePrefix => (
                Host::Api,
                vec![
                    Segment::Literal(atomic_lib::subject::PLUGIN_ROUTES_SEGMENT.into()),
                    Segment::Literal(slug.clone()),
                ],
            ),
            Mount::DriveHost => return Err(Refusal::MountUnavailable("drive-host")),
        };
        http.routes
            .iter()
            .map(|route| {
                let own = pattern(&route.path).map_err(|reason| Refusal::Reserved {
                    route: route.id.clone(),
                    path: route.path.clone(),
                    reason,
                })?;
                let segments: Vec<Segment> = prefix.iter().cloned().chain(own).collect();
                if let Some(reason) = reserved(&host, &segments, &slug) {
                    return Err(Refusal::Reserved {
                        route: route.id.clone(),
                        path: route.path.clone(),
                        reason,
                    });
                }
                Ok(Entry {
                    route: route.id.clone(),
                    host: host.clone(),
                    methods: route.methods.clone(),
                    segments,
                })
            })
            .collect()
    }

    /// Whether `manifest` may be activated for `subject` on this node, as far
    /// as routes go. A release the gates refuse is left to the installation
    /// hook, which says so with the message of design 0.4.
    pub fn check(&self, subject: &str, manifest: &Manifest) -> Result<(), Refusal> {
        let Some(http) = self.routed(manifest) else {
            return Ok(());
        };
        let entries = self.plan(subject, http)?;
        match self.read().conflict(subject, &entries) {
            Some(conflict) => Err(conflict),
            None => Ok(()),
        }
    }

    /// The `http` block, when it has routes and the gates allow it.
    fn routed<'a>(&self, manifest: &'a Manifest) -> Option<&'a Http> {
        let http = manifest.http.as_ref().filter(|h| !h.routes.is_empty())?;
        manifest.gate().check(&self.config).ok()?;
        Some(http)
    }

    /// Registers (or re-registers, on upgrade) an active installation. When
    /// the gates or the mount no longer allow it, or another installation
    /// got there first, the installation is degraded instead.
    pub fn activate(&self, subject: &str, manifest: &Manifest) -> State {
        let mount = manifest.http.as_ref().map(|h| h.mount).unwrap_or_default();
        let has_routes = manifest.http.as_ref().is_some_and(|h| !h.routes.is_empty());
        let mut table = self.write();
        let (state, entries) = if !has_routes {
            (State::Active, Vec::new())
        } else if let Err(refusal) = manifest.gate().check(&self.config) {
            (State::Degraded(refusal.message()), Vec::new())
        } else {
            let planned = self
                .plan(subject, manifest.http.as_ref().expect("has routes"))
                .and_then(|entries| match table.conflict(subject, &entries) {
                    Some(conflict) => Err(conflict),
                    None => Ok(entries),
                });
            match planned {
                Ok(entries) => (State::Active, entries),
                Err(refusal) => (State::Degraded(refusal.message()), Vec::new()),
            }
        };
        table.set(subject, mount, state.clone(), entries);
        state
    }

    pub fn pause(&self, subject: &str) {
        self.write().update_state(subject, State::Paused);
    }

    pub fn retire(&self, subject: &str, at: i64) {
        let mut table = self.write();
        if table.installations.contains_key(subject) {
            table.update_state(subject, State::Retired { at });
        } else {
            table.set(subject, Mount::default(), State::Retired { at }, Vec::new());
        }
    }

    /// Whether this node registered `subject`: it is its execution owner.
    pub fn knows(&self, subject: &str) -> bool {
        self.read().installations.contains_key(subject)
    }

    pub fn state(&self, subject: &str) -> Option<State> {
        self.read()
            .installations
            .get(subject)
            .map(|r| r.state.clone())
    }

    /// What `method path` on `host` answers, or `None` when the request is
    /// not for a plugin mount at all.
    pub fn answer(&self, host: &str, method: &str, path: &str, now: i64) -> Option<Answer> {
        if !self.enabled() {
            return None;
        }
        let request = request_segments(path);
        let (slug, mount, key) = match self.routes_host_label(host) {
            Some(label) => (
                label,
                Mount::InstallationOrigin,
                Host::Named(host_name(host)),
            ),
            None => match request.as_slice() {
                [first, rest @ ..] if *first == atomic_lib::subject::PLUGIN_ROUTES_SEGMENT => (
                    rest.first().map(|s| s.to_string()).unwrap_or_default(),
                    Mount::DrivePrefix,
                    Host::Api,
                ),
                _ => return None,
            },
        };
        if !is_slug(&slug) {
            return Some(Answer::NotFound);
        }
        let table = self.read();
        let Some(registered) = table
            .by_slug
            .get(&slug)
            .and_then(|subject| table.installations.get(subject))
        else {
            return Some(Answer::NotFound);
        };
        Some(match &registered.state {
            State::Paused => Answer::Paused,
            State::Retired { at } if now.saturating_sub(*at) < GONE_FOR_MS => Answer::Gone,
            State::Retired { .. } | State::Degraded(_) => Answer::NotFound,
            State::Active if registered.mount != mount => Answer::NotFound,
            State::Active => {
                // `/_routes/<slug>/` is the mount's root, like `/_routes/<slug>`.
                let mut request = request;
                if mount == Mount::DrivePrefix && request.len() == 3 && request[2].is_empty() {
                    request.pop();
                }
                let mut allow: Vec<String> = Vec::new();
                for entry in registered.entries.iter().filter(|e| e.host == key) {
                    if matches(&entry.segments, &request) {
                        if entry.methods.iter().any(|m| m == method) {
                            return Some(Answer::Matched {
                                route: entry.route.clone(),
                            });
                        }
                        allow.extend(entry.methods.iter().cloned());
                    }
                }
                if allow.is_empty() {
                    Answer::NotFound
                } else {
                    allow.sort();
                    allow.dedup();
                    Answer::MethodNotAllowed { allow }
                }
            }
        })
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, Table> {
        self.table.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Table> {
        self.table.write().unwrap_or_else(|e| e.into_inner())
    }

    /// Restores the registry from this node's records: once at startup,
    /// after the class extenders are loaded. Re-checks the gates, so an
    /// installation whose release needs more than they now allow comes back
    /// degraded. Returns how many installations are active.
    pub async fn rebuild(&self, store: &Db) -> AtomicResult<usize> {
        let mut records: Vec<(String, Record)> = store
            .kv
            .scan_prefix(Tree::PluginMeta, RECORD_PREFIX.as_bytes())
            .flatten()
            .filter_map(|(key, value)| {
                let subject = std::str::from_utf8(&key)
                    .ok()?
                    .strip_prefix(RECORD_PREFIX)?;
                let record = serde_json::from_slice::<Record>(&value).ok()?;
                Some((subject.to_string(), record))
            })
            .collect();
        records.sort_by(|a, b| a.0.cmp(&b.0));
        let now = atomic_lib::utils::now();
        let mut active = 0;
        for (subject, record) in records {
            if let Some(at) = record.retired_at {
                self.retire(&subject, at);
                continue;
            }
            let resource = store.get_resource(&subject.as_str().into()).await.ok();
            match resource.as_ref().map(status) {
                Some(s) if s == STATUS_ACTIVE => {}
                Some(s) if s == STATUS_PAUSED || s == STATUS_DRAFT => {
                    let mount = self.mount_of(store, resource.as_ref().unwrap());
                    self.write().set(&subject, mount, State::Paused, Vec::new());
                    continue;
                }
                // Revoked or gone while this node was down.
                _ => {
                    self.retire(&subject, now);
                    persist(store, &subject, Some(now));
                    continue;
                }
            }
            let manifest = resource.as_ref().and_then(|r| pinned_manifest(store, r));
            let state = match manifest {
                Some(manifest) => self.activate(&subject, &manifest),
                None => {
                    let state = State::Degraded("the pinned release is not on this node".into());
                    self.write()
                        .set(&subject, Mount::default(), state.clone(), Vec::new());
                    state
                }
            };
            match state {
                State::Active => active += 1,
                State::Degraded(reason) => {
                    tracing::warn!(%subject, "plugin routes degraded: {reason}")
                }
                _ => {}
            }
        }
        Ok(active)
    }

    fn mount_of(&self, store: &Db, resource: &Resource) -> Mount {
        pinned_manifest(store, resource)
            .and_then(|m| m.http.map(|h| h.mount))
            .unwrap_or_default()
    }

    /// Before an Installation commit: refuse an activation whose routes
    /// collide or use reserved paths. Runs before the installation hook, so
    /// a refusal leaves nothing materialized.
    async fn before_commit(&self, context: CommitExtenderContext<'_>) -> AtomicResult<()> {
        let CommitExtenderContext {
            store,
            commit,
            resource,
            is_new,
            changed_props,
        } = context;
        if commit.destroy == Some(true) || status(resource) != STATUS_ACTIVE {
            return Ok(());
        }
        let subject = resource.get_subject().to_string();
        let activation = is_new
            || [
                urls::INSTALLATION_STATUS,
                urls::RELEASE_PROP,
                urls::RELEASE_ID,
            ]
            .iter()
            .any(|p| changed_props.contains(*p));
        // A peer's activation is not ours to refuse: this node will not
        // serve it (it is not the execution owner).
        if !activation || (importing() && !self.knows(&subject)) {
            return Ok(());
        }
        let manifest = match release_manifest(store, resource, commit.signer.as_str()).await {
            Some(manifest) => manifest,
            // Unresolvable or invalid: the installation hook refuses it.
            None => return Ok(()),
        };
        self.check(&subject, &manifest)
            .map_err(|refusal| refusal.message().into())
    }

    /// After an Installation commit is stored: register, pause or retire.
    async fn after_commit(&self, context: CommitExtenderContext<'_>) {
        let CommitExtenderContext {
            store,
            commit,
            resource,
            ..
        } = context;
        let subject = resource.get_subject().to_string();
        let owner = self.knows(&subject);
        let status = status(resource);
        if commit.destroy == Some(true) || status == STATUS_REVOKED {
            if owner {
                let now = atomic_lib::utils::now();
                self.retire(&subject, now);
                persist(store, &subject, Some(now));
            }
            return;
        }
        if status == STATUS_PAUSED || status == STATUS_DRAFT {
            if owner {
                self.pause(&subject);
            }
            return;
        }
        if status != STATUS_ACTIVE || (!owner && importing()) {
            return;
        }
        let Some(manifest) = pinned_manifest(store, resource) else {
            return;
        };
        if !owner && self.routed(&manifest).is_none() {
            // Nothing to serve, so nothing to own.
            return;
        }
        match self.activate(&subject, &manifest) {
            State::Degraded(reason) => {
                tracing::warn!(%subject, "plugin routes not registered: {reason}")
            }
            _ => tracing::info!(%subject, slug = %slug(&subject), "plugin routes registered"),
        }
        persist(store, &subject, None);
    }
}

fn importing() -> bool {
    atomic_lib::sync::ws_apply::is_importing()
}

fn status(resource: &Resource) -> String {
    match resource.get(urls::INSTALLATION_STATUS) {
        Ok(Value::String(s)) => s.clone(),
        Ok(other) => other.to_string(),
        Err(_) => STATUS_DRAFT.to_string(),
    }
}

fn string_value(resource: &Resource, prop: &str) -> Option<String> {
    match resource.get(prop) {
        Ok(Value::AtomicUrl(s)) => Some(s.to_string()),
        Ok(Value::String(s)) => Some(s.clone()),
        Ok(other) => Some(other.to_string()),
        Err(_) => None,
    }
}

/// The versioned manifest of the release the Installation pins, from this
/// node's release cache.
fn pinned_manifest(store: &Db, resource: &Resource) -> Option<Manifest> {
    let id = string_value(resource, urls::RELEASE_ID)?;
    let release = store.get_plugin_release(&id).ok()?;
    Manifest::parse(release.manifest).ok().flatten()
}

/// Like [`pinned_manifest`], resolving the release reference when it is not
/// cached yet (a first install). The installation hook verifies the id.
async fn release_manifest(store: &Db, resource: &Resource, signer: &str) -> Option<Manifest> {
    if let Some(manifest) = pinned_manifest(store, resource) {
        return Some(manifest);
    }
    let reference = string_value(resource, urls::RELEASE_PROP)?;
    let for_agent = ForAgent::AgentSubject(signer.to_string().into());
    let release = super::release::resolve(store, &reference, &for_agent)
        .await
        .ok()?;
    Manifest::parse(release.manifest).ok().flatten()
}

fn record_key(subject: &str) -> Vec<u8> {
    format!("{RECORD_PREFIX}{}", Subject::from(subject).pure_id()).into_bytes()
}

/// Writes this node's record for `subject`. Best effort: the registry in
/// memory is already right, and a failure is logged.
fn persist(store: &Db, subject: &str, retired_at: Option<i64>) {
    let record = Record {
        slug: slug(subject),
        retired_at,
    };
    let written = serde_json::to_vec(&record)
        .map_err(|e| e.to_string())
        .and_then(|bytes| {
            store
                .kv
                .insert(Tree::PluginMeta, &record_key(subject), &bytes)
                .map_err(|e| e.to_string())
        });
    if let Err(e) = written {
        tracing::warn!(%subject, "could not record plugin routes: {e}");
    }
}

fn on_before_commit(
    registry: Arc<RouteRegistry>,
    context: CommitExtenderContext<'_>,
) -> BoxFuture<'_, AtomicResult<()>> {
    Box::pin(async move { registry.before_commit(context).await })
}

fn on_after_commit(
    registry: Arc<RouteRegistry>,
    context: CommitExtenderContext<'_>,
) -> BoxFuture<'_, AtomicResult<()>> {
    Box::pin(async move {
        // The commit is stored; a failure here must not report it as refused.
        registry.after_commit(context).await;
        Ok(())
    })
}

/// The class extender that keeps the registry in step with Installations.
/// Register it before the installation extender, so its refusal comes
/// before anything is materialized.
pub fn build_extender(registry: Arc<RouteRegistry>) -> ClassExtender {
    let before = registry.clone();
    ClassExtender::builder()
        .id("installation-routes".to_string())
        .classes(vec![urls::INSTALLATION.to_string()])
        .before_commit(ClassExtender::wrap_commit_handler(move |context| {
            on_before_commit(before.clone(), context)
        }))
        .after_commit(ClassExtender::wrap_commit_handler(move |context| {
            on_after_commit(registry.clone(), context)
        }))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_routes::{resolve, OriginContext, PluginRoutesOptions};
    use PluginRoutesLevel::*;

    const API: OriginContext = OriginContext {
        api_origin: "http://localhost:9883",
        base_domain: None,
        website_origin: None,
    };

    fn config(level: PluginRoutesLevel, routes_origin: Option<&str>) -> PluginRoutesConfig {
        resolve(
            PluginRoutesOptions {
                level,
                routes_origin,
                ..Default::default()
            },
            true,
            API,
        )
        .unwrap()
    }

    fn registry(level: PluginRoutesLevel) -> RouteRegistry {
        RouteRegistry::new(config(level, Some("http://routes.localhost:9883")))
    }

    fn manifest(http: serde_json::Value) -> Manifest {
        Manifest::parse(serde_json::json!({
            "schemaVersion": 3,
            "http": http,
        }))
        .unwrap()
        .unwrap()
    }

    fn get(path: &str, id: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "path": path, "methods": ["GET", "HEAD"]})
    }

    const A: &str = "did:ad:installationA";
    const B: &str = "did:ad:installationB";

    #[test]
    fn slugs_are_dns_labels_derived_from_the_subject() {
        let a = slug(A);
        assert!(is_slug(&a), "{a}");
        assert_eq!(a, slug(A));
        assert_ne!(a, slug(B));
        // A drive hint is not part of the identity.
        assert_eq!(slug(A), slug(&format!("{A}?drive=did:ad:x")));
    }

    #[test]
    fn matching_handles_literals_params_and_rest() {
        let seg = |p: &str| pattern(p).unwrap();
        let cases = [
            ("/", "/", true),
            ("/", "/a", false),
            ("/users/{name}", "/users/alice", true),
            ("/users/{name}", "/users/", false),
            ("/users/{name}", "/users", false),
            ("/users/{name}", "/users/alice/inbox", false),
            ("/users/{name}/inbox", "/users/alice/inbox", true),
            ("/files/{*rest}", "/files/a", true),
            ("/files/{*rest}", "/files/a/b/c", true),
            ("/files/{*rest}", "/files", false),
            ("/files/{*rest}", "/files/a//b", false),
            ("/{*rest}", "/anything/at/all", true),
            ("/{*rest}", "/", false),
        ];
        for (p, path, expected) in cases {
            assert_eq!(
                matches(&seg(p), &request_segments(path)),
                expected,
                "{p} {path}"
            );
        }
    }

    #[test]
    fn drive_prefix_routes_live_under_the_slug() {
        let r = registry(ReadOnly);
        let m = manifest(serde_json::json!({
            "mount": "drive-prefix",
            "routes": [get("/users/{name}", "actor"), get("/", "root")]
        }));
        r.check(A, &m).unwrap();
        assert_eq!(r.activate(A, &m), State::Active);
        let s = slug(A);
        let at = |path: &str, method: &str| r.answer("localhost:9883", method, path, 0);
        assert_eq!(
            at(&format!("/_routes/{s}/users/alice"), "GET"),
            Some(Answer::Matched {
                route: "actor".into()
            })
        );
        for root in [format!("/_routes/{s}"), format!("/_routes/{s}/")] {
            assert_eq!(
                at(&root, "GET"),
                Some(Answer::Matched {
                    route: "root".into()
                }),
                "{root}"
            );
        }
        assert_eq!(
            at(&format!("/_routes/{s}/users/alice"), "POST"),
            Some(Answer::MethodNotAllowed {
                allow: vec!["GET".into(), "HEAD".into()]
            })
        );
        assert_eq!(
            at(&format!("/_routes/{s}/nope"), "GET"),
            Some(Answer::NotFound)
        );
        assert_eq!(
            at(&format!("/_routes/{}/x", slug(B)), "GET"),
            Some(Answer::NotFound)
        );
        assert_eq!(at("/_routes/not-a-slug/x", "GET"), Some(Answer::NotFound));
        // Not a plugin mount: the server's own paths.
        assert_eq!(at("/commit", "POST"), None);
        assert_eq!(at("/_routesx", "GET"), None);
        // The drive-prefix installation is not on the routes origin.
        assert_eq!(
            r.answer(
                &format!("{s}.routes.localhost:9883"),
                "GET",
                "/users/alice",
                0
            ),
            Some(Answer::NotFound)
        );
    }

    #[test]
    fn installation_origin_routes_live_on_their_own_host() {
        let r = registry(ReadOnly);
        let m = manifest(serde_json::json!({
            "routes": [get("/users/{name}", "actor"), get("/.well-known/nodeinfo", "nodeinfo")]
        }));
        assert_eq!(r.activate(A, &m), State::Active);
        let s = slug(A);
        let host = format!("{s}.routes.localhost:9883");
        assert_eq!(
            r.answer(&host, "GET", "/users/alice", 0),
            Some(Answer::Matched {
                route: "actor".into()
            })
        );
        // Case and a trailing dot in `Host` do not matter.
        assert_eq!(
            r.answer(
                &format!("{}.ROUTES.localhost.", s.to_uppercase()),
                "GET",
                "/.well-known/nodeinfo",
                0
            ),
            Some(Answer::Matched {
                route: "nodeinfo".into()
            })
        );
        // Every path on a routes host is the plugins': the server's routes
        // are not served there.
        assert_eq!(
            r.answer(&host, "POST", "/commit", 0),
            Some(Answer::NotFound)
        );
        assert_eq!(
            r.answer("routes.localhost:9883", "GET", "/", 0),
            Some(Answer::NotFound)
        );
        // Not under the API origin's prefix.
        assert_eq!(
            r.answer(
                "localhost:9883",
                "GET",
                &format!("/_routes/{s}/users/alice"),
                0
            ),
            Some(Answer::NotFound)
        );
    }

    #[test]
    fn installation_origin_without_a_routes_origin_is_refused_naming_the_option() {
        let r = RouteRegistry::new(config(ReadOnly, None));
        let m = manifest(serde_json::json!({"routes": [get("/x", "x")]}));
        let refusal = r.check(A, &m).unwrap_err();
        assert_eq!(refusal, Refusal::RoutesOriginUnavailable);
        assert!(refusal.message().contains("ATOMIC_ROUTES_ORIGIN"));
        assert_eq!(refusal.to_json()["type"], "routes-origin-unavailable");
        // drive-prefix works without one.
        let m = manifest(serde_json::json!({"mount": "drive-prefix", "routes": [get("/x", "x")]}));
        r.check(A, &m).unwrap();
    }

    #[test]
    fn drive_host_is_refused_until_it_exists() {
        let r = registry(ReadOnly);
        let m = manifest(serde_json::json!({"mount": "drive-host", "routes": [get("/x", "x")]}));
        assert_eq!(
            r.check(A, &m).unwrap_err(),
            Refusal::MountUnavailable("drive-host")
        );
    }

    #[test]
    fn reserved_paths_are_refused() {
        let r = registry(ReadOnly);
        for (path, needle) in [
            ("/.well-known/acme-challenge/{token}", "acme-challenge"),
            ("/.well-known/change-password", "change-password"),
            ("/.well-known/security.txt", "security.txt"),
            ("/.well-known/{name}", "must be literal"),
        ] {
            let m = manifest(serde_json::json!({"routes": [get(path, "x")]}));
            let refusal = r.check(A, &m).unwrap_err();
            assert!(
                matches!(&refusal, Refusal::Reserved { route, .. } if route == "x"),
                "{path}: {refusal:?}"
            );
            assert!(refusal.message().contains(needle), "{path}: {refusal}");
            assert_eq!(refusal.to_json()["type"], "route-path-reserved");
        }
        // Claimable names are fine on the installation's own origin.
        for path in [
            "/.well-known/webfinger",
            "/.well-known/did.json",
            "/{*rest}",
        ] {
            let m = manifest(serde_json::json!({"routes": [get(path, "x")]}));
            r.check(A, &m).unwrap_or_else(|e| panic!("{path}: {e}"));
        }
    }

    #[test]
    fn the_api_origin_is_the_servers_outside_the_installations_prefix() {
        let s = slug(A);
        let seg = |p: &str| pattern(p).unwrap();
        assert_eq!(
            reserved(&Host::Api, &seg(&format!("/_routes/{s}/x")), &s),
            None
        );
        let other = reserved(&Host::Api, &seg(&format!("/_routes/{}/x", slug(B))), &s).unwrap();
        assert!(other.contains(&format!("/_routes/{s}/")), "{other}");
        for route in [
            "/commit",
            "/ws",
            "/plugin-run",
            "/integration-actions",
            "/search",
        ] {
            let reason = reserved(&Host::Api, &seg(route), &s).unwrap();
            assert!(reason.contains("server route"), "{route}: {reason}");
        }
    }

    /// Every first path segment `routes.rs` serves is in [`SERVER_ROUTES`] or
    /// under one of [`SERVER_ROUTE_PREFIXES`].
    #[test]
    fn server_routes_cover_routes_rs() {
        let sources = [
            include_str!("../routes.rs"),
            include_str!("../handlers/website.rs"),
        ];
        let mut found = Vec::new();
        for source in sources {
            for call in ["web::resource(\"/", "web::scope(\"/"] {
                for piece in source.split(call).skip(1) {
                    let first: String = piece
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                        .collect();
                    if !first.is_empty() {
                        found.push(first);
                    }
                }
            }
        }
        assert!(found.len() > 20, "{found:?}");
        for first in found {
            assert!(server_route(&first).is_some(), "`/{first}` is not reserved");
        }
    }

    #[test]
    fn collisions_between_installations_are_refused_naming_the_other() {
        let r = registry(ReadOnly);
        let host = Host::Named("shared.example".into());
        let entry = |route: &str, path: &str, methods: &[&str]| Entry {
            route: route.into(),
            host: host.clone(),
            methods: methods.iter().map(|m| m.to_string()).collect(),
            segments: pattern(path).unwrap(),
        };
        r.write().set(
            A,
            Mount::InstallationOrigin,
            State::Active,
            vec![entry("actor", "/users/{a}", &["GET"])],
        );
        let table = r.read();
        let refusal = table
            .conflict(B, &[entry("me", "/users/me", &["GET", "HEAD"])])
            .unwrap();
        assert_eq!(
            refusal,
            Refusal::Conflict {
                route: "me".into(),
                path: "/users/me".into(),
                other_installation: A.into(),
                other_route: "actor".into(),
            }
        );
        assert!(refusal.message().contains(A), "{refusal}");
        assert_eq!(refusal.to_json()["otherInstallation"], A);
        assert_eq!(refusal.to_json()["type"], "route-conflict");
        // Disjoint methods, disjoint patterns, another host or the same
        // installation: no conflict.
        assert!(table
            .conflict(B, &[entry("w", "/users/{a}", &["POST"])])
            .is_none());
        assert!(table
            .conflict(B, &[entry("i", "/users/{a}/inbox", &["GET"])])
            .is_none());
        assert!(table
            .conflict(A, &[entry("me", "/users/me", &["GET"])])
            .is_none());
        let elsewhere = Entry {
            host: Host::Named("other.example".into()),
            ..entry("me", "/users/me", &["GET"])
        };
        assert!(table.conflict(B, &[elsewhere]).is_none());
        drop(table);
        // A paused or retired installation holds no routes.
        r.pause(A);
        assert!(r
            .read()
            .conflict(B, &[entry("me", "/users/me", &["GET"])])
            .is_none());
    }

    #[test]
    fn lifecycle_answers_paused_gone_and_not_found() {
        let r = registry(ReadOnly);
        let m = manifest(serde_json::json!({"mount": "drive-prefix", "routes": [get("/x", "x")]}));
        r.activate(A, &m);
        let path = format!("/_routes/{}/x", slug(A));
        let at = |now| r.answer("localhost", "GET", &path, now);
        assert!(matches!(at(0), Some(Answer::Matched { .. })));

        r.pause(A);
        assert_eq!(r.state(A), Some(State::Paused));
        assert_eq!(at(0), Some(Answer::Paused));

        // Resuming re-registers.
        assert_eq!(r.activate(A, &m), State::Active);
        assert!(matches!(at(0), Some(Answer::Matched { .. })));

        r.retire(A, 1_000);
        assert_eq!(at(1_000), Some(Answer::Gone));
        assert_eq!(at(1_000 + GONE_FOR_MS - 1), Some(Answer::Gone));
        assert_eq!(at(1_000 + GONE_FOR_MS), Some(Answer::NotFound));
    }

    #[test]
    fn a_release_the_gates_no_longer_allow_is_degraded_and_answers_not_found() {
        // Registered as read-write, the node now runs at read-only.
        let r = registry(ReadOnly);
        let m = manifest(serde_json::json!({
            "mount": "drive-prefix",
            "routes": [{"id": "w", "path": "/x", "methods": ["POST"], "principal": "installation", "auth": "atomic"}]
        }));
        assert!(
            matches!(r.activate(A, &m), State::Degraded(reason) if reason.contains("read-write"))
        );
        let path = format!("/_routes/{}/x", slug(A));
        assert_eq!(
            r.answer("localhost", "POST", &path, 0),
            Some(Answer::NotFound)
        );
        // `check` leaves the refusal to the installation hook's gate message.
        r.check(B, &m).unwrap();
    }

    #[test]
    fn nothing_answers_when_the_level_is_off() {
        let r = registry(Off);
        assert!(!r.enabled());
        let m = manifest(serde_json::json!({"mount": "drive-prefix", "routes": [get("/x", "x")]}));
        r.activate(A, &m);
        let s = slug(A);
        assert_eq!(
            r.answer("localhost", "GET", &format!("/_routes/{s}/x"), 0),
            None
        );
        assert_eq!(
            r.answer(&format!("{s}.routes.localhost"), "GET", "/x", 0),
            None
        );
        assert_eq!(r.routes_host_label(&format!("{s}.routes.localhost")), None);
    }

    #[test]
    fn host_names_drop_the_port() {
        assert_eq!(host_name("A.Example.com:8080"), "a.example.com");
        assert_eq!(host_name("example.com."), "example.com");
        assert_eq!(host_name("[::1]:80"), "[::1]");
    }
}
