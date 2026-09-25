//! The registry of installed plugins' HTTP routes: which installation answers
//! which `(host, method, pattern)`, and in what state.
//!
//! Design: atomic-plugins `docs/design/server-plugin-routes.md`, sections 0.4,
//! 2.3, 2.4 and 2.9, decision D1. Compiled only with the `plugin-routes`
//! feature; nothing registers or answers unless `--plugin-routes` is at least
//! `read-only`. A matched route runs in [`super::route_exec`].
//!
//! - **Mounts.** `installation-origin` serves an installation at
//!   `<slug>.<ATOMIC_ROUTES_ORIGIN>`; `drive-prefix` at
//!   `/_routes/<slug>/` on the API origin; `drive-host` on every host
//!   `Tree::DriveMapping` maps to the installation's drive, except the API
//!   origin's. A drive host is shared with the drive's own resources, so a
//!   `drive-host` route only gets paths the server and the drive do not use
//!   (see [`reserved`] and [`check_drive_host`]), and requests to any other
//!   path fall through to the server.
//! - **Well-known claims** (design 2.4). An installation claims
//!   `/.well-known/<name>` from the allowlist in `http.wellKnown`, on its own
//!   mount's host: its own origin, or its drive's hosts. On the API origin
//!   only the operator grants a claim (`ATOMIC_PLUGIN_API_WELL_KNOWN`).
//!   `webfinger` is shared: the host dispatches on its `resource` parameter
//!   by each claim's `resourcePrefix`, answers `404` when nobody matched, and
//!   generates `host-meta` from it. Every other name is exclusive: one
//!   installation per host, and on a drive's host only with the drive
//!   owner's approval. The server's own names (`acme-challenge`,
//!   `host-meta`) are never claimable.
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
    overlaps, pattern, Http, Mount, Segment, WellKnownKind, EXCLUSIVE_WELL_KNOWN, SHARED_WELL_KNOWN,
};
use super::plugin::{STATUS_ACTIVE, STATUS_DRAFT, STATUS_PAUSED, STATUS_REVOKED};
use crate::plugin_routes::{PluginRoutesConfig, PluginRoutesLevel, SERVER_WELL_KNOWN};

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
    /// The API origin (`drive-prefix` routes, under `/_routes/<slug>/`, and
    /// the operator's well-known grants).
    Api,
    /// A named host: `<slug>.<routes origin host>` for `installation-origin`.
    Named(String),
    /// Every host mapped to this drive (its pure id), except the API
    /// origin's: `drive-host`. One host maps to one drive, so this keys the
    /// same as the hosts would.
    Drive(String),
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

/// One `/.well-known/<name>` claim on one host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claim {
    pub name: String,
    pub host: Host,
    /// `match.resourcePrefix` of a shared (`webfinger`) claim.
    pub prefix: Option<String>,
    /// The route that answers it, and its methods.
    pub route: String,
    pub methods: Vec<String>,
}

/// What an activation registers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub entries: Vec<Entry>,
    pub claims: Vec<Claim>,
}

#[derive(Clone, Debug)]
struct Registered {
    subject: String,
    mount: Mount,
    state: State,
    /// Both empty unless `state` is `Active`.
    entries: Vec<Entry>,
    claims: Vec<Claim>,
}

/// Why an activation is refused. Each is a typed problem
/// ([`Refusal::to_json`]); the commit error carries [`Refusal::message`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `installation-origin` without `ATOMIC_ROUTES_ORIGIN` (design D1).
    RoutesOriginUnavailable,
    /// `drive-host` for an installation that has no drive.
    NoDrive,
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
    /// A `/.well-known/` name the server keeps, or one not on the allowlist.
    WellKnownReserved { name: String },
    /// Another installation already holds this exclusive name on the same
    /// host, or a `webfinger` prefix that overlaps.
    WellKnownConflict {
        name: String,
        other_installation: String,
    },
    /// A claim with no host to live on: a `drive-prefix` installation's
    /// claims are on the API origin, which only the operator grants.
    WellKnownUnavailable { name: String },
    /// An exclusive claim on a drive's host, activated by someone who is not
    /// the drive's owner.
    WellKnownApprovalRequired { name: String, drive: String },
}

