//! Connection requests: flow b of ontola/atomic-plugins#54, piece 9 of #1700.
//!
//! An unattended run has nobody to send through OAuth. When a plugin's
//! `ctx.http("atomic-proxy:/<platform>/...")` finds no connection delegated to
//! its Installation for a platform its manifest declares:
//!
//! 1. **The run ends with a typed outcome,** [`NeedsConnection`], instead of a
//!    generic error. The runtime turns it into a verdict with a
//!    `needsConnection` key ([`needs_connection`]), whether or not the plugin
//!    caught the error `ctx.http` threw.
//! 2. **The node records a `ConnectionRequest`** ([`record`]): which platform,
//!    why, and since when, signed by this node's agent for the Installation.
//!    It is a child of that agent's own `InstallationRuntime` (#1710), the
//!    child of the Installation the agent may write (Q9's answer), so it syncs
//!    like any other resource and every node's rights check accepts it.
//! 3. **Runs that need it pause** ([`paused`]): the scheduler and the trigger
//!    listener skip this Installation's runs on this node, without advancing
//!    or dropping them, while the request is open.
//! 4. **The page clears it** by setting `connectionRequestClearedAt` in a
//!    commit signed by a writer of the Installation, after it connected the
//!    platform. The scheduler and the trigger listener read the request from
//!    the store on every pass, so the clearing reaches them through sync like
//!    any other commit. Once it is cleared and a connection is delegated, the
//!    paused runs go ahead.
//!
//! Rights, enforced by [`check_commit`] on every node on top of the usual
//! hierarchy: only the agent published on the parent `InstallationRuntime`
//! may create a request or change what it asks for, and only a writer of the
//! Installation may clear it.

use std::collections::HashSet;

use atomic_lib::{
    agents::ForAgent,
    class_extender::{ClassExtender, CommitExtenderContext},
    db::app_agent::AppAgentKey,
    errors::AtomicResult,
    storelike::Query,
    urls, AtomicError, Db, Resource, Storelike, Value,
};
use futures::future::BoxFuture;

use super::installation_identity;

/// No connection is delegated for the platform.
pub const NOT_CONNECTED: &str = "not-connected";
/// The owner took the delegation away at the proxy.
pub const REVOKED: &str = "revoked";
/// The provider's grant ran out.
pub const EXPIRED: &str = "expired";
const REASONS: [&str; 3] = [NOT_CONNECTED, REVOKED, EXPIRED];

/// How [`NeedsConnection`] travels through the `ctx.http` error string, which
/// is the only channel the host import has.
const ERROR_MARKER: &str = "needs-connection:";

/// The typed outcome of a run that needs a connection it does not have.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NeedsConnection {
    pub platform: String,
    pub reason: String,
}

impl NeedsConnection {
    pub fn not_connected(platform: &str) -> Self {
        Self {
            platform: platform.to_string(),
            reason: NOT_CONNECTED.to_string(),
        }
    }

    /// The error `ctx.http` returns to the plugin. Readable for the plugin
    /// author, and parseable by the runtime ([`Self::from_error`]).
    pub fn to_error(&self) -> String {
        format!(
            "{ERROR_MARKER}{}:{}: no {} connection is delegated to this installation; connect one and delegate it first. Runs that need it are paused until then.",
            self.platform, self.reason, self.platform
        )
    }

    pub fn from_error(error: &str) -> Option<Self> {
        let rest = error.strip_prefix(ERROR_MARKER)?;
        let mut parts = rest.splitn(3, ':');
        let platform = parts.next()?;
        let reason = parts.next()?;
        (!platform.is_empty() && REASONS.contains(&reason)).then(|| Self {
            platform: platform.to_string(),
            reason: reason.to_string(),
        })
    }

    /// The verdict a run that needed this ends with. Nothing to apply; the
    /// problem says what to do.
    pub fn verdict(&self) -> String {
        serde_json::json!({
            "needsConnection": self,
            "intents": [],
            "problems": [{
                "severity": "error",
                "message": format!(
                    "Needs a {} connection. Connect it on the Installation's page; runs that need it are paused until then.",
                    self.platform
                ),
            }],
        })
        .to_string()
    }
}

