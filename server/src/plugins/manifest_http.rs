//! The `http` block of a version-three manifest: the public endpoints a
//! plugin asks the host to open, and which gates they need.
//!
//! Design: atomic-plugins `docs/design/server-plugin-routes.md`, sections 0.1,
//! 0.4, 1 and 2.2. Parsing, validation and the gate computation are compiled
//! into every build that can install plugins, not only into builds with the
//! `plugin-routes` feature: a node without the feature must still be able to
//! say precisely why it refuses a release, instead of "unknown field". Nothing
//! here serves a request.
//!
//! `browser/lib/src/plugin-manifest.ts` mirrors this file. Both are checked
//! against `testdata/plugin-manifest/http-index.json` (acceptance, errors,
//! gates, derived `requires`) and `http-refusals.json` (the refusal problem
//! and its message).
use crate::plugin_routes::{PluginRoutesConfig, PluginRoutesLevel};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};

/// Routes one installation may declare (*proposed* in the design).
pub const MAX_ROUTES: usize = 32;
/// Largest inline request body a route may accept.
pub const MAX_INLINE_BODY_BYTES: u64 = 1_048_576;
/// Longest route deadline, with an `extended-*` grant.
pub const MAX_TIMEOUT_MS: u64 = 30_000;
/// Methods a route may answer.
pub const METHODS: [&str; 6] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/// The claimable `/.well-known/` names (design 2.4). Defined next to the
/// gates, which the operator's API-origin grants are checked against in every
/// build.
pub use crate::plugin_routes::{EXCLUSIVE_WELL_KNOWN, SHARED_WELL_KNOWN};

#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Http {
    #[serde(default, skip_serializing_if = "is_default")]
    pub mount: Mount,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub routes: Vec<Route>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub well_known: Vec<WellKnown>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub write_targets: Vec<WriteTarget>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<Key>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tokens: Vec<Token>,
    /// Raw ports, only for `world: server-extension`. The operator binds each
    /// one (`ATOMIC_PLUGIN_LISTENERS`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub listeners: Vec<OperatorNamed>,
    /// Loopback daemons the operator runs next to the server
    /// (`ATOMIC_PLUGIN_SIDECARS`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sidecars: Vec<OperatorNamed>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn is_default<T: Default + PartialEq>(value: &T) -> bool {
    *value == T::default()
}

impl Http {
    /// Left out of the serialized manifest when it holds nothing, so a
    /// manifest's release id does not depend on an empty block.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// `skip_serializing_if` for the manifest's `http` field.
pub fn http_is_empty(http: &Option<Http>) -> bool {
    http.as_ref().is_none_or(Http::is_empty)
}

/// Which namespace the routes live in (design 2.3). The operator decides
/// which exist; the manifest says which the package can work with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mount {
    #[default]
    InstallationOrigin,
    DriveHost,
    DrivePrefix,
}

/// As whom the handler reads and writes (design 2.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Principal {
    #[default]
    Anonymous,
    Installation,
    Caller,
}

