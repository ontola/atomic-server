//! Route writes (AS-07, design `server-plugin-routes.md` in atomic-plugins,
//! section 2.6 and decision D4): applying a route verdict's intents without a
//! person reviewing each request.
//!
//! What makes that acceptable is decided up front, at install:
//!
//! - **The route grant.** The Installation's `grants` carries
//!   `{"route-writes": [write targets]}` ([`ROUTE_WRITES_GRANT`]), the targets
//!   the installer approved. Without it, every route write is refused
//!   (`403 route-write-not-granted`). Activation refuses a release whose
//!   targets the grant does not list, so a widened upgrade needs a new review
//!   and the old release keeps serving.
//! - **Only into the targets.** A create must go directly under a target's
//!   parent, with classes from that target. Sets, removes and destroys only
//!   touch resources this installation created (the signer of their genesis,
//!   proven by its certificate or commit) that still sit under a target with
//!   its classes. Nobody's rights, parents, classes or provenance can be
//!   changed through a route.
//! - **Quotas** ([`Quotas`]): resources created per remote caller per hour,
//!   per installation per day, and bytes written per installation per day.
//!   Past any of them the route answers `429 route-quota-exceeded` and
//!   nothing is written.
//! - **Provenance.** Every created or changed resource is signed by the
//!   installation's agent and gets [`urls::ROUTE_PROVENANCE`]: the
//!   installation, route, request id and verified remote caller.
//!
//! Everything is applied through the same planner and applier scheduled runs
//! use ([`plan_verdict`], [`apply_plan`], [`StoreApplyHost`]), before the
//! response is sent: a `2xx` means the write is stored.

use std::{collections::HashMap, sync::Mutex};

use actix_web::http::StatusCode;
use atomic_lib::{
    agents::ForAgent, db::app_agent::AppAgentKey, urls, Db, Resource, Storelike, Subject,
};
use serde_json::{json, Value as Json};

use super::{
    apply::{apply_plan, ApplyHost, ApplyOptions, CreateRequest},
    manifest_http::{route_grant, Http, Route, WriteTarget, ROUTE_WRITES_GRANT},
    plan::{plan_verdict, Op, RunPlan, Severity},
    store_host::StoreApplyHost,
};

// -- quotas -------------------------------------------------------------------

/// Creates per remote caller per hour (design 2.6, *proposed*).
pub const CREATES_PER_CALLER_HOUR: u64 = 100;
/// Creates per installation per day (design 2.6, *proposed*).
pub const CREATES_PER_DAY: u64 = 10_000;
/// Bytes of property values per installation per day. The design names no
/// number; 64 MiB is this implementation's choice.
pub const BYTES_PER_DAY: u64 = 64 * 1024 * 1024;

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// Windows kept before stale ones are dropped.
const PRUNE_AT: usize = 10_000;

/// The route write quotas of one node. `0` turns a quota off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quotas {
    pub creates_per_caller_hour: u64,
    pub creates_per_day: u64,
    pub bytes_per_day: u64,
}

impl Default for Quotas {
    fn default() -> Self {
        Self {
            creates_per_caller_hour: CREATES_PER_CALLER_HOUR,
            creates_per_day: CREATES_PER_DAY,
            bytes_per_day: BYTES_PER_DAY,
        }
    }
}

impl Quotas {
    pub fn from_opts(opts: &crate::config::Opts) -> Self {
        Self {
            creates_per_caller_hour: opts.plugin_route_creates_per_caller_hour,
            creates_per_day: opts.plugin_route_creates_per_day,
            bytes_per_day: opts.plugin_route_bytes_per_day,
        }
    }
}

/// A fixed window's usage.
#[derive(Clone, Copy, Default)]
struct Window {
    index: i64,
    creates: u64,
    bytes: u64,
}

impl Window {
    fn at(&mut self, index: i64) -> &mut Self {
        if self.index != index {
            *self = Window {
                index,
                ..Default::default()
            };
        }
        self
    }
}

#[derive(Default)]
struct Usage {
    /// Per installation, per day.
    installations: HashMap<String, Window>,
    /// Per (installation, remote caller), per hour.
    callers: HashMap<(String, String), Window>,
}

/// Which quota a write would exceed.
#[derive(Debug, PartialEq, Eq)]
pub struct Exceeded {
    pub quota: &'static str,
    pub limit: u64,
    pub retry_after_secs: u64,
}

/// What each installation and caller used in the current windows. In memory:
/// it resets on restart, like the route status counts.
pub struct QuotaLedger {
    quotas: Quotas,
    usage: Mutex<Usage>,
}

impl Default for QuotaLedger {
    fn default() -> Self {
        Self::new(Quotas::default())
    }
}