/// The typed outcome in a verdict, if the run ended with one.
pub fn needs_connection(verdict: &str) -> Option<NeedsConnection> {
    let value: serde_json::Value = serde_json::from_str(verdict).ok()?;
    serde_json::from_value(value.get("needsConnection")?.clone()).ok()
}

fn string_of(value: &Value) -> Option<String> {
    match value {
        Value::AtomicUrl(s) => Some(s.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn int_of(resource: &Resource, property: &str) -> Option<i64> {
    resource.get(property).ok()?.to_int().ok()
}

/// Whether `request` still asks: it was never cleared, or the node asked
/// again after it was.
pub fn is_open(request: &Resource) -> bool {
    let asked = int_of(request, urls::CONNECTION_REQUESTED_AT).unwrap_or(0);
    int_of(request, urls::CONNECTION_REQUEST_CLEARED_AT).is_none_or(|cleared| cleared < asked)
}

fn platform_of(request: &Resource) -> Option<String> {
    request
        .get(urls::CONNECTION_REQUEST_PLATFORM)
        .ok()
        .and_then(string_of)
}

/// The requests under one `InstallationRuntime`.
pub async fn requests_under(store: &Db, runtime: &str) -> AtomicResult<Vec<Resource>> {
    let found = store
        .query(&Query {
            property: Some(urls::PARENT.into()),
            value: Some(Value::AtomicUrl(runtime.into())),
            include_nested: true,
            for_agent: ForAgent::Sudo,
            ..Default::default()
        })
        .await?;
    Ok(found
        .resources
        .into_iter()
        .filter(|r| r.has_class(urls::CONNECTION_REQUEST))
        .collect())
}

/// Records that this node's runs of the Installation `key.app` need `need`,
/// signed by this node's agent for it. Opens a new request, reopens a cleared
/// one, or leaves an open one alone, so "since when" stays the first time.
/// Returns the request's subject.
pub async fn record(store: &Db, key: &AppAgentKey, need: &NeedsConnection) -> AtomicResult<String> {
    let runtime = installation_identity::publish_runtime(store, &key.drive, &key.app)
        .await?
        .ok_or("this node has no agent for the installation, so it cannot ask for a connection")?;
    let agent = store
        .with_app_agent(key, |agent| agent.clone())?
        .ok_or("this node's agent for the installation is missing or revoked")?;
    let now = atomic_lib::utils::now();

    let existing = requests_under(store, &runtime)
        .await?
        .into_iter()
        .find(|r| platform_of(r).as_deref() == Some(need.platform.as_str()));

    if let Some(mut request) = existing {
        if is_open(&request) {
            return Ok(request.get_subject().to_string());
        }
        request.set_unsafe(
            urls::CONNECTION_REQUEST_REASON.into(),
            Value::String(need.reason.clone()),
        )?;
        request.set_unsafe(urls::CONNECTION_REQUESTED_AT.into(), Value::Timestamp(now))?;
        request.save_as(&agent, store).await?;
        tracing::info!(
            "reopened the {} connection request {} of installation {}",
            need.platform,
            request.get_subject(),
            key.app
        );
        return Ok(request.get_subject().to_string());
    }

    let subject = installation_identity::create_signed_by(
        store,
        &agent,
        &key.drive,
        vec![
            (
                urls::IS_A,
                Value::ResourceArray(vec![urls::CONNECTION_REQUEST.into()]),
            ),
            (urls::PARENT, Value::AtomicUrl(runtime.as_str().into())),
            (
                urls::CONNECTION_REQUEST_PLATFORM,
                Value::String(need.platform.clone()),
            ),
            (
                urls::CONNECTION_REQUEST_REASON,
                Value::String(need.reason.clone()),
            ),
            (urls::CONNECTION_REQUESTED_AT, Value::Timestamp(now)),
        ],
    )
    .await?;
    tracing::info!(
        "installation {} needs a {} connection; asked for it on {subject}",
        key.app,
        need.platform
    );
    Ok(subject)
}

/// Why this node's runs of `plugin` are paused, if they are: a request of
/// this node's agent that is still open, or cleared while no connection is
/// delegated for its platform yet.
pub async fn paused(store: &Db, drive: &str, plugin: &str) -> Option<NeedsConnection> {
    let key = super::installation::resolve(store, drive, plugin)
        .await
        .ok()?
        .signing_as?;
    let agent = store.get_app_agent_info(&key).ok()??.agent;
    let runtime = installation_identity::runtime_of(store, &key.app, &agent)
        .await
        .ok()??;
    let requests = requests_under(store, &runtime.get_subject().to_string())
        .await
        .ok()?;
    for request in requests {
        let Some(platform) = platform_of(&request) else {
            continue;
        };
        let need = NeedsConnection {
            reason: request
                .get(urls::CONNECTION_REQUEST_REASON)
                .ok()
                .and_then(string_of)
                .unwrap_or_else(|| NOT_CONNECTED.into()),
            platform,
        };
        if is_open(&request) {
            return Some(need);
        }
        match installation_identity::delegated_connection(store, &key.app, &need.platform).await {
            Ok(Some(_)) => {}
            _ => return Some(need),
        }
    }
    None
}

const PAUSED_PREFIX: &str = "Paused: needs a ";

/// The message a paused schedule shows as its last error.
pub fn paused_message(need: &NeedsConnection) -> String {
    format!(
        "{PAUSED_PREFIX}{} connection. Connect it on the Installation's page to resume.",
        need.platform
    )
}

/// Whether a schedule's last error is only [`paused_message`].
pub fn is_paused_message(error: &str) -> bool {
    error.starts_with(PAUSED_PREFIX)
}

fn same_agent(a: &str, b: &str) -> bool {
    match (
        atomic_lib::identifiers::agent_public_key(a),
        atomic_lib::identifiers::agent_public_key(b),
    ) {
        (Some(a), Some(b)) => a == b,
        _ => a == b,
    }
}

/// What a commit to a `ConnectionRequest` may do, on any node.
pub async fn check_commit(
    store: &Db,
    signer: &str,
    resource: &Resource,
    is_new: bool,
    changed_props: &HashSet<String>,
) -> AtomicResult<()> {
    if !is_new && changed_props.contains(urls::PARENT) {
        return Err("a ConnectionRequest cannot move to another parent".into());
    }
    let parent = resource
        .get(urls::PARENT)
        .ok()
        .and_then(string_of)
        .ok_or("a ConnectionRequest must be a child of an InstallationRuntime")?;
    let runtime = store
        .get_resource(&parent.as_str().into())
        .await
        .map_err(|_| AtomicError::from("a ConnectionRequest's InstallationRuntime is not here"))?;
    if !runtime.has_class(urls::INSTALLATION_RUNTIME) {
        return Err("a ConnectionRequest must be a child of an InstallationRuntime".into());
    }
    let runtime_agent = runtime
        .get(urls::INTEGRATION_RUNTIME_AGENT)
        .ok()
        .and_then(string_of)
        .ok_or("the InstallationRuntime names no agent")?;
    let installation = runtime
        .get(urls::PARENT)
        .ok()
        .and_then(string_of)
        .ok_or("the InstallationRuntime has no Installation")?;
    let installation = store
        .get_resource(&installation.as_str().into())
        .await
        .map_err(|_| AtomicError::from("the request's Installation is not here"))?;
    if !installation.has_class(urls::INSTALLATION) {
        return Err(
            "a ConnectionRequest's InstallationRuntime must be a child of an Installation".into(),
        );
    }

    let asks = [
        urls::IS_A,
        urls::CONNECTION_REQUEST_PLATFORM,
        urls::CONNECTION_REQUEST_REASON,
        urls::CONNECTION_REQUESTED_AT,
    ];
    if (is_new || asks.iter().any(|p| changed_props.contains(*p)))
        && !same_agent(signer, &runtime_agent)
    {
        return Err(AtomicError::from(
            "only the node agent published on its InstallationRuntime may ask for a connection",
        ));
    }
    if is_new && resource.get(urls::CONNECTION_REQUEST_CLEARED_AT).is_ok() {
        return Err("a new ConnectionRequest cannot already be cleared".into());
    }
    if !is_new && changed_props.contains(urls::CONNECTION_REQUEST_PLATFORM) {
        return Err("a ConnectionRequest's platform cannot change; ask for another one".into());
    }
    if platform_of(resource).is_none_or(|p| p.trim().is_empty()) {
        return Err("a ConnectionRequest names the platform it needs".into());
    }
    let reason = resource
        .get(urls::CONNECTION_REQUEST_REASON)
        .ok()
        .and_then(string_of)
        .unwrap_or_default();
    if !REASONS.contains(&reason.as_str()) {
        return Err(format!(
            "connectionRequestReason is '{reason}'; expected one of {}",
            REASONS.join(", ")
        )
        .into());
    }
    if changed_props.contains(urls::CONNECTION_REQUEST_CLEARED_AT) {
        atomic_lib::hierarchy::check_write(
            store,
            &installation,
            &ForAgent::AgentSubject(signer.into()),
        )
        .await
        .map_err(|_| {
            AtomicError::from("only a writer of the Installation may clear its connection requests")
        })?;
    }
    Ok(())
}

fn before_commit(context: CommitExtenderContext) -> BoxFuture<AtomicResult<()>> {
    Box::pin(async move {
        let CommitExtenderContext {
            store,
            commit,
            resource,
            is_new,
            changed_props,
        } = context;
        // Who may delete it is the hierarchy's business: its node agent and
        // the Installation's writers.
        if commit.destroy == Some(true) {
            return Ok(());
        }
        check_commit(
            store,
            &commit.signer.to_string(),
            resource,
            is_new,
            changed_props,
        )
        .await
    })
}

pub fn build_extender() -> ClassExtender {
    ClassExtender::builder()
        .id("connection-request".to_string())
        .classes(vec![urls::CONNECTION_REQUEST.to_string()])
        .before_commit(ClassExtender::wrap_commit_handler(before_commit))
        .build()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::plugins::test_fixture::{fixture, Fixture};
    use atomic_lib::{
        agents::Agent,
        db::{
            plugin_release::PluginRelease,
            plugin_schedule::{PluginSchedule, PluginScheduleKey},
        },
    };

    /// Declares `clockify`, calls it, and swallows the error: the run must end
    /// with the typed outcome even when the plugin catches what `ctx.http`
    /// threw. Otherwise it proposes one resource.
    fn source(drive: &str) -> String {
        format!(
            r#"export const manifest = {{schemaVersion: 2, proxy: ['clockify'],
                operations: [{{id: 'user', method: 'GET', url: 'atomic-proxy:/clockify/api/v1/user', effect: 'read'}}]}};
            export function run(ctx) {{
                let seen = 'none';
                try {{ seen = ctx.http({{operation: 'user', method: 'GET', url: 'atomic-proxy:/clockify/api/v1/user'}}).status; }}
                catch (e) {{ seen = String(e); }}
                return {{ intents: [{{ op: 'create', localId: 'made', parent: {drive:?}, isA: [],
                    set: {{ "https://atomicdata.dev/properties/name": 'Imported ' + seen }} }}] }};
            }}"#
        )
    }

    /// A stand-in integration proxy on loopback that answers every request
    /// with 200 and counts the ones for the delegated connection.
    pub(crate) async fn stub_proxy() -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = [0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                if String::from_utf8_lossy(&buf[..n]).starts_with("GET /proxy/conn-1/clockify/") {
                    counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                    )
                    .await;
            }
        });
        (origin, hits)
    }

    /// An active JS Installation of `source`, whose activation minted this
    /// node's agent and published it on an InstallationRuntime.
    pub(crate) async fn install(f: &Fixture) -> String {
        let db = &f.appstate.store;
        let source = source(&f.drive);
        let id = db
            .publish_plugin_release(&PluginRelease::js(
                source.clone(),
                serde_json::json!({"schemaVersion": 2, "proxy": ["clockify"]}),
                Default::default(),
            ))
            .unwrap();
        let mut resource = Resource::new("did:ad:placeholder".into());
        for (property, value) in [
            (
                urls::IS_A,
                Value::ResourceArray(vec![urls::INSTALLATION.into()]),
            ),
            (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
            (urls::NAME, Value::String("timesheets".into())),
            (urls::NAMESPACE, Value::String("acme".into())),
            (urls::RELEASE_PROP, Value::String(id.clone())),
            (urls::RELEASE_ID, Value::String(id)),
            (urls::INSTALLATION_STATUS, Value::String("active".into())),
            (urls::GRANTS, Value::Json(serde_json::json!([]))),
            (
                f.terms.property("plugin-source").unwrap(),
                Value::Markdown(source),
            ),
        ] {
            resource.set_unsafe(property.into(), value).unwrap();
        }
        resource.save_as_genesis(db).await.unwrap();
        resource.get_subject().to_string()
    }

    fn node_agent(f: &Fixture, installation: &str) -> Agent {
        f.appstate
            .store
            .with_app_agent(&AppAgentKey::new(&f.drive, installation), |a| a.clone())
            .unwrap()
            .expect("activation minted this node's agent")
    }

    pub(crate) async fn requests(f: &Fixture, installation: &str) -> Vec<Resource> {
        let db = &f.appstate.store;
        let agent = node_agent(f, installation).subject.to_string();
        let runtime = installation_identity::runtime_of(db, installation, &agent)
            .await
            .unwrap()
            .expect("the node published its runtime");
        requests_under(db, &runtime.get_subject().to_string())
            .await
            .unwrap()
    }

    /// Due now, reads as the node's default agent, proposals kept for review.
    fn arm(f: &Fixture, installation: &str) -> PluginScheduleKey {
        let db = &f.appstate.store;
        let key = PluginScheduleKey::new(&f.drive, installation);
        let mut schedule = PluginSchedule::new(3600, 0).unwrap();
        schedule.next_run_at = 0;
        schedule.run_as = Some(db.get_default_agent().unwrap().subject.to_string());
        db.set_plugin_schedule(&key, &schedule).unwrap();
        key
    }

    /// Sets one property, signed by `by`, or by the node's default agent (a
    /// writer of the Installation) when `None`.
    async fn set(
        f: &Fixture,
        subject: &str,
        property: &str,
        value: Value,
        by: Option<&Agent>,
    ) -> AtomicResult<()> {
        let db = &f.appstate.store;
        let mut resource = db.get_resource(&subject.into()).await?;
        resource.set_unsafe(property.into(), value)?;
        match by {
            Some(agent) => resource.save_as(agent, db).await.map(|_| ()),
            None => resource.save(db).await.map(|_| ()),
        }
    }

    pub(crate) async fn clear(f: &Fixture, request: &str) -> AtomicResult<()> {
        set(
            f,
            request,
            urls::CONNECTION_REQUEST_CLEARED_AT,
            Value::Timestamp(atomic_lib::utils::now()),
            None,
        )
        .await
    }

    pub(crate) async fn delegate(f: &Fixture, installation: &str) {
        set(
            f,
            installation,
            urls::INTEGRATION_CONNECTIONS,
            Value::Json(serde_json::json!({"clockify": "conn-1"})),
            None,
        )
        .await
        .unwrap();
    }

    #[test]
    fn the_outcome_survives_the_error_string() {
        let need = NeedsConnection::not_connected("clockify");
        let error = need.to_error();
        assert!(
            error.contains("no clockify connection is delegated"),
            "{error}"
        );
        assert_eq!(NeedsConnection::from_error(&error), Some(need.clone()));
        assert_eq!(needs_connection(&need.verdict()), Some(need));
        assert_eq!(NeedsConnection::from_error("request to x failed"), None);
        assert_eq!(needs_connection(r#"{"intents":[]}"#), None);
    }

    #[actix_rt::test]
    async fn a_missing_connection_ends_the_run_with_the_typed_outcome_and_asks_for_it() {
        let f = fixture("conn_request_outcome").await;
        let db = std::sync::Arc::new(f.appstate.store.clone());
        db.set_integration_proxy(Some("http://127.0.0.1:9".into()));
        let installation = install(&f).await;

        let source = source(&f.drive);
        let host = crate::plugins::js_runtime::StoreHost {
            db: db.clone(),
            plugin: installation.clone(),
            drive: f.drive.clone(),
            for_agent: ForAgent::AgentSubject(db.get_default_agent().unwrap().subject),
            manifest: crate::plugins::js_runtime::describe_manifest(&source)
                .await
                .unwrap(),
        };
        let verdict = crate::plugins::js_runtime::embedded_runtime()
            .unwrap()
            .run(&source, r#"{"trigger":{"kind":"manual","at":0}}"#, host)
            .await
            .unwrap()
            .unwrap();
        // Typed, although the plugin caught the error; and nothing to apply.
        assert_eq!(
            needs_connection(&verdict),
            Some(NeedsConnection::not_connected("clockify")),
            "{verdict}"
        );
        let parsed: serde_json::Value = serde_json::from_str(&verdict).unwrap();
        assert_eq!(parsed["intents"], serde_json::json!([]));

        let found = requests(&f, &installation).await;
        assert_eq!(found.len(), 1);
        let request = &found[0];
        assert!(is_open(request));
        assert_eq!(platform_of(request).as_deref(), Some("clockify"));
        assert_eq!(
            request
                .get(urls::CONNECTION_REQUEST_REASON)
                .unwrap()
                .to_string(),
            NOT_CONNECTED
        );
        assert!(int_of(request, urls::CONNECTION_REQUESTED_AT).is_some());
        // Signed by this node's agent for the Installation.
        let genesis = request.get(urls::LAST_COMMIT).unwrap().to_string();
        let genesis = db.get_resource(&genesis.as_str().into()).await.unwrap();
        assert_eq!(
            genesis.get(urls::SIGNER).unwrap().to_string(),
            node_agent(&f, &installation).subject.to_string()
        );
        // What a page needs to see it: a genesis certificate naming that
        // signer (`createdBy`, checked offline), and the drive, which routes
        // the commit to the drive's clients.
        assert_eq!(
            request.genesis_signer(),
            Some(node_agent(&f, &installation).subject.to_string())
        );
        assert_eq!(request.get(urls::DRIVE_PROP).unwrap().to_string(), f.drive);
        let runtime = db
            .get_resource(
                &request
                    .get(urls::PARENT)
                    .unwrap()
                    .to_string()
                    .as_str()
                    .into(),
            )
            .await
            .unwrap();
        assert_eq!(
            runtime.genesis_signer(),
            Some(node_agent(&f, &installation).subject.to_string())
        );
        assert_eq!(runtime.get(urls::DRIVE_PROP).unwrap().to_string(), f.drive);
    }

    #[actix_rt::test]
    async fn a_scheduled_run_pauses_until_the_request_is_cleared_and_a_connection_exists() {
        let f = fixture("conn_request_pause").await;
        let db = &f.appstate.store;
        let (origin, hits) = stub_proxy().await;
        db.set_integration_proxy(Some(origin));
        let installation = install(&f).await;
        let key = arm(&f, &installation);
        let schedule = || db.get_plugin_schedule(&key).unwrap().unwrap();

        // The first run needs the connection: no proposal, the request is
        // written, and the schedule says why it stopped.
        assert_eq!(crate::plugins::scheduler::run_due(&f.appstate).await, 1);
        assert_eq!(schedule().pending_verdict, None);
        assert!(
            schedule()
                .last_error
                .unwrap_or_default()
                .contains("needs a clockify connection"),
            "{:?}",
            schedule().last_error
        );
        let request = requests(&f, &installation).await;
        assert_eq!(request.len(), 1);
        let request = request[0].get_subject().to_string();

        // Paused: nothing runs, not on the next tick nor the one after.
        assert_eq!(crate::plugins::scheduler::run_due(&f.appstate).await, 0);
        assert_eq!(crate::plugins::scheduler::run_due(&f.appstate).await, 0);
        assert_eq!(requests(&f, &installation).await.len(), 1);

        // A connection alone does not resume it: the request is still open.
        delegate(&f, &installation).await;
        assert_eq!(crate::plugins::scheduler::run_due(&f.appstate).await, 0);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);

        // Cleared by a writer of the Installation, with a connection: resumed.
        clear(&f, &request).await.unwrap();
        assert_eq!(paused(db, &f.drive, &installation).await, None);
        assert_eq!(crate::plugins::scheduler::run_due(&f.appstate).await, 1);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        let proposal = schedule()
            .pending_verdict
            .expect("the resumed run proposed");
        assert!(proposal.contains("Imported 200"), "{proposal}");
        assert_eq!(schedule().last_error, None);
        // Still one request, now cleared.
        let found = requests(&f, &installation).await;
        assert_eq!(found.len(), 1);
        assert!(!is_open(&found[0]));
    }

    #[actix_rt::test]
    async fn a_cleared_request_without_a_connection_stays_paused_and_is_reopened_not_duplicated() {
        let f = fixture("conn_request_reopen").await;
        let db = &f.appstate.store;
        db.set_integration_proxy(Some("http://127.0.0.1:9".into()));
        let installation = install(&f).await;
        let key = AppAgentKey::new(&f.drive, &installation);
        let need = NeedsConnection::not_connected("clockify");

        let first = record(db, &key, &need).await.unwrap();
        assert!(paused(db, &f.drive, &installation).await.is_some());
        clear(&f, &first).await.unwrap();
        // Cleared, but nothing is delegated for clockify yet.
        assert_eq!(
            paused(db, &f.drive, &installation).await,
            Some(need.clone())
        );

        // Asked again: the same request, open again.
        assert_eq!(record(db, &key, &need).await.unwrap(), first);
        let found = requests(&f, &installation).await;
        assert_eq!(found.len(), 1);
        assert!(is_open(&found[0]));
    }

    #[actix_rt::test]
    async fn only_the_nodes_agent_asks_and_only_installation_writers_clear() {
        let f = fixture("conn_request_rights").await;
        let db = &f.appstate.store;
        let installation = install(&f).await;
        let key = AppAgentKey::new(&f.drive, &installation);
        let node = node_agent(&f, &installation);
        let request = record(db, &key, &NeedsConnection::not_connected("clockify"))
            .await
            .unwrap();
        let runtime = db
            .get_resource(&request.as_str().into())
            .await
            .unwrap()
            .get(urls::PARENT)
            .unwrap()
            .to_string();

        let new_request = |parent: &str| {
            let mut forged = Resource::new("did:ad:placeholder".into());
            for (property, value) in [
                (
                    urls::IS_A,
                    Value::ResourceArray(vec![urls::CONNECTION_REQUEST.into()]),
                ),
                (urls::PARENT, Value::AtomicUrl(parent.into())),
                (
                    urls::CONNECTION_REQUEST_PLATFORM,
                    Value::String("clockify".into()),
                ),
                (
                    urls::CONNECTION_REQUEST_REASON,
                    Value::String(NOT_CONNECTED.into()),
                ),
                (urls::CONNECTION_REQUESTED_AT, Value::Timestamp(1)),
            ] {
                forged.set_unsafe(property.into(), value).unwrap();
            }
            forged
        };

        // A foreign agent cannot open a request under this node's runtime,
        // even where the rights check is skipped (a local genesis).
        let foreign = Agent::new(None).unwrap();
        let err = new_request(&runtime)
            .save_as_genesis_signed_by(&foreign, db)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("only the node agent"), "{err}");

        // Nor change what an existing one asks for; and neither can the
        // Installation's writer: asking is the node's.
        for by in [Some(&foreign), None] {
            let err = set(
                &f,
                &request,
                urls::CONNECTION_REQUEST_REASON,
                Value::String(REVOKED.into()),
                by,
            )
            .await
            .unwrap_err();
            assert!(err.to_string().contains("only the node agent"), "{err}");
        }

        // Neither the node nor a stranger may clear it.
        for agent in [&node, &foreign] {
            let err = set(
                &f,
                &request,
                urls::CONNECTION_REQUEST_CLEARED_AT,
                Value::Timestamp(atomic_lib::utils::now()),
                Some(agent),
            )
            .await
            .unwrap_err();
            assert!(
                err.to_string().contains("writer of the Installation"),
                "{err}"
            );
        }

        // The Installation's writer does.
        clear(&f, &request).await.unwrap();
        let stored = db.get_resource(&request.as_str().into()).await.unwrap();
        assert!(!is_open(&stored));

        // A request hangs under an InstallationRuntime, not the Installation.
        let err = new_request(&installation)
            .save_as_genesis_signed_by(&node, db)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("InstallationRuntime"), "{err}");
    }
}