impl Refusal {
    pub fn problem_type(&self) -> &'static str {
        match self {
            Refusal::RoutesOriginUnavailable => "routes-origin-unavailable",
            Refusal::NoDrive => "route-mount-unavailable",
            Refusal::Reserved { .. } => "route-path-reserved",
            Refusal::Conflict { .. } => "route-conflict",
            Refusal::WellKnownReserved { .. } => "well-known-reserved",
            Refusal::WellKnownConflict { .. } => "well-known-conflict",
            Refusal::WellKnownUnavailable { .. } => "well-known-unavailable",
            Refusal::WellKnownApprovalRequired { .. } => "well-known-approval-required",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Refusal::RoutesOriginUnavailable => "This plugin serves its public endpoints on its own origin (mount `installation-origin`), but this AtomicServer has no routes origin. To allow it, set `ATOMIC_ROUTES_ORIGIN` (or `--routes-origin`) to a separate origin with wildcard DNS and TLS.".to_string(),
            Refusal::NoDrive => "This plugin serves its public endpoints on its drive's hosts (mount `drive-host`), but the installation has no drive.".to_string(),
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
            Refusal::WellKnownReserved { name } => format!(
                "The plugin claims `/.well-known/{name}`, which is not a name a plugin may claim."
            ),
            Refusal::WellKnownConflict {
                name,
                other_installation,
            } => format!(
                "The plugin claims `/.well-known/{name}`, which installation {other_installation} already answers on the same host. Uninstall or pause that installation first."
            ),
            Refusal::WellKnownUnavailable { name } => format!(
                "The plugin claims `/.well-known/{name}` on the API origin, which belongs to the server operator. To allow it, add `{name}=<this Installation>` to `ATOMIC_PLUGIN_API_WELL_KNOWN` (or `--plugin-api-well-known`)."
            ),
            Refusal::WellKnownApprovalRequired { name, drive } => format!(
                "The plugin claims `/.well-known/{name}` on the hosts of drive {drive}. Only the drive's owner (an agent with write rights on the drive) can approve that claim."
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
            Refusal::NoDrive => body["mount"] = "drive-host".into(),
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
            Refusal::WellKnownReserved { name } | Refusal::WellKnownUnavailable { name } => {
                body["name"] = name.as_str().into();
            }
            Refusal::WellKnownConflict {
                name,
                other_installation,
            } => {
                body["name"] = name.as_str().into();
                body["otherInstallation"] = other_installation.as_str().into();
            }
            Refusal::WellKnownApprovalRequired { name, drive } => {
                body["name"] = name.as_str().into();
                body["drive"] = drive.as_str().into();
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
        // A drive's host serves the drive: its resources, the app, the
        // server's routes. A route gets a literal first segment none of those
        // use; `/.well-known/` names are claimed, not routed.
        Host::Drive(_) => {
            let Some(first) = literal(0) else {
                return Some(match segments.first() {
                    None => "`/` is the drive itself".into(),
                    Some(_) => "on a drive's host a route must start with a literal segment; every other path may be the drive's".into(),
                });
            };
            if let Some(route) = server_route(first) {
                return Some(format!("`{route}` is a server route on every host"));
            }
            if first == ".well-known" {
                return Some("on a drive's host `/.well-known/` names are claimed in `http.wellKnown`, not routed".into());
            }
            if first == atomic_lib::subject::PLUGIN_ROUTES_SEGMENT || first == "app" {
                return Some(format!("`/{first}` belongs to the server on every host"));
            }
            if atomic_lib::identifiers::is_identifier_resolution_path(&format!("/{first}")) {
                return Some(format!("`/{first}` resolves an identifier"));
            }
            if crate::routes::is_static_asset_segment(first) {
                return Some(format!("`/{first}` serves the app's files"));
            }
            None
        }
        // An installation's own origin is all its own, except the
        // `/.well-known/` names other software on the host would interpret.
        Host::Named(_) => {
            if literal(0) != Some(".well-known") {
                return None;
            }
            match literal(1) {
                Some(name) if SERVER_WELL_KNOWN.contains(&name) => {
                    Some(format!("`/.well-known/{name}` belongs to the server"))
                }
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

pub fn request_segments(path: &str) -> Vec<&str> {
    let path = path.strip_prefix('/').unwrap_or(path);
    if path.is_empty() {
        Vec::new()
    } else {
        path.split('/').collect()
    }
}

/// The host name without a port, lowercased, without a trailing dot.
pub fn host_name(host: &str) -> String {
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
    fn conflict(&self, subject: &str, plan: &Plan) -> Option<Refusal> {
        for other in self.installations.values() {
            if other.subject == subject || other.state != State::Active {
                continue;
            }
            for theirs in &other.claims {
                for ours in &plan.claims {
                    if ours.host != theirs.host || ours.name != theirs.name {
                        continue;
                    }
                    // Shared names clash when one prefix could match what
                    // the other does; exclusive names always.
                    let clash = match (&ours.prefix, &theirs.prefix) {
                        (Some(a), Some(b)) => {
                            a.starts_with(b.as_str()) || b.starts_with(a.as_str())
                        }
                        _ => true,
                    };
                    if clash {
                        return Some(Refusal::WellKnownConflict {
                            name: ours.name.clone(),
                            other_installation: other.subject.clone(),
                        });
                    }
                }
            }
            for theirs in &other.entries {
                for ours in &plan.entries {
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

    fn set(&mut self, subject: &str, mount: Mount, state: State, plan: Plan) {
        self.by_slug.insert(slug(subject), subject.to_string());
        self.installations.insert(
            subject.to_string(),
            Registered {
                subject: subject.to_string(),
                mount,
                state,
                entries: plan.entries,
                claims: plan.claims,
            },
        );
    }

    fn update_state(&mut self, subject: &str, state: State) {
        if let Some(registered) = self.installations.get_mut(subject) {
            registered.state = state;
            registered.entries.clear();
            registered.claims.clear();
        }
    }

    fn active(&self) -> impl Iterator<Item = &Registered> {
        self.installations
            .values()
            .filter(|r| r.state == State::Active)
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

/// Where a matched request runs: the input of [`super::route_exec::execute`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub installation: String,
    /// The mount as far as the request goes: a `drive-host` or
    /// `installation-origin` installation's claim granted on the API origin
    /// is served as on a shared host, like `drive-prefix`.
    pub mount: Mount,
    /// The request path as the installation sees it.
    pub path: String,
    pub route: String,
    /// The `/.well-known/` name the request came in on, when it came in on a
    /// claim rather than on the route's own path.
    pub well_known: Option<String>,
}

/// What a request on a host with plugin mounts gets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Dispatch {
    Run(Target),
    /// `/.well-known/host-meta` (XRD) or `host-meta.json` (JRD), generated
    /// from the host's `webfinger` claims.
    HostMeta {
        json: bool,
    },
    /// `/.well-known/webfinger` without a `resource` parameter: `400`.
    MissingResource,
    Answer(Answer),
}

/// One request, as [`RouteRegistry::dispatch`] needs it.
#[derive(Clone, Copy, Debug)]
pub struct Request<'a> {
    /// The `Host` header.
    pub host: &'a str,
    /// The drive `Tree::DriveMapping` maps the host to, if any.
    pub drive: Option<&'a str>,
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a str,
    pub now: i64,
}

/// `name` of a `/.well-known/<name>` path.
fn well_known_name(path: &str) -> Option<&str> {
    path.strip_prefix("/.well-known/")
        .filter(|name| !name.is_empty() && !name.contains('/'))
}

fn pure(subject: &str) -> String {
    Subject::from(subject).pure_id()
}

/// Which mount a request is on.
enum Located {
    /// An installation's own mount: its slug, the mount, and the host key.
    Mount(String, Mount, Host),
    /// A host shared with the server: the API origin or a drive's host.
    Shared(Host),
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

    /// The gates this registry serves under.
    pub fn config(&self) -> &PluginRoutesConfig {
        &self.config
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

    /// Whether the operator granted `name` on the API origin to `subject`.
    fn api_granted(&self, name: &str, subject: &str) -> bool {
        let subject = pure(subject);
        self.config
            .api_well_known()
            .iter()
            .any(|g| g.name == name && pure(&g.installation) == subject)
    }

    /// What an installation's `http` block registers, or why it can't.
    /// Checks mounts, reserved paths and names, not other installations.
    /// `drive` is the Installation's drive.
    pub fn plan(&self, subject: &str, drive: &str, http: &Http) -> Result<Plan, Refusal> {
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
            Mount::DriveHost if drive.is_empty() => return Err(Refusal::NoDrive),
            Mount::DriveHost => (Host::Drive(pure(drive)), Vec::new()),
        };
        let entries = http
            .routes
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
            .collect::<Result<Vec<_>, _>>()?;

        let mut claims = Vec::new();
        for claim in &http.well_known {
            let name = claim.name.as_str();
            // The manifest refuses these already; the registry does not rely
            // on it.
            let claimable = match claim.kind {
                WellKnownKind::Shared => SHARED_WELL_KNOWN.contains(&name),
                WellKnownKind::Exclusive => EXCLUSIVE_WELL_KNOWN.contains(&name),
            };
            if !claimable || SERVER_WELL_KNOWN.contains(&name) {
                return Err(Refusal::WellKnownReserved { name: name.into() });
            }
            let methods = http
                .routes
                .iter()
                .find(|r| r.id == claim.route)
                .map(|r| r.methods.clone())
                .unwrap_or_default();
            // Its own mount's host, except the API origin (drive-prefix),
            // which is the operator's to grant.
            let mut hosts = Vec::new();
            if http.mount != Mount::DrivePrefix {
                hosts.push(host.clone());
            }
            if self.api_granted(name, subject) {
                hosts.push(Host::Api);
            }
            if hosts.is_empty() {
                return Err(Refusal::WellKnownUnavailable { name: name.into() });
            }
            for host in hosts {
                claims.push(Claim {
                    name: name.into(),
                    host,
                    prefix: claim.matches.as_ref().map(|m| m.resource_prefix.clone()),
                    route: claim.route.clone(),
                    methods: methods.clone(),
                });
            }
        }
        Ok(Plan { entries, claims })
    }

    /// Whether `manifest` may be activated for `subject` on this node, as far
    /// as routes go. A release the gates refuse is left to the installation
    /// hook, which says so with the message of design 0.4.
    pub fn check(&self, subject: &str, drive: &str, manifest: &Manifest) -> Result<(), Refusal> {
        let Some(http) = self.routed(manifest) else {
            return Ok(());
        };
        let plan = self.plan(subject, drive, http)?;
        match self.read().conflict(subject, &plan) {
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
    pub fn activate(&self, subject: &str, drive: &str, manifest: &Manifest) -> State {
        let mount = manifest.http.as_ref().map(|h| h.mount).unwrap_or_default();
        let has_routes = manifest.http.as_ref().is_some_and(|h| !h.routes.is_empty());
        let mut table = self.write();
        let (state, plan) = if !has_routes {
            (State::Active, Plan::default())
        } else if let Err(refusal) = manifest.gate().check(&self.config) {
            (State::Degraded(refusal.message()), Plan::default())
        } else {
            let planned = self
                .plan(subject, drive, manifest.http.as_ref().expect("has routes"))
                .and_then(|plan| match table.conflict(subject, &plan) {
                    Some(conflict) => Err(conflict),
                    None => Ok(plan),
                });
            match planned {
                Ok(plan) => (State::Active, plan),
                Err(refusal) => (State::Degraded(refusal.message()), Plan::default()),
            }
        };
        table.set(subject, mount, state.clone(), plan);
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
            table.set(
                subject,
                Mount::default(),
                State::Retired { at },
                Plan::default(),
            );
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

    /// Which plugin mount a request is for, or `None` when it is not for one
    /// at all.
    fn locate(&self, host: &str, path: &str) -> Option<Located> {
        if !self.enabled() {
            return None;
        }
        if let Some(label) = self.routes_host_label(host) {
            return Some(Located::Mount(
                label,
                Mount::InstallationOrigin,
                Host::Named(host_name(host)),
            ));
        }
        if let [first, rest @ ..] = request_segments(path).as_slice() {
            if *first == atomic_lib::subject::PLUGIN_ROUTES_SEGMENT {
                return Some(Located::Mount(
                    rest.first().map(|s| s.to_string()).unwrap_or_default(),
                    Mount::DrivePrefix,
                    Host::Api,
                ));
            }
        }
        None
    }

    /// [`RouteRegistry::locate`], and for any other path the shared host it
    /// is on: the API origin, or the drive the host is mapped to.
    fn locate_shared(&self, request: &Request) -> Option<Located> {
        if let Some(located) = self.locate(request.host, request.path) {
            return Some(located);
        }
        if !self.enabled() {
            return None;
        }
        if self.config.is_api_host(&host_name(request.host)) {
            return Some(Located::Shared(Host::Api));
        }
        request.drive.map(|d| Located::Shared(Host::Drive(pure(d))))
    }

    /// The installation a request on a plugin mount is for, its mount, and
    /// the request path as the installation sees it (without
    /// `/_routes/<slug>` on `drive-prefix`). Only for a route that
    /// [`RouteRegistry::answer`] matched.
    pub fn target(&self, host: &str, path: &str) -> Option<(String, Mount, String)> {
        let Located::Mount(slug, mount, _) = self.locate(host, path)? else {
            return None;
        };
        let table = self.read();
        let subject = table.by_slug.get(&slug)?.clone();
        let own = match mount {
            Mount::DrivePrefix => {
                let prefix = format!("/{}/{slug}", atomic_lib::subject::PLUGIN_ROUTES_SEGMENT);
                let rest = path.strip_prefix(&prefix).unwrap_or("");
                if rest.is_empty() {
                    "/".to_string()
                } else {
                    rest.to_string()
                }
            }
            _ => path.to_string(),
        };
        Some((subject, mount, own))
    }

    pub fn answer(&self, host: &str, method: &str, path: &str, now: i64) -> Option<Answer> {
        let Located::Mount(slug, mount, key) = self.locate(host, path)? else {
            return None;
        };
        let request = request_segments(path);
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

    /// Whether any active installation answers on a host other than its own
    /// origin or `/_routes/`: a `drive-host` mount, or a claim on a drive's
    /// host or the API origin. When not, a request on such a host needs no
    /// lookup at all.
    pub fn serves_shared_hosts(&self) -> bool {
        self.enabled()
            && self.read().active().any(|r| {
                r.entries.iter().any(|e| matches!(e.host, Host::Drive(_)))
                    || r.claims
                        .iter()
                        .any(|c| matches!(c.host, Host::Drive(_) | Host::Api))
            })
    }

    /// What a request gets from the plugin mounts, or `None` when it is not
    /// theirs and the server serves it as usual.
    ///
    /// - On a routes host and under `/_routes/`: [`RouteRegistry::answer`],
    ///   after the installation's own `/.well-known/` claims.
    /// - On the API origin: the operator-granted claims.
    /// - On a host mapped to a drive: that drive's claims and `drive-host`
    ///   routes. Any other path is the drive's.
    pub fn dispatch(&self, request: &Request) -> Option<Dispatch> {
        let located = self.locate_shared(request)?;
        let well_known = well_known_name(request.path);
        let key = match located {
            Located::Mount(_, Mount::InstallationOrigin, key) => {
                if let Some(dispatch) =
                    well_known.and_then(|name| self.claimed(&key, name, request))
                {
                    return Some(dispatch);
                }
                return Some(self.run_or_answer(request));
            }
            Located::Mount(..) => return Some(self.run_or_answer(request)),
            Located::Shared(key) => key,
        };
        if let Some(name) = well_known {
            if let Some(dispatch) = self.claimed(&key, name, request) {
                return Some(dispatch);
            }
        }
        if !matches!(key, Host::Drive(_)) {
            return None;
        }
        let segments = request_segments(request.path);
        let table = self.read();
        let mut allow: Vec<String> = Vec::new();
        for registered in table.active() {
            for entry in registered.entries.iter().filter(|e| e.host == key) {
                if !matches(&entry.segments, &segments) {
                    continue;
                }
                if entry.methods.iter().any(|m| m == request.method) {
                    return Some(Dispatch::Run(Target {
                        installation: registered.subject.clone(),
                        mount: Mount::DriveHost,
                        path: request.path.to_string(),
                        route: entry.route.clone(),
                        well_known: None,
                    }));
                }
                allow.extend(entry.methods.iter().cloned());
            }
        }
        if allow.is_empty() {
            return None;
        }
        allow.sort();
        allow.dedup();
        Some(Dispatch::Answer(Answer::MethodNotAllowed { allow }))
    }

    /// [`RouteRegistry::answer`] and [`RouteRegistry::target`] together.
    fn run_or_answer(&self, request: &Request) -> Dispatch {
        let answer = self
            .answer(request.host, request.method, request.path, request.now)
            .unwrap_or(Answer::NotFound);
        let Answer::Matched { route } = answer else {
            return Dispatch::Answer(answer);
        };
        match self.target(request.host, request.path) {
            Some((installation, mount, path)) => Dispatch::Run(Target {
                installation,
                mount,
                path,
                route,
                well_known: None,
            }),
            None => Dispatch::Answer(Answer::NotFound),
        }
    }

    /// `/.well-known/<name>` on `host`, if an active installation claimed it
    /// there. `None` leaves the path to the host's other handlers.
    fn claimed(&self, host: &Host, name: &str, request: &Request) -> Option<Dispatch> {
        let table = self.read();
        let claims: Vec<(&Registered, &Claim)> = table
            .active()
            .flat_map(|r| r.claims.iter().map(move |c| (r, c)))
            .filter(|(_, c)| &c.host == host)
            .collect();
        if let Some(format) = name.strip_prefix("host-meta") {
            if !claims.iter().any(|(_, c)| c.name == "webfinger") || !matches!(format, "" | ".json")
            {
                return None;
            }
            if !matches!(request.method, "GET" | "HEAD") {
                return Some(Dispatch::Answer(Answer::MethodNotAllowed {
                    allow: vec!["GET".into(), "HEAD".into()],
                }));
            }
            return Some(Dispatch::HostMeta {
                json: format == ".json",
            });
        }
        let named: Vec<&(&Registered, &Claim)> =
            claims.iter().filter(|(_, c)| c.name == name).collect();
        let (registered, claim) = if SHARED_WELL_KNOWN.contains(&name) {
            if named.is_empty() {
                return None;
            }
            // `webfinger`: the `resource` parameter picks the installation.
            // Nobody else sees the query.
            let Some(resource) = url::form_urlencoded::parse(request.query.as_bytes())
                .find(|(k, _)| k == "resource")
                .map(|(_, v)| v.into_owned())
            else {
                return Some(Dispatch::MissingResource);
            };
            match named
                .iter()
                .find(|(_, c)| c.prefix.as_deref().is_some_and(|p| resource.starts_with(p)))
            {
                Some(found) => **found,
                None => return Some(Dispatch::Answer(Answer::NotFound)),
            }
        } else {
            **named.first()?
        };
        if !claim.methods.iter().any(|m| m == request.method) {
            let mut allow = claim.methods.clone();
            allow.sort();
            return Some(Dispatch::Answer(Answer::MethodNotAllowed { allow }));
        }
        Some(Dispatch::Run(Target {
            installation: registered.subject.clone(),
            mount: match host {
                Host::Named(_) => Mount::InstallationOrigin,
                Host::Drive(_) => Mount::DriveHost,
                Host::Api => Mount::DrivePrefix,
            },
            path: request.path.to_string(),
            route: claim.route.clone(),
            well_known: Some(name.to_string()),
        }))
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
                    self.write()
                        .set(&subject, mount, State::Paused, Plan::default());
                    continue;
                }
                // Revoked or gone while this node was down.
                _ => {
                    self.retire(&subject, now);
                    persist(store, &subject, Some(now));
                    super::route_delivery::drop_installation(store, &subject);
                    continue;
                }
            }
            let manifest = resource.as_ref().and_then(|r| pinned_manifest(store, r));
            let drive = resource.as_ref().map(drive_of).unwrap_or_default();
            let state = match manifest {
                Some(manifest) => self.activate(&subject, &drive, &manifest),
                None => {
                    let state = State::Degraded("the pinned release is not on this node".into());
                    self.write()
                        .set(&subject, Mount::default(), state.clone(), Plan::default());
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
        let drive = drive_of(resource);
        self.check(&subject, &drive, &manifest)
            .map_err(|refusal| refusal.message())?;
        if let Some(http) = self
            .routed(&manifest)
            .filter(|h| h.mount == Mount::DriveHost)
        {
            check_drive_host(store, &drive, http, commit.signer.as_str())
                .await
                .map_err(|refusal| refusal.message())?;
        }
        Ok(())
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
            // Keys and tokens go with the identity (design 2.9): erased
            // wherever they exist, with the revocation tombstone.
            let keys = super::route_keys::erase(store, &subject);
            let tokens = super::route_tokens::erase(store, &subject);
            if keys + tokens > 0 {
                tracing::info!(%subject, keys, tokens, "erased plugin route keys and tokens");
            }
            // Its queued deliveries go too (#1719): nobody may send in the
            // name of a revoked installation.
            let deliveries = super::route_delivery::drop_installation(store, &subject);
            if deliveries > 0 {
                tracing::info!(%subject, deliveries, "dropped queued plugin deliveries");
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
        match self.activate(&subject, &drive_of(resource), &manifest) {
            State::Degraded(reason) => {
                tracing::warn!(%subject, "plugin routes not registered: {reason}")
            }
            _ => tracing::info!(%subject, slug = %slug(&subject), "plugin routes registered"),
        }
        persist(store, &subject, None);
        // Deliveries held while it was paused go out again.
        super::route_delivery::resume(store, &subject, atomic_lib::utils::now());
        // Keys are generated on activation, on the node that serves the
        // routes (design 2.9, D3). An upgrade keeps them.
        let keys = manifest
            .http
            .as_ref()
            .map(|h| h.keys.as_slice())
            .unwrap_or_default();
        if !keys.is_empty() && self.config().allows(PluginRoutesLevel::ReadWrite) {
            match super::route_keys::ensure(store, &subject, keys) {
                Ok(generated) if !generated.is_empty() => {
                    tracing::info!(%subject, ?generated, "generated plugin route keys")
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(%subject, "could not generate plugin route keys: {e}"),
            }
        }
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

/// The Installation's drive: its parent.
fn drive_of(resource: &Resource) -> String {
    string_value(resource, urls::PARENT).unwrap_or_default()
}

/// The activation checks of a `drive-host` installation that need the store:
///
/// - a route whose literal start is a path of the drive (a resource's
///   `path`, or a chain of shortnames) is refused, since that subtree is the
///   drive's;
/// - an exclusive `/.well-known/` claim needs the drive owner's approval:
///   the activation must be signed by an agent with write rights on the
///   drive itself.
///
/// Resources created at a route's path later are shadowed on the drive's
/// hosts; like every collision, this is decided at activation (design 2.3).
pub async fn check_drive_host(
    store: &Db,
    drive: &str,
    http: &Http,
    signer: &str,
) -> Result<(), Refusal> {
    let drive_subject: Subject = drive.into();
    for route in &http.routes {
        let Ok(segments) = pattern(&route.path) else {
            continue;
        };
        let mut path = String::new();
        for segment in segments {
            let Segment::Literal(literal) = segment else {
                break;
            };
            path.push('/');
            path.push_str(&literal);
            if store
                .get_resource_at_path(&drive_subject, &path)
                .await
                .is_ok()
            {
                return Err(Refusal::Reserved {
                    route: route.id.clone(),
                    path: route.path.clone(),
                    reason: format!("`{path}` is a path of the drive's own resources"),
                });
            }
        }
    }
    if let Some(claim) = http
        .well_known
        .iter()
        .find(|c| c.kind == WellKnownKind::Exclusive)
    {
        let owner = match store.get_resource(&drive_subject).await {
            Ok(resource) => atomic_lib::hierarchy::check_write(
                store,
                &resource,
                &ForAgent::AgentSubject(signer.to_string().into()),
            )
            .await
            .is_ok(),
            Err(_) => false,
        };
        if !owner {
            return Err(Refusal::WellKnownApprovalRequired {
                name: claim.name.clone(),
                drive: drive.to_string(),
            });
        }
    }
    Ok(())
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
pub(crate) fn pinned_manifest(store: &Db, resource: &Resource) -> Option<Manifest> {
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
    const DRIVE: &str = "did:ad:driveD";

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
        r.check(A, DRIVE, &m).unwrap();
        assert_eq!(r.activate(A, DRIVE, &m), State::Active);
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
        assert_eq!(r.activate(A, DRIVE, &m), State::Active);
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
        let refusal = r.check(A, DRIVE, &m).unwrap_err();
        assert_eq!(refusal, Refusal::RoutesOriginUnavailable);
        assert!(refusal.message().contains("ATOMIC_ROUTES_ORIGIN"));
        assert_eq!(refusal.to_json()["type"], "routes-origin-unavailable");
        // drive-prefix works without one.
        let m = manifest(serde_json::json!({"mount": "drive-prefix", "routes": [get("/x", "x")]}));
        r.check(A, DRIVE, &m).unwrap();
    }

    #[test]
    fn drive_host_needs_a_drive() {
        let r = registry(ReadOnly);
        let m = manifest(serde_json::json!({"mount": "drive-host", "routes": [get("/x", "x")]}));
        assert_eq!(r.check(A, "", &m).unwrap_err(), Refusal::NoDrive);
        r.check(A, DRIVE, &m).unwrap();
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
            let refusal = r.check(A, DRIVE, &m).unwrap_err();
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
            r.check(A, DRIVE, &m)
                .unwrap_or_else(|e| panic!("{path}: {e}"));
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
        let plan = |entries: Vec<Entry>| Plan {
            entries,
            claims: Vec::new(),
        };
        r.write().set(
            A,
            Mount::InstallationOrigin,
            State::Active,
            plan(vec![entry("actor", "/users/{a}", &["GET"])]),
        );
        let table = r.read();
        let refusal = table
            .conflict(B, &plan(vec![entry("me", "/users/me", &["GET", "HEAD"])]))
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
            .conflict(B, &plan(vec![entry("w", "/users/{a}", &["POST"])]))
            .is_none());
        assert!(table
            .conflict(B, &plan(vec![entry("i", "/users/{a}/inbox", &["GET"])]))
            .is_none());
        assert!(table
            .conflict(A, &plan(vec![entry("me", "/users/me", &["GET"])]))
            .is_none());
        let elsewhere = Entry {
            host: Host::Named("other.example".into()),
            ..entry("me", "/users/me", &["GET"])
        };
        assert!(table.conflict(B, &plan(vec![elsewhere])).is_none());
        drop(table);
        // A paused or retired installation holds no routes.
        r.pause(A);
        assert!(r
            .read()
            .conflict(B, &plan(vec![entry("me", "/users/me", &["GET"])]))
            .is_none());
    }

    #[test]
    fn lifecycle_answers_paused_gone_and_not_found() {
        let r = registry(ReadOnly);
        let m = manifest(serde_json::json!({"mount": "drive-prefix", "routes": [get("/x", "x")]}));
        r.activate(A, DRIVE, &m);
        let path = format!("/_routes/{}/x", slug(A));
        let at = |now| r.answer("localhost", "GET", &path, now);
        assert!(matches!(at(0), Some(Answer::Matched { .. })));

        r.pause(A);
        assert_eq!(r.state(A), Some(State::Paused));
        assert_eq!(at(0), Some(Answer::Paused));

        // Resuming re-registers.
        assert_eq!(r.activate(A, DRIVE, &m), State::Active);
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
            matches!(r.activate(A, DRIVE, &m), State::Degraded(reason) if reason.contains("read-write"))
        );
        let path = format!("/_routes/{}/x", slug(A));
        assert_eq!(
            r.answer("localhost", "POST", &path, 0),
            Some(Answer::NotFound)
        );
        // `check` leaves the refusal to the installation hook's gate message.
        r.check(B, DRIVE, &m).unwrap();
    }

    #[test]
    fn nothing_answers_when_the_level_is_off() {
        let r = registry(Off);
        assert!(!r.enabled());
        let m = manifest(serde_json::json!({"mount": "drive-prefix", "routes": [get("/x", "x")]}));
        r.activate(A, DRIVE, &m);
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

    // -- well-known claims and the drive-host mount (#1716) -------------------

    const ALICE: &str = "alice.example";
    const OTHER_DRIVE: &str = "did:ad:driveE";

    fn at<'a>(host: &'a str, drive: Option<&'a str>, method: &'a str, url: &'a str) -> Request<'a> {
        let (path, query) = url.split_once('?').unwrap_or((url, ""));
        Request {
            host,
            drive,
            method,
            path,
            query,
            now: 0,
        }
    }

    /// A plugin on `mount` with routes `/wk-<prefix>/nodeinfo` and
    /// `/wk-<prefix>/webfinger` (the prefix's letters: every plugin needs its
    /// own paths on a shared host), claiming `nodeinfo` (unless `nodeinfo` is
    /// false) and `webfinger` for `prefix`.
    fn claims(mount: &str, prefix: &str, nodeinfo: bool) -> Manifest {
        let base: String = prefix.chars().filter(char::is_ascii_alphanumeric).collect();
        let mut well_known = vec![serde_json::json!({
            "name": "webfinger", "kind": "shared",
            "match": {"resourcePrefix": prefix}, "route": "webfinger"
        })];
        if nodeinfo {
            well_known.push(
                serde_json::json!({"name": "nodeinfo", "kind": "exclusive", "route": "nodeinfo"}),
            );
        }
        manifest(serde_json::json!({
            "mount": mount,
            "routes": [
                get(&format!("/wk-{base}/nodeinfo"), "nodeinfo"),
                get(&format!("/wk-{base}/webfinger"), "webfinger"),
            ],
            "wellKnown": well_known,
        }))
    }

    fn ran(dispatch: Option<Dispatch>) -> Target {
        match dispatch {
            Some(Dispatch::Run(target)) => target,
            other => panic!("expected a run, got {other:?}"),
        }
    }

    #[test]
    fn claims_dispatch_on_the_drives_hosts() {
        let r = registry(ReadOnly);
        assert!(!r.serves_shared_hosts());
        assert_eq!(
            r.activate(A, DRIVE, &claims("drive-host", "acct:alice@", true)),
            State::Active
        );
        assert_eq!(
            r.activate(B, DRIVE, &claims("drive-host", "acct:bob@", false)),
            State::Active
        );
        assert!(r.serves_shared_hosts());
        let on = |method, url| r.dispatch(&at(ALICE, Some(DRIVE), method, url));

        let nodeinfo = ran(on("GET", "/.well-known/nodeinfo"));
        assert_eq!(
            nodeinfo,
            Target {
                installation: A.into(),
                mount: Mount::DriveHost,
                path: "/.well-known/nodeinfo".into(),
                route: "nodeinfo".into(),
                well_known: Some("nodeinfo".into()),
            }
        );
        assert_eq!(
            on("POST", "/.well-known/nodeinfo"),
            Some(Dispatch::Answer(Answer::MethodNotAllowed {
                allow: vec!["GET".into(), "HEAD".into()]
            }))
        );

        // webfinger: the resource picks the installation.
        let alice = ran(on(
            "GET",
            "/.well-known/webfinger?resource=acct%3Aalice%40alice.example&rel=self",
        ));
        assert_eq!(
            (alice.installation.as_str(), alice.route.as_str()),
            (A, "webfinger")
        );
        let bob = ran(on(
            "GET",
            "/.well-known/webfinger?resource=acct:bob@alice.example",
        ));
        assert_eq!(bob.installation, B);
        assert_eq!(
            on(
                "GET",
                "/.well-known/webfinger?resource=acct:carol@alice.example"
            ),
            Some(Dispatch::Answer(Answer::NotFound))
        );
        assert_eq!(
            on("GET", "/.well-known/webfinger?rel=self"),
            Some(Dispatch::MissingResource)
        );

        // host-meta is generated from the webfinger claims.
        assert_eq!(
            on("GET", "/.well-known/host-meta"),
            Some(Dispatch::HostMeta { json: false })
        );
        assert_eq!(
            on("HEAD", "/.well-known/host-meta.json"),
            Some(Dispatch::HostMeta { json: true })
        );
        // Names nobody claimed, and other paths, are the server's.
        assert_eq!(on("GET", "/.well-known/ocm"), None);
        assert_eq!(on("GET", "/.well-known/host-meta.xml"), None);
        assert_eq!(on("GET", "/some/resource"), None);

        // The routes themselves, on their own paths.
        let own = ran(on("GET", "/wk-acctalice/nodeinfo"));
        assert_eq!((own.installation.as_str(), own.well_known), (A, None));
        assert_eq!(
            on("DELETE", "/wk-acctbob/webfinger"),
            Some(Dispatch::Answer(Answer::MethodNotAllowed {
                allow: vec!["GET".into(), "HEAD".into()]
            }))
        );

        // Not on another drive's host, not on an unmapped host, and not on
        // the API origin even though it maps to the same drive.
        for (host, drive) in [
            ("bob.example", Some(OTHER_DRIVE)),
            ("nobody.example", None),
            ("localhost:9883", Some(DRIVE)),
            ("127.0.0.1", Some(DRIVE)),
        ] {
            assert_eq!(
                r.dispatch(&at(host, drive, "GET", "/.well-known/nodeinfo")),
                None,
                "{host}"
            );
            assert_eq!(
                r.dispatch(&at(host, drive, "GET", "/wk-acctalice/nodeinfo")),
                None,
                "{host}"
            );
        }

        // A paused installation holds nothing.
        r.pause(A);
        assert_eq!(on("GET", "/.well-known/nodeinfo"), None);
        assert_eq!(on("GET", "/wk-acctalice/nodeinfo"), None);
        assert_eq!(
            ran(on("GET", "/.well-known/webfinger?resource=acct:bob@x")).installation,
            B
        );
    }

    #[test]
    fn an_installations_own_origin_answers_its_claims() {
        let r = registry(ReadOnly);
        r.activate(A, DRIVE, &claims("installation-origin", "acct:", true));
        let host = format!("{}.routes.localhost:9883", slug(A));
        let target = ran(r.dispatch(&at(&host, None, "GET", "/.well-known/nodeinfo")));
        assert_eq!(target.mount, Mount::InstallationOrigin);
        assert_eq!(target.well_known.as_deref(), Some("nodeinfo"));
        assert_eq!(
            r.dispatch(&at(&host, None, "GET", "/.well-known/host-meta")),
            Some(Dispatch::HostMeta { json: false })
        );
        // Anything else on its origin is still its routes, or 404.
        assert_eq!(
            ran(r.dispatch(&at(&host, None, "GET", "/wk-acct/nodeinfo"))).well_known,
            None
        );
        assert_eq!(
            r.dispatch(&at(&host, None, "GET", "/.well-known/ocm")),
            Some(Dispatch::Answer(Answer::NotFound))
        );
        // Its claims are not on the drive's hosts or the API origin.
        assert_eq!(
            r.dispatch(&at(ALICE, Some(DRIVE), "GET", "/.well-known/nodeinfo")),
            None
        );
        assert!(!r.serves_shared_hosts());
    }

    #[test]
    fn a_second_exclusive_claim_on_one_host_is_refused() {
        let r = registry(ReadOnly);
        r.activate(A, DRIVE, &claims("drive-host", "acct:alice@", true));
        let refusal = r
            .check(B, DRIVE, &claims("drive-host", "acct:bob@", true))
            .unwrap_err();
        assert_eq!(
            refusal,
            Refusal::WellKnownConflict {
                name: "nodeinfo".into(),
                other_installation: A.into(),
            }
        );
        assert!(refusal.message().contains(A), "{refusal}");
        assert_eq!(refusal.to_json()["type"], "well-known-conflict");
        assert_eq!(refusal.to_json()["name"], "nodeinfo");
        // Activating anyway (a peer's order of events) degrades instead.
        assert!(matches!(
            r.activate(B, DRIVE, &claims("drive-host", "acct:bob@", true)),
            State::Degraded(_)
        ));

        // Overlapping webfinger prefixes would see each other's queries.
        for prefix in ["acct:", "acct:alice@alice.example"] {
            let refusal = r
                .check(B, DRIVE, &claims("drive-host", prefix, false))
                .unwrap_err();
            assert!(
                matches!(&refusal, Refusal::WellKnownConflict { name, .. } if name == "webfinger"),
                "{prefix}: {refusal:?}"
            );
        }
        r.check(B, DRIVE, &claims("drive-host", "acct:alicia@", false))
            .unwrap();
        // Another drive's hosts, or an installation's own origin, are other
        // hosts.
        r.check(B, OTHER_DRIVE, &claims("drive-host", "acct:alice@", true))
            .unwrap();
        r.check(
            B,
            DRIVE,
            &claims("installation-origin", "acct:alice@", true),
        )
        .unwrap();
        // Once the holder is paused, the name is free.
        r.pause(A);
        r.check(B, DRIVE, &claims("drive-host", "acct:alice@", true))
            .unwrap();
    }

    #[test]
    fn server_owned_and_unlisted_names_are_refused() {
        // The manifest refuses them at install and pin.
        for (name, kind) in [
            ("acme-challenge", "exclusive"),
            ("host-meta", "exclusive"),
            ("host-meta.json", "exclusive"),
            ("change-password", "exclusive"),
            ("security.txt", "exclusive"),
            ("webfinger", "exclusive"),
            ("nodeinfo", "shared"),
        ] {
            let parsed = Manifest::parse(serde_json::json!({
                "schemaVersion": 3,
                "http": {
                    "mount": "drive-host",
                    "routes": [get("/wk/x", "x")],
                    "wellKnown": [{"name": name, "kind": kind, "route": "x",
                        "match": if kind == "shared" { serde_json::json!({"resourcePrefix": "acct:"}) } else { serde_json::Value::Null }}],
                },
            }));
            assert!(parsed.is_err(), "{name} as {kind}: {parsed:?}");
        }
        // The registry does not rely on the manifest for it.
        let r = registry(ReadOnly);
        for name in ["acme-challenge", "host-meta", "security.txt"] {
            let http: Http = serde_json::from_value(serde_json::json!({
                "mount": "drive-host",
                "routes": [get("/wk/x", "x")],
                "wellKnown": [{"name": name, "kind": "exclusive", "route": "x"}],
            }))
            .unwrap();
            let refusal = r.plan(A, DRIVE, &http).unwrap_err();
            assert_eq!(refusal, Refusal::WellKnownReserved { name: name.into() });
            assert_eq!(refusal.to_json()["type"], "well-known-reserved");
        }
        // Nor may a route on an installation's own origin take them.
        for path in ["/.well-known/host-meta", "/.well-known/acme-challenge/{t}"] {
            let m = manifest(serde_json::json!({"routes": [get(path, "x")]}));
            assert!(
                matches!(r.check(A, DRIVE, &m), Err(Refusal::Reserved { .. })),
                "{path}"
            );
        }
    }

    #[test]
    fn drive_host_routes_only_take_paths_the_server_does_not_use() {
        let r = registry(ReadOnly);
        let on_drive = |path: &str| {
            r.check(
                A,
                DRIVE,
                &manifest(serde_json::json!({"mount": "drive-host", "routes": [get(path, "x")]})),
            )
        };
        let mut reserved = vec![
            "/",
            "/{name}",
            "/{*rest}",
            "/commit",
            "/ws",
            "/search",
            "/plugin-run/x",
            "/integration-actions",
            "/_routes/x",
            "/app/x",
            "/.well-known/nodeinfo",
            "/.well-known/acme-challenge/{token}",
            "/did:ad:x",
        ];
        if crate::routes::is_static_asset_segment("index.html") {
            reserved.push("/index.html");
        }
        for path in reserved {
            let refusal = on_drive(path).unwrap_err();
            assert!(
                matches!(&refusal, Refusal::Reserved { route, .. } if route == "x"),
                "{path}: {refusal:?}"
            );
            assert_eq!(refusal.to_json()["type"], "route-path-reserved");
        }
        for path in [
            "/users/{name}",
            "/nodeinfo/2.1",
            "/@alice",
            "/files/{*rest}",
        ] {
            on_drive(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        }
        // Two installations on one drive collide like on any host.
        r.activate(
            A,
            DRIVE,
            &manifest(serde_json::json!({"mount": "drive-host", "routes": [get("/users/{name}", "actor")]})),
        );
        let refusal = r
            .check(
                B,
                DRIVE,
                &manifest(
                    serde_json::json!({"mount": "drive-host", "routes": [get("/users/me", "me")]}),
                ),
            )
            .unwrap_err();
        assert!(matches!(refusal, Refusal::Conflict { .. }), "{refusal:?}");
        r.check(
            B,
            OTHER_DRIVE,
            &manifest(
                serde_json::json!({"mount": "drive-host", "routes": [get("/users/me", "me")]}),
            ),
        )
        .unwrap();
    }

    #[test]
    fn claims_on_the_api_origin_need_the_operators_grant() {
        let r = registry(ReadOnly);
        let prefixed = claims("drive-prefix", "acct:", true);
        let refusal = r.check(A, DRIVE, &prefixed).unwrap_err();
        assert!(
            matches!(&refusal, Refusal::WellKnownUnavailable { .. }),
            "{refusal:?}"
        );
        assert!(
            refusal.message().contains("ATOMIC_PLUGIN_API_WELL_KNOWN"),
            "{refusal}"
        );
        assert_eq!(refusal.to_json()["type"], "well-known-unavailable");

        let granted = RouteRegistry::new(
            resolve(
                PluginRoutesOptions {
                    level: ReadOnly,
                    api_well_known: Some(&format!("nodeinfo={A},webfinger={A},webfinger={B}")),
                    ..Default::default()
                },
                true,
                API,
            )
            .unwrap(),
        );
        assert_eq!(granted.activate(A, DRIVE, &prefixed), State::Active);
        assert!(granted.serves_shared_hosts());
        let target = ran(granted.dispatch(&at(
            "localhost:9883",
            Some(DRIVE),
            "GET",
            "/.well-known/nodeinfo",
        )));
        assert_eq!(target.installation, A);
        // Served as on a shared host: no cookies, no HTML.
        assert_eq!(target.mount, Mount::DrivePrefix);
        assert_eq!(
            granted.dispatch(&at("localhost", None, "GET", "/.well-known/host-meta")),
            Some(Dispatch::HostMeta { json: false })
        );
        // Not on a drive's host: a drive-prefix installation has none.
        assert_eq!(
            granted.dispatch(&at(ALICE, Some(DRIVE), "GET", "/.well-known/nodeinfo")),
            None
        );
        // B has only the webfinger grant.
        assert!(matches!(
            granted.check(B, DRIVE, &claims("drive-prefix", "https:", true)),
            Err(Refusal::WellKnownUnavailable { name }) if name == "nodeinfo"
        ));
        granted
            .check(B, DRIVE, &claims("drive-prefix", "https:", false))
            .unwrap();
        // A drive-host installation with a grant answers on both.
        let both = RouteRegistry::new(
            resolve(
                PluginRoutesOptions {
                    level: ReadOnly,
                    api_well_known: Some(&format!("nodeinfo={A}")),
                    ..Default::default()
                },
                true,
                API,
            )
            .unwrap(),
        );
        both.activate(A, DRIVE, &claims("drive-host", "acct:", true));
        for host in [ALICE, "localhost"] {
            ran(both.dispatch(&at(host, Some(DRIVE), "GET", "/.well-known/nodeinfo")));
        }
    }

    #[test]
    fn nothing_is_dispatched_when_the_level_is_off() {
        let r = registry(Off);
        r.activate(A, DRIVE, &claims("drive-host", "acct:", true));
        assert!(!r.serves_shared_hosts());
        for (host, url) in [
            (ALICE, "/.well-known/nodeinfo"),
            (ALICE, "/.well-known/host-meta"),
            (ALICE, "/wk-acct/nodeinfo"),
            ("localhost", "/.well-known/webfinger?resource=acct:x"),
        ] {
            assert_eq!(
                r.dispatch(&at(host, Some(DRIVE), "GET", url)),
                None,
                "{url}"
            );
        }
    }
}