impl QuotaLedger {
    pub fn new(quotas: Quotas) -> Self {
        Self {
            quotas,
            usage: Mutex::new(Usage::default()),
        }
    }

    pub fn quotas(&self) -> Quotas {
        self.quotas
    }

    /// Books `creates` and `bytes` for this write, or refuses it whole if any
    /// quota would be exceeded. Checking and booking under one lock, so two
    /// concurrent requests cannot both squeeze under the same limit.
    pub fn reserve(
        &self,
        installation: &str,
        caller: &str,
        creates: u64,
        bytes: u64,
        now: i64,
    ) -> Result<(), Exceeded> {
        let q = self.quotas;
        let (hour, day) = (now.div_euclid(HOUR_MS), now.div_euclid(DAY_MS));
        // Seconds until the window ends, rounded up.
        let retry =
            |window: i64, index: i64| (((index + 1) * window - now).max(1000) + 999) as u64 / 1000;
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        if usage.installations.len() + usage.callers.len() > PRUNE_AT {
            usage.installations.retain(|_, w| w.index == day);
            usage.callers.retain(|_, w| w.index == hour);
        }
        let caller_used = usage
            .callers
            .get(&(installation.to_string(), caller.to_string()))
            .filter(|w| w.index == hour)
            .map_or(0, |w| w.creates);
        let own = usage
            .installations
            .get(installation)
            .filter(|w| w.index == day)
            .copied()
            .unwrap_or_default();
        let over =
            |limit: u64, used: u64, adding: u64| limit > 0 && adding > 0 && used + adding > limit;
        if over(q.creates_per_caller_hour, caller_used, creates) {
            return Err(Exceeded {
                quota: "creates-per-caller-hour",
                limit: q.creates_per_caller_hour,
                retry_after_secs: retry(HOUR_MS, hour),
            });
        }
        if over(q.creates_per_day, own.creates, creates) {
            return Err(Exceeded {
                quota: "creates-per-day",
                limit: q.creates_per_day,
                retry_after_secs: retry(DAY_MS, day),
            });
        }
        if over(q.bytes_per_day, own.bytes, bytes) {
            return Err(Exceeded {
                quota: "bytes-per-day",
                limit: q.bytes_per_day,
                retry_after_secs: retry(DAY_MS, day),
            });
        }
        let window = usage
            .installations
            .entry(installation.to_string())
            .or_default()
            .at(day);
        window.creates += creates;
        window.bytes += bytes;
        usage
            .callers
            .entry((installation.to_string(), caller.to_string()))
            .or_default()
            .at(hour)
            .creates += creates;
        Ok(())
    }

    /// Bytes this installation may still write today, and the seconds until
    /// that window ends. `None` when the byte quota is off. Nothing is
    /// booked: a blob body is checked against this while it streams in, and
    /// booked with [`Self::reserve`] once its size is known.
    pub fn bytes_left(&self, installation: &str, now: i64) -> Option<(u64, u64)> {
        let limit = self.quotas.bytes_per_day;
        if limit == 0 {
            return None;
        }
        let day = now.div_euclid(DAY_MS);
        let used = self
            .usage
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .installations
            .get(installation)
            .filter(|w| w.index == day)
            .map_or(0, |w| w.bytes);
        let retry = (((day + 1) * DAY_MS - now).max(1000) + 999) as u64 / 1000;
        Some((limit.saturating_sub(used), retry))
    }

    /// Gives back a reservation for a write of which nothing was stored.
    pub fn refund(&self, installation: &str, caller: &str, creates: u64, bytes: u64, now: i64) {
        let (hour, day) = (now.div_euclid(HOUR_MS), now.div_euclid(DAY_MS));
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(w) = usage
            .installations
            .get_mut(installation)
            .filter(|w| w.index == day)
        {
            w.creates = w.creates.saturating_sub(creates);
            w.bytes = w.bytes.saturating_sub(bytes);
        }
        if let Some(w) = usage
            .callers
            .get_mut(&(installation.to_string(), caller.to_string()))
            .filter(|w| w.index == hour)
        {
            w.creates = w.creates.saturating_sub(creates);
        }
    }
}

// -- refusals -----------------------------------------------------------------

/// Why a route write was refused. Nothing was written, except where
/// [`Refusal::kind`] is `route-write-failed`.
#[derive(Debug)]
pub struct Refusal {
    pub status: StatusCode,
    pub kind: &'static str,
    pub title: &'static str,
    /// For the remote caller.
    pub detail: String,
    /// For the route status only.
    pub error: String,
    pub retry_after_secs: Option<u64>,
}