/// What the host verifies before the sandbox starts (design 2.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Auth {
    #[default]
    None,
    Atomic,
    HttpSignature,
    Bearer,
    Dpop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Cors {
    #[default]
    None,
    AnyOriginNoCredentials,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Body {
    Json,
    Text,
    /// The host stores the body; the handler gets a hash.
    Blob,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Route {
    pub id: String,
    /// Literal segments, `{param}`, and a trailing `{*rest}`. No regex.
    pub path: String,
    pub methods: Vec<String>,
    #[serde(default, skip_serializing_if = "is_default")]
    pub principal: Principal,
    #[serde(default, skip_serializing_if = "is_default")]
    pub auth: Auth,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accept: Vec<String>,
    #[serde(default, skip_serializing_if = "is_default")]
    pub cors: Cors,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_body_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Body>,
    /// Ids from `http.writeTargets`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub writes: Vec<String>,
    /// Ids of declared write operations this route may schedule.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enqueues: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl Route {
    /// Only `GET`/`HEAD`, anonymous, unauthenticated, without writes,
    /// deliveries or a body: what `--plugin-routes read-only` allows.
    fn is_read_only(&self) -> bool {
        self.methods.iter().all(|m| m == "GET" || m == "HEAD")
            && self.principal == Principal::Anonymous
            && self.auth == Auth::None
            && self.writes.is_empty()
            && self.enqueues.is_empty()
            && self.body.is_none()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WellKnownKind {
    Shared,
    Exclusive,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WellKnownMatch {
    pub resource_prefix: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WellKnown {
    pub name: String,
    pub kind: WellKnownKind,
    #[serde(default, rename = "match", skip_serializing_if = "Option::is_none")]
    pub matches: Option<WellKnownMatch>,
    /// The route that answers the claim.
    pub route: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteTarget {
    pub id: String,
    /// `config:<key>`, or a resource URL.
    pub parent: String,
    pub classes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeyAlg {
    RsaSha256,
    Ed25519,
}

/// A host-held keypair. The plugin never reads the private half.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Key {
    pub name: String,
    pub alg: KeyAlg,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A host-held store of hashed bearer tokens the plugin issues.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Token {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A listener or sidecar: something the operator configures by this name.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperatorNamed {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Route ids, write targets, keys, tokens, listeners and sidecars: the same
/// shape as the operator's `ATOMIC_PLUGIN_LISTENERS` names.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn unique_names<'a>(
    names: impl IntoIterator<Item = &'a str>,
    what: &str,
) -> Result<HashSet<&'a str>, String> {
    let mut seen = HashSet::new();
    for name in names {
        if !valid_name(name) || !seen.insert(name) {
            return Err(format!(
                "{what} must be names (lowercase letters, digits and -) and unique"
            ));
        }
    }
    Ok(seen)
}

/// One segment of a route path pattern, normalized: parameter names are
/// dropped, so `/users/{a}` and `/users/{b}` are the same pattern.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Segment {
    Literal(String),
    Param,
    Rest,
}

/// Parses a route path pattern into segments.
pub fn pattern(path: &str) -> Result<Vec<Segment>, String> {
    let invalid = || {
        format!(
            "route path `{path}` must be `/`-separated literal segments, `{{param}}` and a trailing `{{*rest}}`, without regex"
        )
    };
    let rest = path.strip_prefix('/').ok_or_else(invalid)?;
    if path.len() > 256 {
        return Err(invalid());
    }
    if rest.is_empty() {
        return Ok(Vec::new());
    }
    let identifier = |s: &str| {
        s.bytes()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
            && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
    };
    let literal = |s: &str| {
        s != "."
            && s != ".."
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-._~:@!,;=".contains(&c))
    };
    let raw: Vec<&str> = rest.split('/').collect();
    let mut params = HashSet::new();
    let mut segments = Vec::new();
    for (i, segment) in raw.iter().enumerate() {
        if let Some(name) = segment.strip_prefix("{*").and_then(|s| s.strip_suffix('}')) {
            if i + 1 != raw.len() || !identifier(name) || !params.insert(name) {
                return Err(invalid());
            }
            segments.push(Segment::Rest);
        } else if let Some(name) = segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
            if !identifier(name) || !params.insert(name) {
                return Err(invalid());
            }
            segments.push(Segment::Param);
        } else if !segment.is_empty() && literal(segment) {
            segments.push(Segment::Literal(segment.to_string()));
        } else {
            return Err(invalid());
        }
    }
    Ok(segments)
}

/// Whether some request path matches both patterns. `{*rest}` matches one or
/// more segments.
pub fn overlaps(a: &[Segment], b: &[Segment]) -> bool {
    match (a.first(), b.first()) {
        (None, None) => true,
        (Some(Segment::Rest), other) | (other, Some(Segment::Rest)) => other.is_some(),
        (None, _) | (_, None) => false,
        (Some(Segment::Literal(x)), Some(Segment::Literal(y))) if x != y => false,
        _ => overlaps(&a[1..], &b[1..]),
    }
}

/// An operation whose destination comes from data: `https://*/inbox`.
pub fn is_wildcard_host(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| u.host_str() == Some("*"))
}

/// What [`Http::validate`] needs from the rest of the manifest.
pub struct Context<'a> {
    pub server_extension: bool,
    /// `(id, effect, url)` of each declared operation.
    pub operations: Vec<(&'a str, &'a str, &'a str)>,
}

impl Http {
    pub fn validate(&self, context: &Context) -> Result<(), String> {
        if self.routes.len() > MAX_ROUTES {
            return Err(format!(
                "at most {MAX_ROUTES} routes per installation, got {}",
                self.routes.len()
            ));
        }
        unique_names(self.routes.iter().map(|r| r.id.as_str()), "route IDs")?;
        let targets = unique_names(
            self.write_targets.iter().map(|t| t.id.as_str()),
            "write target IDs",
        )?;
        unique_names(self.keys.iter().map(|k| k.name.as_str()), "key names")?;
        unique_names(self.tokens.iter().map(|t| t.name.as_str()), "token names")?;
        unique_names(
            self.listeners.iter().map(|l| l.name.as_str()),
            "listener names",
        )?;
        unique_names(
            self.sidecars.iter().map(|s| s.name.as_str()),
            "sidecar names",
        )?;

        let mut patterns: Vec<(&str, &Vec<String>, Vec<Segment>)> = Vec::new();
        for route in &self.routes {
            let segments = pattern(&route.path)?;
            let mut methods = HashSet::new();
            if route.methods.is_empty()
                || route
                    .methods
                    .iter()
                    .any(|m| !METHODS.contains(&m.as_str()) || !methods.insert(m.as_str()))
            {
                return Err(format!(
                    "route methods must be unique and from {}",
                    METHODS.join(", ")
                ));
            }
            if route.principal == Principal::Caller && route.auth != Auth::Atomic {
                return Err("principal caller requires auth atomic".into());
            }
            if self.mount == Mount::DrivePrefix
                && route.principal != Principal::Anonymous
                && route.auth != Auth::Atomic
            {
                return Err(
                    "routes on the drive-prefix mount must use principal anonymous unless auth is atomic"
                        .into(),
                );
            }
            if route.auth == Auth::Bearer && self.tokens.is_empty() {
                return Err("auth bearer requires http.tokens".into());
            }
            if route.accept.iter().any(|a| !a.contains('/')) {
                return Err("route accept entries must be media types".into());
            }
            if let Some(max) = route.max_body_bytes {
                let cap = if route.body == Some(Body::Blob) {
                    u64::MAX
                } else {
                    MAX_INLINE_BODY_BYTES
                };
                if max == 0 || max > cap {
                    return Err(format!(
                        "maxBodyBytes must be between 1 and {MAX_INLINE_BODY_BYTES}"
                    ));
                }
            }
            if route
                .timeout_ms
                .is_some_and(|t| t == 0 || t > MAX_TIMEOUT_MS)
            {
                return Err(format!("timeoutMs must be between 1 and {MAX_TIMEOUT_MS}"));
            }
            if route.writes.iter().any(|w| !targets.contains(w.as_str())) {
                return Err("writes must name declared writeTargets".into());
            }
            if route.enqueues.iter().any(|id| {
                !context
                    .operations
                    .iter()
                    .any(|(op, effect, _)| op == id && *effect == "write")
            }) {
                return Err("enqueues must name declared write operations".into());
            }
            // Keyed like the host's registry: (method, pattern).
            for (other, other_methods, other_segments) in &patterns {
                let shared = route.methods.iter().any(|m| other_methods.contains(m));
                if shared && overlaps(other_segments, &segments) {
                    return Err(format!("routes `{other}` and `{}` overlap", route.id));
                }
            }
            patterns.push((route.id.as_str(), &route.methods, segments));
        }

        let mut claimed = HashSet::new();
        for claim in &self.well_known {
            let allowed = match claim.kind {
                WellKnownKind::Shared => SHARED_WELL_KNOWN.contains(&claim.name.as_str()),
                WellKnownKind::Exclusive => EXCLUSIVE_WELL_KNOWN.contains(&claim.name.as_str()),
            };
            if !allowed || !claimed.insert(claim.name.as_str()) {
                return Err(format!(
                    "well-known name `{}` is not claimable as {} (or claimed twice)",
                    claim.name,
                    match claim.kind {
                        WellKnownKind::Shared => "shared",
                        WellKnownKind::Exclusive => "exclusive",
                    }
                ));
            }
            let has_match = claim
                .matches
                .as_ref()
                .is_some_and(|m| !m.resource_prefix.is_empty());
            if has_match != (claim.kind == WellKnownKind::Shared) {
                return Err(
                    "shared well-known claims need match.resourcePrefix; exclusive ones take none"
                        .into(),
                );
            }
            if !self.routes.iter().any(|r| r.id == claim.route) {
                return Err("well-known claims must name a declared route".into());
            }
        }

        for target in &self.write_targets {
            let parent_ok = match target.parent.strip_prefix("config:") {
                Some(key) => {
                    !key.is_empty()
                        && key.len() <= 128
                        && key
                            .bytes()
                            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
                }
                None => url::Url::parse(&target.parent)
                    .is_ok_and(|u| matches!(u.scheme(), "https" | "http" | "did")),
            };
            let mut classes = HashSet::new();
            let classes_ok = !target.classes.is_empty()
                && target.classes.iter().all(|c| {
                    url::Url::parse(c).is_ok_and(|u| {
                        matches!(u.scheme(), "https" | "http") && u.host_str().is_some()
                    }) && classes.insert(c.as_str())
                });
            if !parent_ok || !classes_ok {
                return Err(format!(
                    "write target `{}` needs a parent (`config:<key>` or a URL) and unique class URLs",
                    target.id
                ));
            }
        }

        if !self.listeners.is_empty() && !context.server_extension {
            return Err("http.listeners requires world server-extension".into());
        }

        for (id, _, url) in &context.operations {
            if is_wildcard_host(url)
                && !self
                    .routes
                    .iter()
                    .any(|r| r.enqueues.iter().any(|e| e == id))
            {
                return Err("wildcard-host operations must be listed in a route's enqueues".into());
            }
        }
        Ok(())
    }

    /// The gate this block needs (design 0.1).
    pub fn gate(&self) -> Gate {
        use PluginRoutesLevel::{ReadOnly, ReadWrite};
        let mut surfaces = Vec::new();
        let mut add = |surface: String, needs| surfaces.push(Surface { surface, needs });
        for route in &self.routes {
            let needs = if route.is_read_only() {
                ReadOnly
            } else {
                ReadWrite
            };
            add(
                format!("route `{} {}`", route.methods.join(","), route.path),
                needs,
            );
        }
        for claim in &self.well_known {
            add(format!("well-known `{}`", claim.name), ReadOnly);
        }
        for target in &self.write_targets {
            add(format!("write target `{}`", target.id), ReadWrite);
        }
        for key in &self.keys {
            add(format!("key `{}`", key.name), ReadWrite);
        }
        for token in &self.tokens {
            add(format!("token store `{}`", token.name), ReadWrite);
        }
        let mut deliveries = Vec::new();
        for id in self.routes.iter().flat_map(|r| &r.enqueues) {
            if !deliveries.contains(&id) {
                deliveries.push(id);
            }
        }
        for id in deliveries {
            add(format!("delivery `{id}`"), ReadWrite);
        }
        for listener in &self.listeners {
            add(format!("listener `{}`", listener.name), ReadWrite);
        }
        for sidecar in &self.sidecars {
            add(format!("sidecar `{}`", sidecar.name), ReadWrite);
        }
        Gate {
            needed: surfaces
                .iter()
                .map(|s| s.needs)
                .max()
                .unwrap_or(PluginRoutesLevel::Off),
            listeners: self.listeners.iter().map(|l| l.name.clone()).collect(),
            sidecars: self.sidecars.iter().map(|s| s.name.clone()).collect(),
            surfaces,
        }
    }

    /// Whether the block opens anything reachable from outside, as opposed to
    /// only asking for listeners or sidecars.
    fn has_public_surface(&self) -> bool {
        !(self.routes.is_empty()
            && self.well_known.is_empty()
            && self.write_targets.is_empty()
            && self.keys.is_empty()
            && self.tokens.is_empty())
    }
}

// -- the route grant (design 2.6, D4) -----------------------------------------

/// The key of the route grant in an Installation's `grants`. Its value is the
/// list of write targets the installer approved, exactly as the release
/// declares them: `{"route-writes": [{"id", "parent", "classes"}]}`. In the
/// array form of `grants` it is one object element among the capability
/// names; in the object form it is a key.
///
/// The grant names the targets instead of saying "yes", so an upgrade that
/// widens `writeTargets` cannot ride on an earlier approval: activation
/// refuses a release with a target the grant does not list, and the old
/// release keeps serving until someone reviews the new one.
pub const ROUTE_WRITES_GRANT: &str = "route-writes";

/// Whether this `grants` array element is the route grant rather than a
/// capability name.
pub fn is_route_grant_element(item: &serde_json::Value) -> bool {
    item.as_object()
        .is_some_and(|o| o.len() == 1 && o.contains_key(ROUTE_WRITES_GRANT))
}

/// The route grant in an Installation's `grants`, if it has one.
pub fn route_grant(grants: &serde_json::Value) -> Result<Option<Vec<WriteTarget>>, String> {
    let raw = match grants {
        serde_json::Value::Array(items) => items
            .iter()
            .find(|item| is_route_grant_element(item))
            .map(|item| &item[ROUTE_WRITES_GRANT]),
        serde_json::Value::Object(map) => map.get(ROUTE_WRITES_GRANT),
        _ => None,
    };
    raw.map(|targets| {
        serde_json::from_value(targets.clone()).map_err(|e| {
            format!("the `{ROUTE_WRITES_GRANT}` grant is not a list of write targets: {e}")
        })
    })
    .transpose()
}

/// Refuses a release whose write targets a route grant does not cover.
///
/// Without a route grant the release still installs: its read routes serve,
/// and every route write is refused until the grant is given. With one, each
/// declared write target must be listed in it unchanged. A narrower release
/// passes; a wider one (a new target, or a known id with another parent or
/// more classes) needs a new review.
pub fn check_route_grant(http: Option<&Http>, grants: &serde_json::Value) -> Result<(), String> {
    let Some(approved) = route_grant(grants)? else {
        return Ok(());
    };
    let widened: Vec<&str> = http
        .map(|h| h.write_targets.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|target| !approved.contains(target))
        .map(|target| target.id.as_str())
        .collect();
    if widened.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "the release writes to targets its route grant does not cover ({}); review the new write targets to approve them",
            widened.join(", ")
        ))
    }
}

/// One thing that asks for a gate, as the refusal and the install review
/// name it: "route `POST /users/{name}/inbox`".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Surface {
    pub surface: String,
    pub needs: PluginRoutesLevel,
}

/// What a release needs from the node's plugin-routes gates.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Gate {
    /// `Off` means it needs no gate at all.
    pub needed: PluginRoutesLevel,
    pub listeners: Vec<String>,
    pub sidecars: Vec<String>,
    pub surfaces: Vec<Surface>,
}