impl Refusal {
    fn refused(error: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            kind: "route-write-refused",
            title: "This plugin route tried to write",
            detail: "The plugin's answer was refused and nothing was stored.".into(),
            error: format!("{}; nothing was applied", error.into()),
            retry_after_secs: None,
        }
    }
}

// -- what a route may write ----------------------------------------------------

/// Properties a route write may never set or remove: they would move a
/// resource out of its target, change its class, hand out rights, or forge
/// where it came from.
const PROTECTED: [&str; 8] = [
    urls::PARENT,
    urls::IS_A,
    urls::READ,
    urls::WRITE,
    urls::APPEND,
    urls::ROUTE_PROVENANCE,
    urls::GENESIS,
    urls::CREATED_BY,
];

/// A write target the route declares and the installer approved, with its
/// parent resolved.
#[derive(Clone, Debug)]
pub struct Allowed {
    pub id: String,
    pub parent: String,
    pub classes: Vec<String>,
}

fn normalize(store: &Db, subject: &str) -> String {
    store
        .normalize_subject(&Subject::from_raw(subject, None))
        .to_string()
}

/// The targets this route may write to: declared by the route, approved in
/// the route grant unchanged, with a parent the installation's config names.
pub fn allowed_targets(
    store: &Db,
    http: &Http,
    route: &Route,
    config: &Json,
    grants: &Json,
) -> Result<Vec<Allowed>, Refusal> {
    let not_granted = |error: String| Refusal {
        status: StatusCode::FORBIDDEN,
        kind: "route-write-not-granted",
        title: "This plugin may not store what it receives here",
        detail: "Whoever installed this plugin has not approved its writes. Nothing was stored."
            .into(),
        error,
        retry_after_secs: None,
    };
    let approved = route_grant(grants).map_err(not_granted)?.ok_or_else(|| {
        not_granted(format!(
            "the Installation has no `{ROUTE_WRITES_GRANT}` grant; nothing was applied"
        ))
    })?;
    let mut allowed = Vec::new();
    for id in &route.writes {
        let Some(target) = http.write_targets.iter().find(|t| &t.id == id) else {
            continue;
        };
        if !approved.contains(target) {
            continue;
        }
        let parent = match target.parent.strip_prefix("config:") {
            Some(key) => match config.get(key).and_then(Json::as_str) {
                Some(parent) if !parent.is_empty() => parent.to_string(),
                _ => continue,
            },
            None => target.parent.clone(),
        };
        allowed.push(Allowed {
            id: target.id.clone(),
            parent: normalize(store, &parent),
            classes: target.classes.clone(),
        });
    }
    if allowed.is_empty() {
        return Err(not_granted(format!(
            "none of the route's write targets ({}) is approved in the route grant and configured; nothing was applied",
            route.writes.join(", ")
        )));
    }
    Ok(allowed)
}

fn classes_of(resource: &Resource) -> Vec<String> {
    resource
        .get(urls::IS_A)
        .ok()
        .and_then(|v| v.to_subjects(None).ok())
        .unwrap_or_default()
}

/// The agent whose key signed the resource's genesis certificate, if any.
///
/// Two ways to prove it, both bound to the subject so neither can be forged by
/// writing a property: the inline genesis certificate, verified against the
/// subject (`Resource::genesis_signer`); or, for a resource whose DID is its
/// genesis commit's signature (what the server's own genesis saves mint), the
/// signer of that commit. `createdBy` is never trusted: anyone can set it.
async fn creator(store: &Db, resource: &Resource) -> Option<String> {
    if let Some(signer) = resource.genesis_signer() {
        return Some(signer);
    }
    let subject = resource.get_subject().to_string();
    let signature =
        atomic_lib::identifiers::identifier_body(&subject).filter(|body| !body.contains(':'))?;
    let commit = store
        .get_resource(
            &atomic_lib::identifiers::commit_subject(signature)
                .as_str()
                .into(),
        )
        .await
        .ok()?;
    let target = commit.get(urls::SUBJECT).ok()?.to_string();
    if normalize(store, &target) != normalize(store, &subject) {
        return None;
    }
    Some(commit.get(urls::SIGNER).ok()?.to_string())
}

fn same_agent(a: &str, b: &str) -> bool {
    use atomic_lib::identifiers::agent_public_key;
    match (agent_public_key(a), agent_public_key(b)) {
        (Some(ka), Some(kb)) => atomic_lib::authentication::public_keys_match(ka, kb),
        _ => a == b,
    }
}