/// `none` rather than `off`: a release needs no gate, a node has it off.
pub fn needed_name(level: PluginRoutesLevel) -> &'static str {
    match level {
        PluginRoutesLevel::Off => "none",
        other => other.as_str(),
    }
}

impl Gate {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "needed": needed_name(self.needed),
            "listeners": self.listeners,
            "sidecars": self.sidecars,
            "surfaces": self.surfaces.iter().map(|s| serde_json::json!({
                "surface": s.surface,
                "needs": s.needs.as_str(),
            })).collect::<Vec<_>>(),
        })
    }

    /// Compares the release's needs with the node's gates (design 0.4).
    pub fn check(&self, node: &PluginRoutesConfig) -> Result<(), HostFeatureUnavailable> {
        if self.needed == PluginRoutesLevel::Off {
            return Ok(());
        }
        let missing = |declared: &[String], present: Vec<&str>| -> Vec<String> {
            declared
                .iter()
                .filter(|n| !present.contains(&n.as_str()))
                .cloned()
                .collect()
        };
        let listeners = missing(
            &self.listeners,
            node.listeners().iter().map(|l| l.name.as_str()).collect(),
        );
        let sidecars = missing(
            &self.sidecars,
            node.sidecars().iter().map(|s| s.name.as_str()).collect(),
        );
        let level = node.level();
        let surfaces: Vec<String> = if !node.allows(self.needed) {
            self.surfaces
                .iter()
                .filter(|s| s.needs > level)
                .map(|s| s.surface.clone())
                .collect()
        } else if !listeners.is_empty() || !sidecars.is_empty() {
            listeners
                .iter()
                .map(|n| format!("listener `{n}`"))
                .chain(sidecars.iter().map(|n| format!("sidecar `{n}`")))
                .collect()
        } else {
            return Ok(());
        };
        Err(HostFeatureUnavailable {
            needed: self.needed,
            compiled: node.compiled(),
            level,
            surfaces,
            listeners,
            sidecars,
        })
    }
}

/// The typed problem `host-feature-unavailable`: a release needs a gate this
/// node does not open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostFeatureUnavailable {
    pub needed: PluginRoutesLevel,
    pub compiled: bool,
    pub level: PluginRoutesLevel,
    /// What asked for more than the node allows.
    pub surfaces: Vec<String>,
    /// Declared listeners and sidecars the operator has not configured.
    pub listeners: Vec<String>,
    pub sidecars: Vec<String>,
}

pub const HOST_FEATURE_UNAVAILABLE: &str = "host-feature-unavailable";

impl HostFeatureUnavailable {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "type": HOST_FEATURE_UNAVAILABLE,
            "feature": "plugin-routes",
            "needed": self.needed.as_str(),
            "compiled": self.compiled,
            "level": self.level.as_str(),
            "surfaces": self.surfaces,
            "listeners": self.listeners,
            "sidecars": self.sidecars,
        })
    }

    /// The message from design 0.4.
    pub fn message(&self) -> String {
        let opens = format!(
            "This plugin opens public endpoints on the server ({}).",
            self.surfaces.join(", ")
        );
        if !self.compiled {
            return format!(
                "{opens} This AtomicServer was built without plugin routes, so the plugin can't be installed here."
            );
        }
        if self.level < self.needed {
            let needed = self.needed.as_str();
            return format!(
                "{opens} The server operator hasn't enabled them. To allow it, start AtomicServer with `--plugin-routes {needed}` (or `ATOMIC_PLUGIN_ROUTES={needed}`)."
            );
        }
        let list = |entries: Vec<String>| entries.join(", ");
        let mut additions = Vec::new();
        if !self.listeners.is_empty() {
            additions.push(format!(
                "{} to `ATOMIC_PLUGIN_LISTENERS`",
                list(
                    self.listeners
                        .iter()
                        .map(|n| format!("`{n}:<port>`"))
                        .collect()
                )
            ));
        }
        if !self.sidecars.is_empty() {
            additions.push(format!(
                "{} to `ATOMIC_PLUGIN_SIDECARS`",
                list(
                    self.sidecars
                        .iter()
                        .map(|n| format!("`{n}=http://127.0.0.1:<port>`"))
                        .collect()
                )
            ));
        }
        format!(
            "{opens} The server operator hasn't configured them. To allow it, add {}.",
            additions.join(" and ")
        )
    }
}