/// Checks every change of a plan against the targets, before anything is
/// written.
pub async fn check_plan(
    store: &Db,
    plan: &RunPlan,
    allowed: &[Allowed],
    agent: &str,
) -> Result<(), Refusal> {
    let fits = |parent: &str, classes: &[String]| {
        !classes.is_empty()
            && allowed
                .iter()
                .any(|t| t.parent == parent && classes.iter().all(|c| t.classes.contains(c)))
    };
    for change in &plan.changes {
        if let Some(p) = change
            .properties
            .iter()
            .find(|p| PROTECTED.contains(&p.property.as_str()))
        {
            return Err(Refusal::refused(format!(
                "a route may not write {}",
                p.property
            )));
        }
        match change.op {
            Op::Create => {
                let parent = normalize(store, change.parent.as_deref().unwrap_or_default());
                if !fits(&parent, &change.is_a) {
                    return Err(Refusal::refused(format!(
                        "a create under {parent} with classes [{}] is outside this route's write targets ({})",
                        change.is_a.join(", "),
                        allowed
                            .iter()
                            .map(|t| t.id.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
            }
            Op::Set | Op::Remove | Op::Destroy => {
                let resource = store
                    .get_resource(&change.subject.as_str().into())
                    .await
                    .map_err(|e| {
                        Refusal::refused(format!("{} cannot be read: {e}", change.subject))
                    })?;
                if !creator(store, &resource)
                    .await
                    .is_some_and(|c| same_agent(&c, agent))
                {
                    return Err(Refusal::refused(format!(
                        "{} was not created by this installation, so a route may not change it",
                        change.subject
                    )));
                }
                let parent = resource
                    .get(urls::PARENT)
                    .map(|p| normalize(store, &p.to_string()))
                    .unwrap_or_default();
                if !fits(&parent, &classes_of(&resource)) {
                    return Err(Refusal::refused(format!(
                        "{} is no longer inside this route's write targets",
                        change.subject
                    )));
                }
            }
        }
    }
    Ok(())
}

/// Resources a plan creates, and the bytes of the values it writes.
pub fn cost(plan: &RunPlan) -> (u64, u64) {
    let creates = plan.changes.iter().filter(|c| c.op == Op::Create).count() as u64;
    let bytes = plan
        .changes
        .iter()
        .map(|c| {
            c.is_a.iter().map(String::len).sum::<usize>()
                + c.properties
                    .iter()
                    .map(|p| p.property.len() + p.to.as_ref().map_or(0, |v| v.to_string().len()))
                    .sum::<usize>()
        })
        .sum::<usize>() as u64;
    (creates, bytes)
}

// -- applying ------------------------------------------------------------------

/// [`StoreApplyHost`], stamping provenance on everything it creates or
/// changes.
struct ProvenanceHost {
    inner: StoreApplyHost,
    provenance: Json,
}

impl ProvenanceHost {
    fn stamp(&self, mut prop_vals: HashMap<String, Json>) -> HashMap<String, Json> {
        prop_vals.insert(urls::ROUTE_PROVENANCE.into(), self.provenance.clone());
        prop_vals
    }
}

#[async_trait::async_trait]
impl ApplyHost for ProvenanceHost {
    async fn create(&mut self, mut request: CreateRequest) -> Result<String, String> {
        request.prop_vals = self.stamp(request.prop_vals);
        self.inner.create(request).await
    }

    async fn set(&mut self, subject: &str, prop_vals: HashMap<String, Json>) -> Result<(), String> {
        let stamped = self.stamp(prop_vals);
        self.inner.set(subject, stamped).await
    }

    async fn remove(&mut self, subject: &str, properties: Vec<String>) -> Result<(), String> {
        self.inner.remove(subject, properties).await?;
        let stamped = self.stamp(HashMap::new());
        self.inner.set(subject, stamped).await
    }

    async fn destroy(&mut self, subject: &str) -> Result<(), String> {
        // Gone: the destroy commit's signer is its provenance.
        self.inner.destroy(subject).await
    }
}

/// One route request's writes.
pub struct WriteRequest<'a> {
    pub store: &'a Db,
    pub ledger: &'a QuotaLedger,
    pub installation: &'a str,
    pub drive: &'a str,
    pub http: &'a Http,
    pub route: &'a Route,
    pub config: &'a Json,
    pub grants: &'a Json,
    /// The trigger id (`http:<ulid>`) the handler saw.
    pub request_id: &'a str,
    /// The verified remote caller, `null` for `auth: none`.
    pub caller: &'a Json,
    /// The socket peer, which stands in for the caller in the quota when
    /// nothing was verified. Never stored.
    pub remote: &'a str,
    pub at: i64,
}

/// What was stored, for the run log.
#[derive(Debug)]
pub struct Applied {
    pub created: Vec<String>,
    pub summary: String,
}

/// Plans the verdict's intents, checks them against the route grant, the
/// targets and the quotas, and applies them signed by the installation's
/// agent. Refuses the whole write before anything is stored whenever it can.
pub async fn apply(request: WriteRequest<'_>, intents: &Json) -> Result<Applied, Refusal> {
    let store = request.store;
    let allowed = allowed_targets(
        store,
        request.http,
        request.route,
        request.config,
        request.grants,
    )?;
    let unavailable = |error: String| Refusal {
        status: StatusCode::SERVICE_UNAVAILABLE,
        kind: "route-unavailable",
        title: "This plugin route cannot run",
        detail: "The plugin's identity on this server is missing.".into(),
        error,
        retry_after_secs: None,
    };
    let agent = store
        .get_app_agent_info(&AppAgentKey::new(request.drive, request.installation))
        .ok()
        .flatten()
        .map(|info| info.agent)
        .ok_or_else(|| unavailable("the installation has no agent to write as".into()))?;
    let inner = StoreApplyHost::for_installation(
        store,
        request.drive,
        request.installation,
        ForAgent::AgentSubject(agent.as_str().into()),
    )
    .await
    .map_err(unavailable)?;
    let mut host = ProvenanceHost {
        inner,
        provenance: json!({
            "installation": request.installation,
            "route": request.route.id,
            "request": request.request_id,
            "caller": request.caller,
            "receivedAt": request.at,
        }),
    };

    // Only the intents: a route's `problems` are for its log, not a veto.
    let plan = plan_verdict(&json!({ "intents": intents }), &mut host.inner).await;
    if plan.blocked {
        let problems: Vec<String> = plan
            .problems
            .iter()
            .chain(plan.changes.iter().flat_map(|c| c.problems.iter()))
            .filter(|p| p.severity == Severity::Error)
            .map(|p| p.message.clone())
            .collect();
        return Err(Refusal {
            status: StatusCode::BAD_GATEWAY,
            kind: "route-write-invalid",
            title: "This plugin route produced an invalid write",
            detail: "The plugin's answer was refused and nothing was stored.".into(),
            error: format!(
                "the intents do not plan: {}; nothing was applied",
                problems.join("; ")
            ),
            retry_after_secs: None,
        });
    }
    check_plan(store, &plan, &allowed, &agent).await?;
    // A blob a write references becomes servable from the target (#1720),
    // so a route may only reference one its installation stored or its
    // targets already hold: a hash alone is not the bytes.
    let mut blobs = Vec::new();
    for change in &plan.changes {
        for property in &change.properties {
            if let Some(to) = &property.to {
                super::route_blobs::referenced(to, &mut blobs);
            }
        }
    }
    let parents: Vec<String> = allowed.iter().map(|t| t.parent.clone()).collect();
    for hash in blobs {
        if !super::route_blobs::may_use(store, request.installation, &hash, &parents).await {
            return Err(Refusal::refused(format!(
                "a route may only reference blobs its installation stored or its write targets hold, not {hash}"
            )));
        }
    }

    let (creates, bytes) = cost(&plan);
    let caller = match request.caller {
        Json::Null => format!("address {}", request.remote),
        verified => verified.to_string(),
    };
    request
        .ledger
        .reserve(request.installation, &caller, creates, bytes, request.at)
        .map_err(|exceeded| Refusal {
            status: StatusCode::TOO_MANY_REQUESTS,
            kind: "route-quota-exceeded",
            title: "This plugin has stored as much as it may for now",
            detail: format!(
                "The `{}` quota ({}) is used up. Nothing was stored. Try again later.",
                exceeded.quota, exceeded.limit
            ),
            error: format!(
                "the {} quota of {} would be exceeded; nothing was applied",
                exceeded.quota, exceeded.limit
            ),
            retry_after_secs: Some(exceeded.retry_after_secs),
        })?;

    let report = match apply_plan(&plan, &mut host, ApplyOptions::default()).await {
        Ok(report) => report,
        Err(e) => {
            request
                .ledger
                .refund(request.installation, &caller, creates, bytes, request.at);
            return Err(failed(e));
        }
    };
    if report.failed > 0 || report.stopped_early {
        if report.applied == 0 {
            request
                .ledger
                .refund(request.installation, &caller, creates, bytes, request.at);
        }
        let errors: Vec<String> = report
            .outcomes
            .iter()
            .filter_map(|o| o.error.clone())
            .collect();
        return Err(failed(format!(
            "applied {} of {} change(s): {}",
            report.applied,
            report.outcomes.len(),
            errors.join("; ")
        )));
    }
    Ok(Applied {
        created: report
            .outcomes
            .iter()
            .filter(|o| o.op == "create")
            .map(|o| o.subject.clone())
            .collect(),
        summary: format!("applied {} change(s)", report.applied),
    })
}

fn failed(error: String) -> Refusal {
    Refusal {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        kind: "route-write-failed",
        title: "The server could not store this request",
        detail: "Storing what this plugin route received failed; part of it may have been stored."
            .into(),
        error,
        retry_after_secs: None,
    }
}

/// The write targets a manifest declares, for the grant a test or an install
/// review approves.
pub fn grant_for(targets: &[WriteTarget]) -> Json {
    json!({ ROUTE_WRITES_GRANT: targets })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotas_refuse_whole_writes_and_reset_per_window() {
        let ledger = QuotaLedger::new(Quotas {
            creates_per_caller_hour: 3,
            creates_per_day: 5,
            bytes_per_day: 100,
        });
        let t = 10 * DAY_MS;
        ledger.reserve("i", "a", 2, 10, t).unwrap();
        // Would pass 3 for this caller: refused whole, nothing booked.
        let e = ledger.reserve("i", "a", 2, 10, t).unwrap_err();
        assert_eq!(e.quota, "creates-per-caller-hour");
        assert!(e.retry_after_secs <= 3600 && e.retry_after_secs > 0);
        ledger.reserve("i", "a", 1, 10, t).unwrap();
        // Another caller, same installation: the daily count is 3 of 5.
        ledger.reserve("i", "b", 2, 10, t).unwrap();
        let e = ledger.reserve("i", "c", 1, 10, t).unwrap_err();
        assert_eq!(e.quota, "creates-per-day");
        // Changes (no creates) count only bytes.
        ledger.reserve("i", "c", 0, 70, t).unwrap();
        assert_eq!(
            ledger.reserve("i", "c", 0, 1, t).unwrap_err().quota,
            "bytes-per-day"
        );
        // Other installations are untouched; the next day starts over.
        ledger.reserve("j", "a", 3, 10, t).unwrap();
        ledger.reserve("i", "a", 3, 10, t + DAY_MS).unwrap();
        // A refund gives the booking back.
        ledger.refund("i", "a", 3, 10, t + DAY_MS);
        ledger.reserve("i", "a", 3, 10, t + DAY_MS).unwrap();
    }

    #[test]
    fn a_zero_quota_is_off() {
        let ledger = QuotaLedger::new(Quotas {
            creates_per_caller_hour: 0,
            creates_per_day: 0,
            bytes_per_day: 0,
        });
        ledger
            .reserve("i", "a", 1_000_000, u64::MAX / 2, 0)
            .unwrap();
    }

    #[test]
    fn the_defaults_are_the_designs() {
        let q = Quotas::default();
        assert_eq!(
            (
                q.creates_per_caller_hour,
                q.creates_per_day,
                q.bytes_per_day
            ),
            (100, 10_000, 64 * 1024 * 1024)
        );
    }
}

/// Route writes end to end: a real fixture server, the inbox fixture, real
/// execution through the router.
#[cfg(test)]
mod http_tests {
    use actix_web::{http::header, test as actix_test, web, App};
    use atomic_lib::{db::app_agent::AppAgentKey, urls, Storelike, Value};
    use serde_json::{json, Value as Json};

    use crate::plugins::{
        route_registry::slug,
        test_fixture::{
            children_named, fixture_with_args, genesis, inbox_release, install_release_with,
            Fixture,
        },
    };

    const PLAIN_TEXT: &str = "https://atomicdata.dev/classes/PlainText";

    macro_rules! app {
        ($appstate:expr) => {
            actix_test::init_service(
                App::new()
                    .app_data(web::Data::new($appstate.clone()))
                    .configure(crate::routes::config_routes),
            )
            .await
        };
    }

    /// The write targets the inbox fixture declares: what its install review
    /// approves.
    fn targets() -> Json {
        inbox_release().manifest["http"]["writeTargets"].clone()
    }

    struct Inbox {
        f: Fixture,
        inbox: String,
        installation: String,
        agent: String,
        prefix: String,
    }

    /// A drive with an inbox the installation's agent may write to, and the
    /// inbox fixture installed with `route_grant`.
    async fn setup(name: &str, extra: &[&str], route_grant: Option<Json>) -> Inbox {
        let mut args = vec!["--plugin-routes", "read-write"];
        args.extend_from_slice(extra);
        let f = fixture_with_args(name, &args).await;
        let store = &f.appstate.store;
        let inbox = genesis(
            store,
            vec![
                (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
                (urls::NAME, Value::String("Inbox".into())),
            ],
        )
        .await;
        let installation = install_release_with(
            &f,
            &inbox_release(),
            route_grant,
            Some(json!({ "inbox": inbox })),
        )
        .await
        .unwrap();
        let agent = store
            .get_app_agent_info(&AppAgentKey::new(&f.drive, &installation))
            .unwrap()
            .unwrap()
            .agent;
        let mut resource = store.get_resource(&inbox.as_str().into()).await.unwrap();
        resource
            .set_unsafe(
                urls::WRITE.into(),
                Value::ResourceArray(vec![agent.as_str().into()]),
            )
            .unwrap();
        resource.save(store).await.unwrap();
        let prefix = format!("/_routes/{}", slug(&installation));
        Inbox {
            f,
            inbox,
            installation,
            agent,
            prefix,
        }
    }

    fn build(method: &str, uri: &str, body: Json) -> actix_test::TestRequest {
        let request = match method {
            "POST" => actix_test::TestRequest::post(),
            "PUT" => actix_test::TestRequest::put(),
            _ => actix_test::TestRequest::delete(),
        };
        request
            .uri(uri)
            .insert_header((header::CONTENT_TYPE, "application/json"))
            .set_payload(body.to_string())
    }

    macro_rules! send {
        ($method:expr, $uri:expr, $body:expr $(,)?) => {
            build($method, $uri, $body).to_request()
        };
    }

    async fn problem<B: actix_web::body::MessageBody>(
        resp: actix_web::dev::ServiceResponse<B>,
    ) -> String {
        let body: Json = actix_test::read_body_json(resp).await;
        body["type"].as_str().unwrap_or_default().to_string()
    }

    async fn only_child(i: &Inbox, name: &str) -> atomic_lib::Resource {
        let store = &i.f.appstate.store;
        let child = store
            .get_resource(&i.inbox.as_str().into())
            .await
            .unwrap()
            .get_children(store)
            .await
            .unwrap()
            .into_iter()
            .find(|c| c.get(urls::NAME).is_ok_and(|v| v.to_string() == name))
            .unwrap_or_else(|| panic!("no child named {name}"));
        store.get_resource(child.get_subject()).await.unwrap()
    }

    fn provenance(resource: &atomic_lib::Resource) -> Json {
        match resource.get(urls::ROUTE_PROVENANCE).unwrap() {
            Value::Json(json) => json.clone(),
            other => serde_json::from_str(&other.to_string()).unwrap(),
        }
    }

    #[actix_rt::test]
    async fn a_write_to_a_declared_target_is_stored_with_provenance() {
        let i = setup("route_write_ok", &[], Some(targets())).await;
        let app = app!(i.f.appstate);
        let resp = actix_test::call_service(
            &app,
            send!(
                "POST",
                &format!("{}/inbox", i.prefix),
                json!({"name": "hello", "text": "first"}),
            ),
        )
        .await;
        assert_eq!(resp.status(), 202);
        let item = only_child(&i, "hello").await;
        assert_eq!(item.get(urls::DESCRIPTION).unwrap().to_string(), "first");
        assert_eq!(super::classes_of(&item), vec![PLAIN_TEXT.to_string()]);
        // Signed by the installation's agent: its genesis proves it.
        assert!(super::same_agent(
            &super::creator(&i.f.appstate.store, &item).await.unwrap(),
            &i.agent
        ));
        let created = provenance(&item);
        assert_eq!(created["installation"], i.installation);
        assert_eq!(created["route"], "inbox");
        assert!(created["request"].as_str().unwrap().starts_with("http:"));
        assert_eq!(created["caller"], Json::Null);

        // An update of its own item: stored, with the new request's provenance.
        let subject = item.get_subject().to_string();
        let resp = actix_test::call_service(
            &app,
            send!(
                "PUT",
                &format!("{}/item", i.prefix),
                json!({"subject": subject, "text": "second"}),
            ),
        )
        .await;
        assert_eq!(resp.status(), 200);
        let item = only_child(&i, "hello").await;
        assert_eq!(item.get(urls::DESCRIPTION).unwrap().to_string(), "second");
        let changed = provenance(&item);
        assert_eq!(changed["route"], "item");
        assert_ne!(changed["request"], created["request"]);

        // And a delete of it.
        let resp = actix_test::call_service(
            &app,
            send!(
                "DELETE",
                &format!("{}/item", i.prefix),
                json!({"subject": subject}),
            ),
        )
        .await;
        assert_eq!(resp.status(), 200);
        assert_eq!(children_named(&i.f, &i.inbox, "hello").await, 0);
    }

    #[actix_rt::test]
    async fn writes_outside_the_targets_are_refused() {
        let i = setup("route_write_outside", &[], Some(targets())).await;
        let app = app!(i.f.appstate);
        // Another parent.
        let resp = actix_test::call_service(
            &app,
            send!(
                "POST",
                &format!("{}/inbox", i.prefix),
                json!({"name": "stray", "parent": i.f.drive}),
            ),
        )
        .await;
        assert_eq!(resp.status(), 502);
        assert_eq!(problem(resp).await, "route-write-refused");
        assert_eq!(children_named(&i.f, &i.f.drive, "stray").await, 0);
        // The right parent, another class.
        let resp = actix_test::call_service(
            &app,
            send!(
                "POST",
                &format!("{}/inbox", i.prefix),
                json!({"name": "stray", "class": "https://atomicdata.dev/classes/Folder"}),
            ),
        )
        .await;
        assert_eq!(resp.status(), 502);
        assert_eq!(problem(resp).await, "route-write-refused");
        assert_eq!(children_named(&i.f, &i.inbox, "stray").await, 0);

        // A resource under the inbox that someone else created.
        let foreign = genesis(
            &i.f.appstate.store,
            vec![
                (urls::PARENT, Value::AtomicUrl(i.inbox.as_str().into())),
                (urls::IS_A, Value::ResourceArray(vec![PLAIN_TEXT.into()])),
                (urls::NAME, Value::String("theirs".into())),
                (urls::DESCRIPTION, Value::Markdown("untouched".into())),
            ],
        )
        .await;
        for (method, body) in [
            ("PUT", json!({"subject": foreign, "text": "overwritten"})),
            ("DELETE", json!({"subject": foreign})),
        ] {
            let resp =
                actix_test::call_service(&app, send!(method, &format!("{}/item", i.prefix), body))
                    .await;
            assert_eq!(resp.status(), 502, "{method}");
            assert_eq!(problem(resp).await, "route-write-refused");
        }
        let theirs = only_child(&i, "theirs").await;
        assert_eq!(
            theirs.get(urls::DESCRIPTION).unwrap().to_string(),
            "untouched"
        );
        let status = i.f.appstate.route_exec.status(
            &i.installation,
            &[("item".into(), String::new())],
            atomic_lib::utils::now(),
        );
        assert!(
            status["routes"][0]["lastError"]["message"]
                .as_str()
                .unwrap()
                .contains("not created by this installation"),
            "{status}"
        );
    }

    #[actix_rt::test]
    async fn past_the_quota_the_route_answers_429_and_writes_nothing() {
        let i = setup(
            "route_write_quota",
            &["--plugin-route-creates-per-caller-hour", "2"],
            Some(targets()),
        )
        .await;
        let app = app!(i.f.appstate);
        for n in 0..3 {
            let resp = actix_test::call_service(
                &app,
                send!(
                    "POST",
                    &format!("{}/inbox", i.prefix),
                    json!({"name": "spam", "text": format!("{n}")}),
                ),
            )
            .await;
            if n < 2 {
                assert_eq!(resp.status(), 202, "{n}");
            } else {
                assert_eq!(resp.status(), 429);
                assert!(resp.headers().contains_key(header::RETRY_AFTER));
                assert_eq!(problem(resp).await, "route-quota-exceeded");
            }
        }
        assert_eq!(children_named(&i.f, &i.inbox, "spam").await, 2);
    }

    #[actix_rt::test]
    async fn without_the_route_grant_nothing_is_written() {
        let i = setup("route_write_ungranted", &[], None).await;
        let app = app!(i.f.appstate);
        let resp = actix_test::call_service(
            &app,
            send!(
                "POST",
                &format!("{}/inbox", i.prefix),
                json!({"name": "ungranted"}),
            ),
        )
        .await;
        assert_eq!(resp.status(), 403);
        assert_eq!(problem(resp).await, "route-write-not-granted");
        assert_eq!(children_named(&i.f, &i.inbox, "ungranted").await, 0);
    }

    #[actix_rt::test]
    async fn a_grant_that_does_not_cover_the_targets_refuses_the_install() {
        let f = fixture_with_args("route_write_widened", &["--plugin-routes", "read-write"]).await;
        // The installer approved another parent: the release asks for more.
        let narrower = json!([{
            "id": "inbox-items",
            "parent": "config:elsewhere",
            "classes": [PLAIN_TEXT],
        }]);
        let err = install_release_with(&f, &inbox_release(), Some(narrower), None)
            .await
            .unwrap_err();
        assert!(
            err.contains("route grant does not cover (inbox-items)"),
            "{err}"
        );
    }

    #[actix_rt::test]
    async fn at_read_only_a_writing_release_does_not_install() {
        let f = fixture_with_args("route_write_read_only", &["--plugin-routes", "read-only"]).await;
        let err = install_release_with(&f, &inbox_release(), Some(targets()), None)
            .await
            .unwrap_err();
        assert!(err.contains("read-write"), "{err}");
    }
}