impl std::fmt::Display for HostFeatureUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// The `requires` list derived from the declarations (design section 1, "How
/// this answers #1535"), sorted. Authors never write it, so it cannot
/// disagree with what the manifest declares.
pub fn derive_requires(
    http: Option<&Http>,
    gate: &Gate,
    has_secrets: bool,
    runs_in_sandbox: bool,
) -> Vec<String> {
    let mut requires = BTreeSet::new();
    if has_secrets {
        requires.insert("host-credentials".to_string());
    }
    let public = http.is_some_and(Http::has_public_surface);
    if runs_in_sandbox || public {
        requires.insert("wasm-sandbox".to_string());
    }
    if public {
        requires.insert("persistent-host".to_string());
        requires.insert("public-origin".to_string());
    }
    if gate.needed != PluginRoutesLevel::Off {
        requires.insert(format!("plugin-routes:{}", gate.needed.as_str()));
    }
    for name in &gate.listeners {
        requires.insert(format!("operator-listener:{name}"));
    }
    for name in &gate.sidecars {
        requires.insert(format!("operator-sidecar:{name}"));
    }
    requires.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segments(path: &str) -> Vec<Segment> {
        pattern(path).unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn patterns_accept_literals_params_and_a_trailing_rest() {
        for ok in [
            "/",
            "/users/{name}",
            "/users/{name}/inbox",
            "/files/{*rest}",
            "/.well-known/webfinger",
            "/@alice",
        ] {
            assert!(pattern(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "users",
            "/users/",
            "//x",
            "/users/(.*)",
            "/users/[a-z]+",
            "/a/{*rest}/b",
            "/{a}/{a}",
            "/{1a}",
            "/a/..",
            "/a/./b",
            "/a b",
            "/a%2Fb",
            "/{}",
            "/{*}",
            // A parameter is a whole segment.
            "/@{handle}",
        ] {
            assert!(pattern(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn overlap_is_symmetric_and_respects_rest() {
        let cases = [
            ("/users/{a}", "/users/me", true),
            ("/users/{a}", "/users/{b}/inbox", false),
            ("/files/{*rest}", "/files/a/b", true),
            ("/files/{*rest}", "/files", false),
            ("/files/{*rest}", "/other/a", false),
            ("/", "/", true),
            ("/", "/{a}", false),
            ("/{*rest}", "/", false),
            ("/{*rest}", "/{a}/x", true),
            ("/a/b", "/a/c", false),
        ];
        for (a, b, expected) in cases {
            assert_eq!(overlaps(&segments(a), &segments(b)), expected, "{a} {b}");
            assert_eq!(overlaps(&segments(b), &segments(a)), expected, "{b} {a}");
        }
    }

    #[test]
    fn routes_on_disjoint_methods_may_share_a_pattern() {
        let http: Http = serde_json::from_value(serde_json::json!({
            "routes": [
                {"id": "read", "path": "/items/{id}", "methods": ["GET"]},
                {"id": "write", "path": "/items/{id}", "methods": ["PUT"], "principal": "installation", "auth": "atomic"}
            ]
        }))
        .unwrap();
        let context = Context {
            server_extension: false,
            operations: Vec::new(),
        };
        http.validate(&context).unwrap();
        assert_eq!(http.gate().needed, PluginRoutesLevel::ReadWrite);
    }

    #[test]
    fn wildcard_hosts_are_recognised() {
        assert!(is_wildcard_host("https://*/inbox"));
        assert!(!is_wildcard_host("https://example.com/inbox"));
    }
}
