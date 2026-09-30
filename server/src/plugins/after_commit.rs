//! The durable `afterCommit` hook for user-installed plugins (#1851).
//!
//! Design: `planning/durable-after-commit.md`. In short: a plugin whose view
//! is installed on a table, and that exports `afterCommit`, is told about the
//! table's changed rows, also while nobody has the tab open. "Hook for speed,
//! change list for correctness":
//!
//! - **Subscription.** One record per (drive, app, table), made by the same
//!   signed gestures as the #1788 row grant, on both answers (Allow editing
//!   and Read-only). Its `activated_by` is whose rights the reads run with.
//! - **Wake-up.** The change list (#1850) upserts a small marker in the same
//!   transaction as each change to a subscribed table
//!   (`atomic_lib::after_commit_wake`). Markers coalesce.
//! - **Delivery.** The worker claims a marker (after a short debounce), reads
//!   the next page of the change list from the subscription's cursor as
//!   `activated_by`, drops the plugin's own echoes, and persists a delivery.
//!   It runs `afterCommit(ctx)` with the page as `ctx.event`. The cursor moves
//!   only in the batch that acknowledges the delivery.
//! - **Writes.** Under a live row grant, writes within its scope (and to the
//!   app's own subtree) apply unattended, signed by the app agent. Anything
//!   else is held for review; while it waits, the plugin is paused on that
//!   table (one delivery at a time), and catches up once it is answered.
//! - **Failures.** Retried with backoff (30 s doubling to 1 h); after 8 failed
//!   attempts the table's delivery stops until someone presses Retry or the
//!   plugin's source changes. Nothing is lost while it is stopped.
//!
//! Everything here is inert unless the server runs with
//! `--plugin-after-commit`: no subscription is recorded and no marker written.
//!
//! Records live in `Tree::PluginMeta`, next to the trigger and grant records:
//! `after-commit/v1/sub/[drive,app,table]`, `after-commit/v1/delivery/{id}`,
//! `after-commit/v1/own/{id}/{row}` and the markers `after-commit/v1/wake/{id}`
//! (in `atomic_lib`), where `id` is a hash of the subscription's key.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use atomic_lib::{
    after_commit_wake::Wake,
    agents::ForAgent,
    change_log::{self, ChangeListError, TableChange, VersionMap},
    db::trees::{Method, Operation, Tree},
    hierarchy::check_write,
    urls, Db, Storelike, Subject, Value,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use tokio::sync::Mutex;

use super::app_row_grant::{self, pure, RowGrant, RowWrite};
use super::apply::{self, ApplyHost, ApplyOptions, ApplyReport, ChangeStatus, CreateRequest};
use super::host_core::{PluginHost, ResourceGrants};
use super::js_runtime::{self, StoreHost};
use super::manifest::{Manifest, World};
use super::plan::{plan_verdict, Op, PlanHost, PlannedChange, RunPlan};
use super::plugin::STATUS_REVOKED;
use super::store_host::StoreApplyHost;
use crate::appstate::AppState;

const SUB_PREFIX: &str = "after-commit/v1/sub/";
const DELIVERY_PREFIX: &str = "after-commit/v1/delivery/";
const OWN_PREFIX: &str = "after-commit/v1/own/";

/// Rows per delivery (the change list's default page).
pub const PAGE_SIZE: usize = 100;
/// Failed attempts before a table's delivery stops and waits for Retry.
pub const MAX_ATTEMPTS: u32 = 8;
const BACKOFF_BASE_MS: i64 = 30_000;
const BACKOFF_CAP_MS: i64 = 60 * 60 * 1000;
/// Runs a minute per plugin, counting only runs a change woke.
pub const RATE_LIMIT: usize = 30;
const RATE_WINDOW_MS: i64 = 60_000;
/// Claim this long after the last change...
pub const DEBOUNCE_MS: i64 = 2_000;
/// ...or this long after the first, whichever comes first.
const DEBOUNCE_MAX_MS: i64 = 10_000;
/// Wall clock per run: a hung `fetch` must not hold the worker.
const RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// How often cursors are compared with the change list's head.
pub const SWEEP_INTERVAL_MS: i64 = 10 * 60 * 1000;
/// Own-write records older than this are dropped.
const OWN_WRITE_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Backfilled at startup for a view that already had a live row grant.
pub const VIA_GRANT_BACKFILL: &str = "grant-backfill";
/// Ended because the person who turned it on can no longer read the table.
pub const VIA_ACTIVATOR_LOST_READ: &str = "activator-lost-read";
/// Ended because the table is gone or no longer a table.
pub const VIA_TABLE_GONE: &str = "table-gone";
/// Ended because the app or its Installation was uninstalled (destroyed).
pub const VIA_UNINSTALLED: &str = "uninstalled";
/// Ended because the app's Installation was revoked.
pub const VIA_REVOKED: &str = "revoked";

const FOLLOW_VIAS: [&str; 6] = [
    app_row_grant::VIA_ADD_VIEW,
    app_row_grant::VIA_VIEW_TYPE,
    app_row_grant::VIA_MENU,
    app_row_grant::VIA_REQUEST,
    app_row_grant::VIA_HOOK_REVIEW,
    VIA_GRANT_BACKFILL,
];

// ------------------------------------------------------------- records

/// Why a table's delivery stopped (poison or the loop cap).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopped {
    pub reason: String,
    pub at: i64,
    pub attempts: u32,
    /// The plugin source that kept failing. A new one restarts delivery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
}

/// A proposal waiting for review, as the bar on the tab shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    /// Rows (and other resources) it would change.
    pub rows: usize,
    /// Up to 20 of them.
    pub subjects: Vec<String>,
    /// Every change stays within what a row grant covers, so "Allow all
    /// edits by this view on this table" can be offered.
    pub in_scope: bool,
    pub at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    /// Hash of (drive, app, table): the id of its marker and delivery.
    pub id: String,
    pub drive: String,
    /// Pure id of the app named by the View's `view-kind`.
    pub app: String,
    /// The Installation the app belongs to, for display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installation: Option<String>,
    pub table: String,
    /// The View whose gesture made it.
    pub view: String,
    /// Signer of the gesture; reads run as this agent.
    pub activated_by: String,
    pub activated_at: i64,
    pub via: String,
    /// Opaque change-list cursor. `None` until the first delivery.
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<Stopped>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_delivered_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Pending>,
    /// The plugin asked for a full compare on its next delivery.
    #[serde(default)]
    pub resync: bool,
    /// The waiting marker is a `hasMore` continuation, not a new change: it
    /// does not count toward the loop cap.
    #[serde(default)]
    pub continuation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_via: Option<String>,
}

impl Subscription {
    pub fn is_live(&self) -> bool {
        self.ended_at.is_none()
    }
}

/// One page in flight for a subscription. At most one per subscription.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivery {
    /// Stable across redeliveries: the journal's and the run's identity.
    pub id: String,
    pub subscription: String,
    pub from: Option<String>,
    pub to: String,
    pub changes: Vec<TableChange>,
    pub has_more: bool,
    /// `initial`, `expired` or `requested`: not a delta, do a full compare.
    pub reset: Option<String>,
    /// Failed attempts so far.
    pub attempts: u32,
    pub next_attempt_at: i64,
    /// The run's frozen clock.
    pub at: i64,
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub waiting_for_review: bool,
    /// The plugin source that made the proposal waiting for review. If the
    /// app's source changes meanwhile, the proposal is discarded and the
    /// page runs again on the new source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_hash: Option<String>,
}

/// A row the hook wrote, so its echo is not delivered back to it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnWrite {
    pub before: Option<VersionMap>,
    pub after: VersionMap,
    pub run: String,
    pub at: i64,
}

fn tuple(drive: &str, app: &str, table: &str) -> String {
    json!([pure(drive), pure(app), pure(table)]).to_string()
}

fn sub_key(drive: &str, app: &str, table: &str) -> String {
    format!("{SUB_PREFIX}{}", tuple(drive, app, table))
}

fn key_of(sub: &Subscription) -> String {
    sub_key(&sub.drive, &sub.app, &sub.table)
}

/// The marker and delivery id of a subscription.
pub fn sub_id(drive: &str, app: &str, table: &str) -> String {
    blake3::hash(tuple(drive, app, table).as_bytes()).to_hex()[..32].to_string()
}

fn delivery_key(id: &str) -> String {
    format!("{DELIVERY_PREFIX}{id}")
}

fn own_prefix(id: &str) -> String {
    format!("{OWN_PREFIX}{id}/")
}

fn own_key(id: &str, row: &str) -> String {
    format!("{}{row}", own_prefix(id))
}

fn put_json<T: Serialize>(db: &Db, key: &str, value: &T) -> Result<(), String> {
    db.kv
        .insert(
            Tree::PluginMeta,
            key.as_bytes(),
            &serde_json::to_vec(value).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    db.flush().map_err(|e| e.to_string())
}

fn get_json<T: for<'a> Deserialize<'a>>(db: &Db, key: &str) -> Result<Option<T>, String> {
    db.kv
        .get(Tree::PluginMeta, key.as_bytes())
        .map_err(|e| e.to_string())?
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string()))
        .transpose()
}

fn remove(db: &Db, key: &str) -> Result<(), String> {
    db.kv
        .remove(Tree::PluginMeta, key.as_bytes())
        .map_err(|e| e.to_string())
}

pub fn save(db: &Db, sub: &Subscription) -> Result<(), String> {
    put_json(db, &key_of(sub), sub)
}

pub fn find(db: &Db, drive: &str, app: &str, table: &str) -> Result<Option<Subscription>, String> {
    get_json(db, &sub_key(drive, app, table))
}

/// Every subscription, live and ended.
pub fn all(db: &Db) -> Result<Vec<Subscription>, String> {
    db.kv
        .scan_prefix(Tree::PluginMeta, SUB_PREFIX.as_bytes())
        .map(|row| {
            row.map_err(|e| e.to_string())
                .and_then(|(_, v)| serde_json::from_slice(&v).map_err(|e| e.to_string()))
        })
        .collect()
}

pub fn delivery(db: &Db, id: &str) -> Result<Option<Delivery>, String> {
    get_json(db, &delivery_key(id))
}

fn save_delivery(db: &Db, delivery: &Delivery) -> Result<(), String> {
    put_json(db, &delivery_key(&delivery.subscription), delivery)
}

/// Rebuild the store's table → marker index from the live subscriptions.
/// Off (no markers at all) unless `enabled`.
pub fn rebuild_index(db: &Db, enabled: bool) -> Result<(), String> {
    if !enabled {
        db.set_after_commit_index(None);
        return Ok(());
    }
    let mut index: HashMap<String, Vec<String>> = HashMap::new();
    for sub in all(db)?.into_iter().filter(Subscription::is_live) {
        index.entry(sub.table.clone()).or_default().push(sub.id);
    }
    db.set_after_commit_index(Some(index));
    Ok(())
}

fn refresh_index(db: &Db) -> Result<(), String> {
    rebuild_index(db, db.after_commit_enabled())
}

// ------------------------------------------------------- eligibility

/// The plugin a subscription delivers to: its source and manifest.
pub struct Package {
    pub source: String,
    pub manifest: Manifest,
    pub source_hash: String,
    pub installation: Option<String>,
}

fn text(resource: &atomic_lib::Resource, property: &str) -> Option<String> {
    match resource.get(property).ok()? {
        Value::String(s) | Value::Markdown(s) | Value::Slug(s) => Some(s.clone()),
        Value::AtomicUrl(s) => Some(s.to_string()),
        other => Some(other.to_string()),
    }
}

/// The source and manifest `app` runs: the pinned release of the
/// Installation at or above it, or, for an app written in the drive, its own
/// `plugin-source` with the manifest it exports.
pub async fn package_of(db: &Db, drive: &str, app: &str) -> Result<Package, String> {
    let mut current = db
        .get_resource(&app.into())
        .await
        .map_err(|e| format!("the app could not be read: {e}"))?;
    let mut seen = HashSet::new();
    loop {
        if current.has_class(urls::INSTALLATION) {
            let id = text(&current, urls::RELEASE_ID).ok_or("the installation pins no release")?;
            let release = db
                .get_plugin_release(&id)
                .map_err(|e| format!("the pinned release is not on this node: {e}"))?;
            let source = release
                .source
                .ok_or("the pinned release is not a JS release")?;
            let manifest =
                Manifest::parse(release.manifest)?.ok_or("the pinned release has no manifest")?;
            return Ok(Package {
                source_hash: blake3::hash(source.as_bytes()).to_hex().to_string(),
                source,
                manifest,
                installation: Some(current.get_subject().to_string()),
            });
        }
        if !seen.insert(current.get_subject().pure_id()) || seen.len() > 64 {
            break;
        }
        match current.get_parent(db).await {
            Ok(parent) if parent.get_subject().pure_id() != pure(drive) => current = parent,
            _ => break,
        }
    }
    // An app made with `createApp` keeps its code on the plugin it opens to
    // (its `entrypoint`), not on itself.
    let source = match super::scheduler::plugin_source(db, drive, app).await {
        Some(source) => source,
        None => {
            let entrypoint = match super::scheduler::drive_terms(db, drive).await {
                Some(terms) => match terms.property("entrypoint") {
                    Some(property) => db
                        .get_resource(&app.into())
                        .await
                        .ok()
                        .and_then(|r| r.get(property).ok().map(|v| v.to_string())),
                    None => None,
                },
                None => None,
            };
            match entrypoint {
                Some(entrypoint) => super::scheduler::plugin_source(db, drive, &entrypoint)
                    .await
                    .ok_or("the app's entrypoint has no source")?,
                None => return Err("the app has no source".into()),
            }
        }
    };
    let manifest = js_runtime::describe_manifest(&source)
        .await?
        .ok_or("the app's source exports no manifest")?;
    Ok(Package {
        source_hash: blake3::hash(source.as_bytes()).to_hex().to_string(),
        source,
        manifest,
        installation: None,
    })
}

/// Whether `app` exports the hook: an extension that declares it.
pub fn declares_after_commit(manifest: &Manifest) -> bool {
    manifest.world == World::Extension && manifest.entrypoints.after_commit
}

/// Why a subscription does not deliver right now.
#[derive(Debug)]
pub enum NotNow {
    /// It will again later (paused, no source yet, the host failed).
    Wait(String),
    /// It never will: end it, recorded with this `via`.
    End(&'static str),
}

pub struct Eligible {
    pub package: Package,
    pub row_class: String,
}

/// The table's row class, or why the subscription can never deliver again:
/// the table, view, app or Installation is gone, the Installation was
/// revoked, or the person who turned it on can no longer read the table. A
/// paused Installation is not a reason: it waits.
async fn row_class_or_end(db: &Db, sub: &Subscription) -> Result<String, &'static str> {
    let Ok(table) = db.get_resource(&sub.table.as_str().into()).await else {
        return Err(VIA_TABLE_GONE);
    };
    let Some(row_class) = table
        .get(urls::CLASSTYPE_PROP)
        .ok()
        .and_then(app_row_grant::string_of)
        .map(|c| pure(&c))
    else {
        return Err(VIA_TABLE_GONE);
    };
    if db.get_resource(&sub.app.as_str().into()).await.is_err() {
        return Err(VIA_UNINSTALLED);
    }
    if let Some(installation) = &sub.installation {
        match db.get_resource(&installation.as_str().into()).await {
            Err(_) => return Err(VIA_UNINSTALLED),
            Ok(r) if text(&r, urls::INSTALLATION_STATUS).as_deref() == Some(STATUS_REVOKED) => {
                return Err(VIA_REVOKED)
            }
            Ok(_) => {}
        }
    }
    if let Some(why) = app_row_grant::view_problem(db, &sub.table, &sub.app, &sub.view).await {
        return Err(why);
    }
    if atomic_lib::hierarchy::check_read(
        db,
        &table,
        &ForAgent::AgentSubject(sub.activated_by.as_str().into()),
    )
    .await
    .is_err()
    {
        return Err(VIA_ACTIVATOR_LOST_READ);
    }
    Ok(row_class)
}

/// Why `sub` can never deliver again, if so ([`row_class_or_end`]).
pub async fn end_reason(db: &Db, sub: &Subscription) -> Option<&'static str> {
    row_class_or_end(db, sub).await.err()
}

pub async fn eligibility(db: &Db, sub: &Subscription) -> Result<Eligible, NotNow> {
    let row_class = row_class_or_end(db, sub).await.map_err(NotNow::End)?;
    let installation = super::installation::resolve(db, &sub.drive, &sub.app)
        .await
        .map_err(NotNow::Wait)?;
    if installation
        .signing_as
        .as_ref()
        .is_none_or(|key| pure(&key.app) != pure(&sub.app))
    {
        return Err(NotNow::Wait(
            "this app has no key of its own, so it cannot run unattended".into(),
        ));
    }
    let package = package_of(db, &sub.drive, &sub.app)
        .await
        .map_err(NotNow::Wait)?;
    if !declares_after_commit(&package.manifest) {
        return Err(NotNow::Wait(
            "this plugin's manifest does not declare entrypoints.afterCommit".into(),
        ));
    }
    Ok(Eligible { package, row_class })
}

// ------------------------------------------------ subscribe and end

/// Records that `app`, shown as `view` of `table`, follows its changes, on
/// the signed gesture of `activated_by` (#1851, decision 1: both dialog
/// answers). `None` when the hook is off on this server or the app does not
/// export it. Following twice is one subscription.
pub async fn follow(
    db: &Db,
    drive: &str,
    table: &str,
    app: &str,
    view: &str,
    activated_by: &str,
    via: &str,
) -> Result<Option<Subscription>, String> {
    if !db.after_commit_enabled() {
        return Ok(None);
    }
    if !FOLLOW_VIAS.contains(&via) {
        return Err(format!(
            "Following a table's changes starts from adding its view, not from '{via}'"
        ));
    }
    if !app_row_grant::may_write(db, table, activated_by).await {
        return Err("Only someone who can edit this table can let an app follow it".into());
    }
    if !app_row_grant::may_write(db, app, activated_by).await {
        return Err("Only someone who can use this app can let it follow a table".into());
    }
    if app_row_grant::view_problem(db, table, app, view)
        .await
        .is_some()
    {
        return Err("That view is not a view of this table showing this app".into());
    }
    let package = match package_of(db, drive, app).await {
        Ok(package) if declares_after_commit(&package.manifest) => package,
        _ => return Ok(None),
    };
    if let Some(existing) = find(db, drive, app, table)?.filter(Subscription::is_live) {
        return Ok(Some(existing));
    }
    let sub = Subscription {
        id: sub_id(drive, app, table),
        drive: drive.to_string(),
        app: pure(app),
        installation: package.installation,
        table: pure(table),
        view: pure(view),
        activated_by: activated_by.to_string(),
        activated_at: atomic_lib::utils::now(),
        via: via.to_string(),
        cursor: None,
        stopped: None,
        last_error: None,
        last_delivered_at: None,
        pending: None,
        resync: false,
        continuation: false,
        ended_at: None,
        ended_by: None,
        ended_via: None,
    };
    // A re-added view starts over: whatever an ended one left behind goes.
    clear_state(db, &sub.id)?;
    save(db, &sub)?;
    refresh_index(db)?;
    // The first delivery is the `initial` one.
    db.wake_after_commit(&sub.id).map_err(|e| e.to_string())?;
    Ok(Some(sub))
}

fn clear_state(db: &Db, id: &str) -> Result<(), String> {
    remove(db, &delivery_key(id))?;
    db.drop_after_commit_wakes(&HashSet::from([id.to_string()]))
        .map_err(|e| e.to_string())?;
    let own: Vec<Vec<u8>> = db
        .kv
        .scan_prefix(Tree::PluginMeta, own_prefix(id).as_bytes())
        .flatten()
        .map(|(k, _)| k.to_vec())
        .collect();
    for key in own {
        db.kv
            .remove(Tree::PluginMeta, &key)
            .map_err(|e| e.to_string())?;
    }
    db.flush().map_err(|e| e.to_string())
}

/// Ends `sub`, recorded (not deleted), and drops its markers, delivery and
/// own-write records.
pub fn end(db: &Db, mut sub: Subscription, by: &str, via: &str) -> Result<Subscription, String> {
    sub.ended_at = Some(atomic_lib::utils::now());
    sub.ended_by = Some(by.to_string());
    sub.ended_via = Some(via.to_string());
    sub.pending = None;
    save(db, &sub)?;
    clear_state(db, &sub.id)?;
    refresh_index(db)?;
    Ok(sub)
}

/// Called by the View extender (`app_row_grant::on_view_commit`) when a View
/// is destroyed or its kind changes: ends the subscriptions tied to it.
pub fn end_for_view(
    db: &Db,
    table: &str,
    view: &str,
    kind: Option<&str>,
    destroyed: bool,
    by: &str,
) -> Result<(), String> {
    for sub in all(db)? {
        if !sub.is_live() || sub.table != pure(table) || sub.view != pure(view) {
            continue;
        }
        let via = if destroyed {
            app_row_grant::VIA_VIEW_REMOVED
        } else if kind != Some(sub.app.as_str()) {
            app_row_grant::VIA_VIEW_KIND_CHANGED
        } else {
            continue;
        };
        end(db, sub, by, via)?;
    }
    Ok(())
}

/// Views with a live row grant from before this existed get a subscription,
/// activated by the person who granted it: they already allowed more.
pub async fn backfill_from_grants(db: &Db) -> Result<usize, String> {
    let mut made = 0;
    for grant in app_row_grant::scan(db, "app-row-grant/v1/")? {
        if !grant.is_live() || find(db, &grant.drive, &grant.app, &grant.table)?.is_some() {
            continue;
        }
        if let Ok(Some(_)) = follow(
            db,
            &grant.drive,
            &grant.table,
            &grant.app,
            &grant.view,
            &grant.granted_by,
            VIA_GRANT_BACKFILL,
        )
        .await
        {
            made += 1;
        }
    }
    Ok(made)
}

/// Compares every live subscription's cursor with its table's head and
/// wakes the ones behind, so a lost marker is recovered. Also prunes stale
/// own-write records. Returns how many it woke.
pub async fn sweep(db: &Db) -> Result<usize, String> {
    end_finished(db, None).await?;
    let now = atomic_lib::utils::now();
    let stale: Vec<Vec<u8>> = db
        .kv
        .scan_prefix(Tree::PluginMeta, OWN_PREFIX.as_bytes())
        .flatten()
        .filter(|(_, v)| {
            serde_json::from_slice::<OwnWrite>(v).is_ok_and(|own| now - own.at > OWN_WRITE_TTL_MS)
        })
        .map(|(k, _)| k.to_vec())
        .collect();
    for key in stale {
        db.kv
            .remove(Tree::PluginMeta, &key)
            .map_err(|e| e.to_string())?;
    }
    let mut woken = 0;
    for sub in all(db)?.into_iter().filter(Subscription::is_live) {
        if sub.stopped.is_some()
            || delivery(db, &sub.id)?.is_some()
            || db
                .after_commit_wake(&sub.id)
                .map_err(|e| e.to_string())?
                .is_some()
        {
            continue;
        }
        let head = change_log::table_changes_head(
            db,
            &Subject::from(sub.table.as_str()),
            &ForAgent::AgentSubject(sub.activated_by.as_str().into()),
        )
        .await
        .ok();
        if head.is_none() || sub.cursor != head {
            db.wake_after_commit(&sub.id).map_err(|e| e.to_string())?;
            woken += 1;
        }
    }
    Ok(woken)
}

/// Ends every live subscription (or those in `only`) that can never deliver
/// again ([`end_reason`]), with its markers, delivery and waiting proposal.
/// Under the delivery lock, so a delivery in progress never saves over it.
/// Returns how many it ended.
pub async fn end_finished(db: &Db, only: Option<&HashSet<String>>) -> Result<usize, String> {
    let _lock = db.lock_plugin("after-commit-delivery").await;
    let mut ended = 0;
    for sub in all(db)?.into_iter().filter(Subscription::is_live) {
        if only.is_some_and(|ids| !ids.contains(&sub.id)) {
            continue;
        }
        if let Some(via) = end_reason(db, &sub).await {
            end(db, sub, "server", via)?;
            ended += 1;
        }
    }
    Ok(ended)
}

/// Whose subscription may have ended, now that `changed` changed: those
/// whose table, one of the table's ancestors (read rights are inherited),
/// view, app or Installation it is.
async fn affected(db: &Db, changed: &HashSet<String>) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    for sub in all(db)?.into_iter().filter(Subscription::is_live) {
        let mut hit = [Some(&sub.table), Some(&sub.view), Some(&sub.app)]
            .into_iter()
            .chain([sub.installation.as_ref()])
            .flatten()
            .any(|s| changed.contains(&pure(s)));
        if !hit {
            if let Ok(mut current) = db.get_resource(&sub.table.as_str().into()).await {
                for _ in 0..64 {
                    let Ok(parent) = current.get_parent(db).await else {
                        break;
                    };
                    if changed.contains(&parent.get_subject().pure_id()) {
                        hit = true;
                        break;
                    }
                    if parent.get_subject().pure_id() == pure(&sub.drive) {
                        break;
                    }
                    current = parent;
                }
            }
        }
        if hit {
            ids.insert(sub.id);
        }
    }
    Ok(ids)
}

async fn end_affected(db: &Db, changed: Changed) -> Result<usize, String> {
    match changed {
        Changed::Unknown => end_finished(db, None).await,
        Changed::Subjects(subjects) => {
            let ids = affected(db, &subjects).await?;
            if ids.is_empty() {
                return Ok(0);
            }
            end_finished(db, Some(&ids)).await
        }
    }
}

// ------------------------------------------------------------ worker

/// In-memory state of the delivery worker.
pub struct Worker {
    /// When each plugin was woken, for the loop cap.
    fires: HashMap<String, VecDeque<i64>>,
    pub debounce_ms: i64,
    pub last_sweep: i64,
    /// The store's change events, to end subscriptions as soon as what they
    /// depend on changes (#1907). Subscribed on the first tick.
    events: Option<tokio::sync::broadcast::Receiver<atomic_lib::DbEvent>>,
}

impl Default for Worker {
    fn default() -> Self {
        Self {
            fires: HashMap::new(),
            debounce_ms: DEBOUNCE_MS,
            last_sweep: 0,
            events: None,
        }
    }
}

/// What changed in the store since the worker last looked.
enum Changed {
    /// These subjects (pure ids).
    Subjects(HashSet<String>),
    /// Events were missed: anything may have.
    Unknown,
}

impl Worker {
    fn changed(&mut self, db: &Db) -> Option<Changed> {
        use tokio::sync::broadcast::error::TryRecvError;
        let Some(events) = &mut self.events else {
            self.events = Some(db.subscribe_events());
            return None;
        };
        let mut subjects = HashSet::new();
        loop {
            match events.try_recv() {
                Ok(atomic_lib::DbEvent::Changed { subject, .. })
                | Ok(atomic_lib::DbEvent::Destroyed { subject, .. }) => {
                    subjects.insert(subject.pure_id());
                }
                Ok(_) => {}
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Lagged(_)) => {
                    // Drain what is left, then check everything.
                    while events.try_recv().is_ok() {}
                    return Some(Changed::Unknown);
                }
                Err(TryRecvError::Closed) => {
                    self.events = None;
                    break;
                }
            }
        }
        (!subjects.is_empty()).then_some(Changed::Subjects(subjects))
    }

    /// Records a woken run; refuses past the cap.
    fn admit(&mut self, app: &str, now: i64) -> bool {
        let fires = self.fires.entry(app.to_string()).or_default();
        while fires.front().is_some_and(|at| now - at > RATE_WINDOW_MS) {
            fires.pop_front();
        }
        if fires.len() >= RATE_LIMIT {
            return false;
        }
        fires.push_back(now);
        true
    }
}

fn due(wake: &Wake, now: i64, debounce: i64) -> bool {
    now >= wake.last_at + debounce || now >= wake.first_at + DEBOUNCE_MAX_MS.max(debounce)
}

fn backoff(attempts: u32) -> i64 {
    let exp = attempts.saturating_sub(1).min(20);
    BACKOFF_BASE_MS
        .saturating_mul(1i64 << exp)
        .min(BACKOFF_CAP_MS)
}

/// Starts the worker's periodic work at server start: the index, the grant
/// backfill and the first sweep. Returns whether the hook is on.
pub async fn start(appstate: &AppState) -> bool {
    let enabled = appstate.config.opts.plugin_after_commit;
    let db = &appstate.store;
    if let Err(e) = rebuild_index(db, enabled) {
        tracing::warn!("afterCommit: could not build the subscription index: {e}");
    }
    if !enabled {
        return false;
    }
    match backfill_from_grants(db).await {
        Ok(0) => {}
        Ok(n) => tracing::info!("afterCommit: {n} subscription(s) backfilled from row grants"),
        Err(e) => tracing::warn!("afterCommit: grant backfill failed: {e}"),
    }
    true
}

/// One pass of the worker: sweep when due, then deliver what is due.
pub async fn tick(appstate: &AppState, worker: &Mutex<Worker>) {
    let now = atomic_lib::utils::now();
    let sweep_due = {
        let mut w = worker.lock().await;
        if now - w.last_sweep >= SWEEP_INTERVAL_MS {
            w.last_sweep = now;
            true
        } else {
            false
        }
    };
    if sweep_due {
        if let Err(e) = sweep(&appstate.store).await {
            tracing::warn!("afterCommit: sweep failed: {e}");
        }
    }
    let changed = worker.lock().await.changed(&appstate.store);
    if let Some(changed) = changed {
        if let Err(e) = end_affected(&appstate.store, changed).await {
            tracing::warn!("afterCommit: could not end finished subscriptions: {e}");
        }
    }
    drain_at(appstate, worker, now).await;
}

/// Delivers everything due at `now`. Returns how many runs it made.
pub async fn drain_at(appstate: &AppState, worker: &Mutex<Worker>, now: i64) -> usize {
    let db = &appstate.store;
    if !db.after_commit_enabled() {
        return 0;
    }
    let _lock = db.lock_plugin("after-commit-delivery").await;
    let subs = match all(db) {
        Ok(subs) => subs,
        Err(e) => {
            tracing::error!("afterCommit: cannot read subscriptions: {e}");
            return 0;
        }
    };
    let wakes: HashMap<String, Wake> = db
        .after_commit_wakes()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let mut runs = 0;
    for sub in subs.into_iter().filter(Subscription::is_live) {
        if runs >= 100 {
            break;
        }
        let existing = match delivery(db, &sub.id) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!("afterCommit: unreadable delivery for {}: {e}", sub.table);
                continue;
            }
        };
        let result = match existing {
            Some(d) => process(appstate, sub, d, now).await,
            None => {
                let Some(wake) = wakes.get(&sub.id) else {
                    continue;
                };
                let debounce = worker.lock().await.debounce_ms;
                if !due(wake, now, debounce) {
                    continue;
                }
                claim_and_process(appstate, worker, sub, now).await
            }
        };
        match result {
            Ok(true) => runs += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!("afterCommit: {e}"),
        }
    }
    runs
}

fn record_error(db: &Db, sub: &Subscription, error: &str) {
    let mut stored = find(db, &sub.drive, &sub.app, &sub.table)
        .ok()
        .flatten()
        .unwrap_or_else(|| sub.clone());
    stored.last_error = Some(error.to_string());
    if let Err(e) = save(db, &stored) {
        tracing::warn!("afterCommit: could not record a failure: {e}");
    }
}

/// Claims the subscription's marker and turns it into a delivery.
async fn claim_and_process(
    appstate: &AppState,
    worker: &Mutex<Worker>,
    mut sub: Subscription,
    now: i64,
) -> Result<bool, String> {
    let db = &appstate.store;
    if sub.stopped.is_some() {
        // A new source restarts it; otherwise markers keep coalescing.
        if !restart_if_updated(db, &mut sub).await? {
            return Ok(false);
        }
    }
    match eligibility(db, &sub).await {
        Ok(_) => {}
        Err(NotNow::Wait(_)) => return Ok(false),
        Err(NotNow::End(via)) => {
            end(db, sub, "server", via)?;
            return Ok(false);
        }
    }
    if !sub.continuation && !worker.lock().await.admit(&sub.app, now) {
        let reason = "stopped after 30 runs in a minute: its own writes keep waking it";
        sub.stopped = Some(Stopped {
            reason: reason.into(),
            at: now,
            attempts: 0,
            source_hash: None,
        });
        sub.last_error = Some(reason.into());
        save(db, &sub)?;
        return Ok(false);
    }
    db.claim_after_commit_wake(&sub.id)
        .map_err(|e| e.to_string())?;
    sub.continuation = false;

    let as_agent = ForAgent::AgentSubject(sub.activated_by.as_str().into());
    let table = Subject::from(sub.table.as_str());
    let head = || async { change_log::table_changes_head(db, &table, &as_agent).await };
    let reset = if sub.cursor.is_none() {
        Some("initial")
    } else if sub.resync {
        Some("requested")
    } else {
        None
    };
    let (changes, to, has_more, reset) = match reset {
        Some(reset) => match head().await {
            Ok(head) => (Vec::new(), head, false, Some(reset.to_string())),
            Err(e) => return host_failed(db, &sub, e),
        },
        None => match change_log::table_changes(
            db,
            &table,
            sub.cursor.as_deref(),
            Some(PAGE_SIZE),
            &as_agent,
        )
        .await
        {
            Ok(page) => (
                drop_echoes(db, &sub.id, page.changes)?,
                page.cursor,
                page.has_more,
                None,
            ),
            Err(ChangeListError::CursorExpired) => match head().await {
                Ok(head) => (Vec::new(), head, false, Some("expired".to_string())),
                Err(e) => return host_failed(db, &sub, e),
            },
            Err(e) => return host_failed(db, &sub, e),
        },
    };
    let delivery = Delivery {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        subscription: sub.id.clone(),
        from: sub.cursor.clone(),
        to,
        changes,
        has_more,
        reset,
        attempts: 0,
        next_attempt_at: 0,
        at: now,
        verdict: None,
        waiting_for_review: false,
        source_hash: None,
    };
    // Nothing for the plugin (only its own echoes): move on without a run.
    if delivery.reset.is_none() && delivery.changes.is_empty() {
        sub.resync = false;
        return acknowledge(db, sub, &delivery).map(|_| false);
    }
    save(db, &sub)?;
    save_delivery(db, &delivery)?;
    process(appstate, sub, delivery, now).await
}

/// The change list failed for a reason that is not the plugin's: put the
/// marker back and try again on a later pass, without counting an attempt.
fn host_failed(db: &Db, sub: &Subscription, e: ChangeListError) -> Result<bool, String> {
    db.wake_after_commit(&sub.id).map_err(|e| e.to_string())?;
    Err(format!("the change list of {} failed: {e}", sub.table))
}

/// Removes the entries that are the hook's own writes coming back.
fn drop_echoes(db: &Db, id: &str, changes: Vec<TableChange>) -> Result<Vec<TableChange>, String> {
    let mut kept = Vec::with_capacity(changes.len());
    for change in changes {
        let key = own_key(id, &change.subject);
        if let Some(own) = get_json::<OwnWrite>(db, &key)? {
            remove(db, &key)?;
            if change.version.as_ref() == Some(&own.after) {
                continue;
            }
        }
        kept.push(change);
    }
    Ok(kept)
}

async fn restart_if_updated(db: &Db, sub: &mut Subscription) -> Result<bool, String> {
    let Some(stopped) = &sub.stopped else {
        return Ok(true);
    };
    let Some(old) = &stopped.source_hash else {
        return Ok(false);
    };
    let Ok(package) = package_of(db, &sub.drive, &sub.app).await else {
        return Ok(false);
    };
    if &package.source_hash == old {
        return Ok(false);
    }
    sub.stopped = None;
    sub.last_error = None;
    if let Some(mut d) = delivery(db, &sub.id)? {
        d.attempts = 0;
        d.next_attempt_at = 0;
        save_delivery(db, &d)?;
    }
    save(db, sub)?;
    Ok(true)
}

/// Moves the cursor to the end of `delivery` and removes it, in one batch.
fn acknowledge(
    db: &Db,
    mut sub: Subscription,
    delivery: &Delivery,
) -> Result<Subscription, String> {
    sub.cursor = Some(delivery.to.clone());
    sub.pending = None;
    sub.last_error = None;
    sub.stopped = None;
    sub.last_delivered_at = Some(atomic_lib::utils::now());
    sub.continuation = delivery.has_more;
    let ops = vec![
        Operation {
            tree: Tree::PluginMeta,
            method: Method::Insert,
            key: key_of(&sub).into_bytes(),
            val: Some(serde_json::to_vec(&sub).map_err(|e| e.to_string())?),
        },
        Operation {
            tree: Tree::PluginMeta,
            method: Method::Delete,
            key: delivery_key(&sub.id).into_bytes(),
            val: None,
        },
    ];
    db.kv.apply_batch(&ops).map_err(|e| e.to_string())?;
    db.flush().map_err(|e| e.to_string())?;
    if delivery.has_more {
        db.wake_after_commit(&sub.id).map_err(|e| e.to_string())?;
    }
    Ok(sub)
}

fn journal(db: &Db, sub: &Subscription, delivery: &Delivery) -> super::journal::Journal {
    super::journal::Journal::new(
        db,
        &sub.drive,
        &sub.app,
        &format!("after-commit:{}", delivery.id),
    )
}

/// Runs (or finishes) one delivery. `Ok(true)` when the plugin ran.
async fn process(
    appstate: &AppState,
    mut sub: Subscription,
    mut delivery: Delivery,
    now: i64,
) -> Result<bool, String> {
    let db = &appstate.store;
    // Finished before a crash, not yet acknowledged: acknowledge only.
    if journal(db, &sub, &delivery).terminal()?.is_some() {
        acknowledge(db, sub, &delivery)?;
        return Ok(false);
    }
    if delivery.waiting_for_review {
        // A proposal made by the app's previous source is not what the app
        // would do now: drop it and run the page again (#1907).
        discard_if_stale(db, &mut sub, &mut delivery).await?;
        return Ok(false);
    }
    if sub.stopped.is_some() && !restart_if_updated(db, &mut sub).await? {
        return Ok(false);
    }
    if delivery.next_attempt_at > now {
        return Ok(false);
    }
    let eligible = match eligibility(db, &sub).await {
        Ok(e) => e,
        Err(NotNow::Wait(_)) => return Ok(false),
        Err(NotNow::End(via)) => {
            end(db, sub, "server", via)?;
            return Ok(false);
        }
    };
    match run(appstate, &sub, &mut delivery, &eligible).await {
        Ok(Outcome::Done { resync }) => {
            sub.resync = resync;
            acknowledge(db, sub, &delivery)?;
        }
        Ok(Outcome::Held(pending)) => {
            delivery.waiting_for_review = true;
            delivery.source_hash = Some(eligible.package.source_hash.clone());
            save_delivery(db, &delivery)?;
            sub.pending = Some(pending);
            sub.last_error = None;
            save(db, &sub)?;
        }
        Err(Failure::Host(e)) => {
            delivery.next_attempt_at = now + BACKOFF_BASE_MS;
            save_delivery(db, &delivery)?;
            record_error(db, &sub, &e);
        }
        Err(Failure::Plugin(e)) => {
            delivery.attempts += 1;
            delivery.next_attempt_at = now + backoff(delivery.attempts);
            save_delivery(db, &delivery)?;
            sub.last_error = Some(e.clone());
            if delivery.attempts >= MAX_ATTEMPTS {
                sub.stopped = Some(Stopped {
                    reason: e,
                    at: now,
                    attempts: delivery.attempts,
                    source_hash: Some(eligible.package.source_hash.clone()),
                });
            }
            save(db, &sub)?;
        }
    }
    Ok(true)
}

enum Outcome {
    Done { resync: bool },
    Held(Pending),
}

enum Failure {
    /// Not the plugin's fault: retried without counting.
    Host(String),
    /// The plugin threw, trapped, timed out or proposed something broken.
    Plugin(String),
}

async fn live_grant(db: &Db, sub: &Subscription) -> Option<RowGrant> {
    app_row_grant::live(db, &sub.drive, &sub.table, &sub.app)
        .await
        .ok()
        .flatten()
}

fn event_json(
    sub: &Subscription,
    delivery: &Delivery,
    row_class: &str,
    grant: Option<&RowGrant>,
) -> Json {
    json!({
        "drive": sub.drive,
        "installation": sub.installation,
        "app": sub.app,
        "table": sub.table,
        "rowClass": row_class,
        "view": sub.view,
        "grant": match grant {
            Some(g) => json!({"status": "granted", "grantedBy": g.granted_by, "grantedAt": g.granted_at}),
            None => json!({"status": "none"}),
        },
        "reset": delivery.reset,
        "changes": delivery.changes,
        "hasMore": delivery.has_more,
        "attempt": delivery.attempts + 1,
    })
}

async fn run(
    appstate: &AppState,
    sub: &Subscription,
    delivery: &mut Delivery,
    eligible: &Eligible,
) -> Result<Outcome, Failure> {
    let db = &appstate.store;
    let grant = live_grant(db, sub).await;
    let schemas = match &eligible.package.installation {
        Some(_) => Default::default(),
        None => super::scheduler::plugin_schema_bindings(db, &sub.drive, &sub.app)
            .await
            .unwrap_or_default(),
    };
    let input = json!({
        "trigger": {"kind": "afterCommit", "id": delivery.id, "at": delivery.at},
        "entry": "afterCommit",
        "event": event_json(sub, delivery, &eligible.row_class, grant.as_ref()),
        "schemas": schemas,
    })
    .to_string();

    let inner = StoreHost {
        db: Arc::new(db.clone()),
        plugin: sub.app.clone(),
        drive: sub.drive.clone(),
        for_agent: ForAgent::AgentSubject(sub.activated_by.as_str().into()),
        manifest: Some(eligible.package.manifest.clone()),
    };
    inner.validate_binding().await.map_err(Failure::Host)?;
    let host = HookHost {
        inner,
        scope: ReadScope::new(db, sub, &eligible.row_class, grant.as_ref()).await,
        table: sub.table.clone(),
        activated_by: sub.activated_by.clone(),
    };
    let runtime = js_runtime::embedded_runtime().map_err(|e| Failure::Host(e.to_string()))?;
    let verdict = match tokio::time::timeout(
        RUN_TIMEOUT,
        runtime.run_triggered(&eligible.package.source, &input, host),
    )
    .await
    {
        Err(_) => {
            return Err(Failure::Plugin(
                "afterCommit() took longer than 60 s".into(),
            ))
        }
        Ok(Err(e)) => return Err(Failure::Host(e.to_string())),
        Ok(Ok(Err(thrown))) => return Err(Failure::Plugin(thrown)),
        Ok(Ok(Ok(verdict))) => verdict,
    };
    delivery.verdict = Some(verdict.clone());
    let parsed: Json = serde_json::from_str(&verdict).map_err(|e| {
        Failure::Plugin(format!(
            "afterCommit() returned something that is not JSON: {e}"
        ))
    })?;
    let resync = parsed
        .get("resync")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let has_intents = parsed
        .get("intents")
        .and_then(Json::as_array)
        .is_some_and(|i| !i.is_empty());
    if !has_intents {
        return Ok(Outcome::Done { resync });
    }

    let mut host = HookApplyHost::new(
        db,
        sub,
        grant.clone().map(|g| Mode::Grant(Box::new(g))),
        sub.activated_by.as_str(),
    )
    .await
    .map_err(Failure::Host)?;
    let plan = plan_verdict(&parsed, &mut host).await;
    if plan.blocked {
        let problems: Vec<String> = plan
            .problems
            .iter()
            .chain(plan.changes.iter().flat_map(|c| c.problems.iter()))
            .map(|p| p.message.clone())
            .collect();
        return Err(Failure::Plugin(format!(
            "afterCommit() proposed changes that cannot be applied: {}",
            problems.join("; ")
        )));
    }
    let mut unattended = true;
    for change in &plan.changes {
        if !host.allowed_unattended(change).await {
            unattended = false;
            break;
        }
    }
    if !unattended {
        return Ok(Outcome::Held(pending_of(db, sub, &plan).await));
    }
    apply_recorded(db, sub, delivery, &mut host, &plan)
        .await
        .map_err(Failure::Plugin)?;
    Ok(Outcome::Done { resync })
}

/// Applies `plan` through the delivery's journal, records the hook's own
/// writes and the run, and finishes the journal.
async fn apply_recorded(
    db: &Db,
    sub: &Subscription,
    delivery: &Delivery,
    host: &mut HookApplyHost,
    plan: &RunPlan,
) -> Result<ApplyReport, String> {
    let journal = journal(db, sub, delivery);
    let plan = journal.plan(plan)?;
    let before: HashMap<String, Option<VersionMap>> = plan
        .changes
        .iter()
        .filter(|c| c.op != Op::Create)
        .map(|c| (c.subject.clone(), db.stored_loro_version(&c.subject)))
        .collect();
    let report =
        apply::apply_plan_recorded(&plan, host, ApplyOptions::default(), Some(&journal)).await?;
    record_own_writes(db, sub, delivery, &before, &report).await?;
    let summary = format!(
        "applied {} change(s), {} failed",
        report.applied, report.failed
    );
    if let Some(terms) = super::scheduler::drive_terms(db, &sub.drive).await {
        if terms.class("plugin-run").is_some() {
            if let Err(e) = super::run_log::record_run(
                host,
                &terms,
                &sub.app,
                "afterCommit",
                delivery.at,
                &plan,
                Some(&report),
            )
            .await
            {
                tracing::warn!("afterCommit: the run could not be recorded: {e}");
            }
        }
    }
    if report.failed > 0 || report.stopped_early {
        return Err(summary);
    }
    journal.finish(&summary)?;
    Ok(report)
}

/// Remembers rows the hook wrote whose previous version it had been given,
/// so the next page does not hand the write back to it (dedupe by version,
/// not by signer: a person's edit in the plugin's own view is also signed
/// by the app agent, and must still reach the hook).
async fn record_own_writes(
    db: &Db,
    sub: &Subscription,
    delivery: &Delivery,
    before: &HashMap<String, Option<VersionMap>>,
    report: &ApplyReport,
) -> Result<(), String> {
    let table = pure(&sub.table);
    for outcome in &report.outcomes {
        if outcome.status != ChangeStatus::Applied {
            continue;
        }
        let row = db.change_list_table_key(&outcome.subject);
        let Ok(resource) = db.get_resource(&Subject::from(row.as_str())).await else {
            continue;
        };
        if app_row_grant::parent_of(&resource).as_deref() != Some(table.as_str()) {
            continue;
        }
        let Some(after) = db.stored_loro_version(&row) else {
            continue;
        };
        let was = before.get(&outcome.planned).cloned().flatten();
        let delivered = match &was {
            None => true,
            Some(v) => delivery
                .changes
                .iter()
                .any(|c| c.subject == row && c.version.as_ref() == Some(v)),
        };
        if !delivered {
            continue;
        }
        put_json(
            db,
            &own_key(&sub.id, &row),
            &OwnWrite {
                before: was,
                after,
                run: delivery.id.clone(),
                at: atomic_lib::utils::now(),
            },
        )?;
    }
    Ok(())
}

async fn pending_of(db: &Db, sub: &Subscription, plan: &RunPlan) -> Pending {
    let mut subjects: Vec<String> = Vec::new();
    for change in &plan.changes {
        if !subjects.contains(&change.subject) {
            subjects.push(change.subject.clone());
        }
    }
    // Could a row grant cover all of it? Then "Allow all" is offered.
    let hypothetical = RowGrant {
        id: String::new(),
        drive: sub.drive.clone(),
        app: sub.app.clone(),
        app_agent: String::new(),
        table: sub.table.clone(),
        view: sub.view.clone(),
        granted_by: sub.activated_by.clone(),
        granted_at: 0,
        via: app_row_grant::VIA_HOOK_REVIEW.into(),
        extras: app_row_grant::checked_extras(db, &sub.drive, &sub.app)
            .await
            .unwrap_or_default(),
        revoked_at: None,
        revoked_by: None,
        revoked_via: None,
    };
    let mut in_scope = true;
    if let Ok(host) = HookApplyHost::new(
        db,
        sub,
        Some(Mode::Grant(Box::new(hypothetical))),
        &sub.activated_by,
    )
    .await
    {
        for change in &plan.changes {
            if !host.allowed_unattended(change).await {
                in_scope = false;
                break;
            }
        }
    } else {
        in_scope = false;
    }
    Pending {
        rows: subjects.len(),
        subjects: subjects.into_iter().take(20).collect(),
        in_scope,
        at: atomic_lib::utils::now(),
    }
}

// ------------------------------------------------------------ review

/// An answer to a proposal waiting on a table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// Apply this proposal once.
    Apply,
    /// "Allow all edits by this view on this table": grant, then apply.
    AllowAll,
    Decline,
}

/// Answers the proposal waiting on `table` for `app`, as `reviewer`.
pub async fn review(
    db: &Db,
    drive: &str,
    table: &str,
    app: &str,
    answer: Answer,
    reviewer: &str,
) -> Result<Subscription, String> {
    let _lock = db.lock_plugin("after-commit-delivery").await;
    let sub = find(db, drive, app, table)?
        .filter(Subscription::is_live)
        .ok_or("This app does not follow this table")?;
    let mut delivery = delivery(db, &sub.id)?
        .filter(|d| d.waiting_for_review)
        .ok_or("Nothing is waiting for review on this table")?;
    if !app_row_grant::may_write(db, table, reviewer).await {
        return Err("Only someone who can edit this table can answer this".into());
    }
    let mut sub = sub;
    if discard_if_stale(db, &mut sub, &mut delivery).await? {
        return Err(
            "The app was updated since it proposed this, so the proposal was dropped. It will propose again with its new version."
                .into(),
        );
    }
    let journal = journal(db, &sub, &delivery);
    match answer {
        Answer::Decline => {
            journal.abandon(reviewer, "Declined on the table's tab")?;
        }
        Answer::Apply | Answer::AllowAll => {
            let mode = if answer == Answer::AllowAll {
                if !sub.pending.as_ref().is_some_and(|p| p.in_scope) {
                    return Err("This proposal reaches beyond the table's rows, so it can only be applied once".into());
                }
                Mode::Grant(Box::new(
                    app_row_grant::grant(
                        db,
                        drive,
                        table,
                        app,
                        &sub.view,
                        reviewer,
                        app_row_grant::VIA_HOOK_REVIEW,
                    )
                    .await?,
                ))
            } else {
                Mode::Reviewed
            };
            let verdict = delivery.verdict.clone().ok_or("The proposal is missing")?;
            let parsed: Json = serde_json::from_str(&verdict).map_err(|e| e.to_string())?;
            let mut host = HookApplyHost::new(db, &sub, Some(mode), reviewer).await?;
            let plan = plan_verdict(&parsed, &mut host).await;
            if plan.blocked {
                return Err("The proposal no longer applies; decline it".into());
            }
            apply_recorded(db, &sub, &delivery, &mut host, &plan).await?;
        }
    }
    delivery.waiting_for_review = false;
    acknowledge(db, sub, &delivery)
}

/// Drops the proposal waiting in `delivery` when the app's source changed
/// since it was made: the journal records why, and the same page is run
/// again, as a new delivery, on the new source. `Ok(true)` when it did.
async fn discard_if_stale(
    db: &Db,
    sub: &mut Subscription,
    delivery: &mut Delivery,
) -> Result<bool, String> {
    let Some(proposed_by) = &delivery.source_hash else {
        return Ok(false);
    };
    let Ok(package) = package_of(db, &sub.drive, &sub.app).await else {
        // No source to compare with (paused, gone): the end checks decide.
        return Ok(false);
    };
    if &package.source_hash == proposed_by {
        return Ok(false);
    }
    journal(db, sub, delivery).abandon(
        "server",
        "The app's source changed while this proposal waited for review",
    )?;
    // A fresh id: the abandoned journal belongs to the old one.
    delivery.id = ulid::Ulid::new().to_string().to_lowercase();
    delivery.waiting_for_review = false;
    delivery.verdict = None;
    delivery.source_hash = None;
    delivery.attempts = 0;
    delivery.next_attempt_at = 0;
    save_delivery(db, delivery)?;
    sub.pending = None;
    save(db, sub)?;
    Ok(true)
}

/// Retry after the table's delivery stopped, or right away after a failure.
pub fn retry(db: &Db, drive: &str, table: &str, app: &str) -> Result<Subscription, String> {
    let mut sub = find(db, drive, app, table)?
        .filter(Subscription::is_live)
        .ok_or("This app does not follow this table")?;
    sub.stopped = None;
    sub.last_error = None;
    if let Some(mut d) = delivery(db, &sub.id)? {
        d.attempts = 0;
        d.next_attempt_at = 0;
        save_delivery(db, &d)?;
    } else {
        db.wake_after_commit(&sub.id).map_err(|e| e.to_string())?;
        // A retry is a person's action, not a change: don't count it.
        sub.continuation = true;
    }
    save(db, &sub)?;
    Ok(sub)
}

/// What the tab and the Installation page show about one subscription.
pub fn status_json(db: &Db, sub: &Subscription) -> Json {
    let d = delivery(db, &sub.id).ok().flatten();
    json!({
        "table": sub.table,
        "view": sub.view,
        "app": sub.app,
        "installation": sub.installation,
        "via": sub.via,
        "activatedBy": sub.activated_by,
        "activatedAt": sub.activated_at,
        "lastDeliveredAt": sub.last_delivered_at,
        "lastError": sub.last_error,
        "stopped": sub.stopped,
        "pending": sub.pending,
        "attempts": d.as_ref().map(|d| d.attempts).unwrap_or(0),
        "waiting": db.after_commit_wake(&sub.id).ok().flatten().is_some() || d.is_some(),
    })
}

// -------------------------------------------------- the run's hosts

/// What one run may read: the table, its rows, the row class and its
/// properties (plus the app's declared extras), and the app's own subtree.
struct ReadScope {
    db: Db,
    table: String,
    app: String,
    allowed: HashSet<String>,
}

impl ReadScope {
    async fn new(db: &Db, sub: &Subscription, row_class: &str, grant: Option<&RowGrant>) -> Self {
        let mut allowed: HashSet<String> = HashSet::from([pure(&sub.table), pure(row_class)]);
        if let Ok(class) = db.get_class(row_class).await {
            allowed.extend(
                class
                    .requires
                    .iter()
                    .chain(class.recommends.iter())
                    .map(|p| pure(p)),
            );
        }
        allowed.extend(app_row_grant::declared_extras(db, &sub.drive, &sub.app).await);
        if let Some(g) = grant {
            allowed.extend(g.extras.iter().cloned());
        }
        Self {
            db: db.clone(),
            table: pure(&sub.table),
            app: pure(&sub.app),
            allowed,
        }
    }

    async fn permits(&self, subject: &str) -> bool {
        let id = pure(subject);
        if self.allowed.contains(&id) {
            return true;
        }
        let Ok(mut current) = self.db.get_resource(&subject.into()).await else {
            return false;
        };
        // A row of the table.
        if app_row_grant::parent_of(&current).as_deref() == Some(self.table.as_str()) {
            return true;
        }
        // Or anything in the app's own subtree.
        for _ in 0..64 {
            if current.get_subject().pure_id() == self.app {
                return true;
            }
            match current.get_parent(&self.db).await {
                Ok(parent) => current = parent,
                Err(_) => return false,
            }
        }
        false
    }
}

/// The run's host: the ordinary JS plugin host, with reads limited to the
/// event's scope and `ctx.changes` for the event's table.
struct HookHost {
    inner: StoreHost,
    scope: ReadScope,
    table: String,
    activated_by: String,
}

#[derive(Deserialize)]
struct ChangesRequest {
    table: String,
    #[serde(default)]
    since: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[async_trait::async_trait]
impl PluginHost for HookHost {
    async fn invoke_action(
        &mut self,
        request: String,
        source_hash: &str,
        allow_automatic: bool,
        consumer: Option<&str>,
    ) -> Result<String, String> {
        self.inner
            .invoke_action(request, source_hash, allow_automatic, consumer)
            .await
    }
    async fn fetch(&mut self, request: String) -> Result<String, String> {
        self.inner.fetch(request).await
    }
    async fn get_resource(&mut self, subject: String) -> Result<String, String> {
        if !self.scope.permits(&subject).await {
            return Err(format!(
                "afterCommit reads only its table, its rows and the app's own data, not {subject}"
            ));
        }
        self.inner.get_resource(subject).await
    }
    async fn query(&mut self, property: String, value: String) -> Result<String, String> {
        let found: Vec<String> = serde_json::from_str(&self.inner.query(property, value).await?)
            .map_err(|e| e.to_string())?;
        let mut kept = Vec::new();
        for subject in found {
            if self.scope.permits(&subject).await {
                kept.push(subject);
            }
        }
        serde_json::to_string(&kept).map_err(|e| e.to_string())
    }
    async fn resource_grants(&mut self) -> ResourceGrants {
        self.inner.resource_grants().await
    }
    async fn run_context(&mut self) -> serde_json::Map<String, Json> {
        self.inner.run_context().await
    }
    async fn host_call(&mut self, name: String, request: String) -> Result<String, String> {
        if name != "changes" {
            return Err(format!("`{name}` is not available to afterCommit"));
        }
        let request: ChangesRequest =
            serde_json::from_str(&request).map_err(|e| format!("ctx.changes: {e}"))?;
        if pure(&request.table) != self.table {
            return Err("ctx.changes reads only the table this event is about".into());
        }
        match change_log::table_changes(
            &self.inner.db,
            &Subject::from(self.table.as_str()),
            request.since.as_deref(),
            request.limit,
            &ForAgent::AgentSubject(self.activated_by.as_str().into()),
        )
        .await
        {
            Ok(page) => serde_json::to_string(&page).map_err(|e| e.to_string()),
            Err(ChangeListError::CursorExpired) => {
                Ok(json!({"error": "CURSOR_EXPIRED"}).to_string())
            }
            Err(e) => Err(e.to_string()),
        }
    }
}

enum Mode {
    /// Under a live row grant: in-scope row writes apply unattended.
    Grant(Box<RowGrant>),
    /// A person reviewed this proposal and applied it once.
    Reviewed,
}

/// Applies a hook's writes: the app's own subtree under its own rights,
/// rows of the table under the grant (or the reviewer's once-only answer),
/// always signed by the app agent and bounded by the person's rights.
struct HookApplyHost {
    inner: StoreApplyHost,
    db: Db,
    app_agent: String,
    mode: Option<Mode>,
    /// The followed table (pure id).
    table: String,
}

impl HookApplyHost {
    async fn new(
        db: &Db,
        sub: &Subscription,
        mode: Option<Mode>,
        person: &str,
    ) -> Result<Self, String> {
        let inner = StoreApplyHost::for_installation(
            db,
            &sub.drive,
            &sub.app,
            ForAgent::AgentSubject(person.into()),
        )
        .await?;
        let app_agent = inner
            .signing_as
            .as_ref()
            .and_then(|key| db.get_app_agent_info(key).ok().flatten())
            .map(|info| info.agent)
            .ok_or("this app has no key of its own")?;
        Ok(Self {
            inner,
            db: db.clone(),
            app_agent,
            mode,
            table: pure(&sub.table),
        })
    }

    async fn app_may_write(&self, subject: &str) -> bool {
        let Ok(resource) = self.db.get_resource(&subject.into()).await else {
            return false;
        };
        check_write(
            &self.db,
            &resource,
            &ForAgent::AgentSubject(self.app_agent.as_str().into()),
        )
        .await
        .is_ok()
    }

    /// Whether `change` may apply with nobody watching.
    async fn allowed_unattended(&self, change: &PlannedChange) -> bool {
        let target = match change.op {
            Op::Create => change.parent.clone().unwrap_or_default(),
            _ => change.subject.clone(),
        };
        if self.app_may_write(&target).await {
            return true;
        }
        let Some(Mode::Grant(grant)) = &self.mode else {
            return false;
        };
        let properties: Vec<&str> = change
            .properties
            .iter()
            .map(|p| p.property.as_str())
            .collect();
        let write = match change.op {
            Op::Create => RowWrite::Create {
                parent: &target,
                is_a: &change.is_a,
                properties,
            },
            Op::Destroy => RowWrite::Destroy { subject: &target },
            Op::Set | Op::Remove => RowWrite::Set {
                subject: &target,
                properties,
            },
        };
        app_row_grant::check_scope(&self.db, grant, &write)
            .await
            .is_ok()
    }

    async fn row_write(&self, write: RowWrite<'_>) -> Result<(), String> {
        match &self.mode {
            Some(Mode::Grant(grant)) => app_row_grant::check_scope(&self.db, grant, &write).await,
            Some(Mode::Reviewed) => match write {
                RowWrite::Destroy { .. } => {
                    Err("A reviewed proposal cannot delete rows the app does not own".into())
                }
                _ => Ok(()),
            },
            None => Err("This write needs someone to review it".into()),
        }
    }
}

#[async_trait::async_trait]
impl PlanHost for HookApplyHost {
    fn create_subject(&mut self, parent: &str) -> String {
        self.inner.create_subject(parent)
    }
    async fn get_property(&mut self, subject: &str) -> Option<(String, String)> {
        self.inner.get_property(subject).await
    }
    async fn read_resource(&mut self, subject: &str) -> Option<HashMap<String, Json>> {
        if let Some(found) = self.inner.read_resource(subject).await {
            return Some(found);
        }
        // A row of the followed table: the app's own rights do not reach it
        // (that is what the grant or the review is for), the person's do.
        let resource = self.db.get_resource(&subject.into()).await.ok()?;
        if app_row_grant::parent_of(&resource).as_deref() != Some(self.table.as_str()) {
            return None;
        }
        atomic_lib::hierarchy::check_read(&self.db, &resource, &self.inner.for_agent)
            .await
            .ok()?;
        let json = resource.to_json_ad(None).ok()?;
        let mut map: HashMap<String, Json> = serde_json::from_str(&json).ok()?;
        map.remove("@id");
        Some(map)
    }
}

#[async_trait::async_trait]
impl ApplyHost for HookApplyHost {
    async fn create(&mut self, request: CreateRequest) -> Result<String, String> {
        if self.app_may_write(&request.parent).await {
            return self.inner.create(request).await;
        }
        let properties: Vec<&str> = request.prop_vals.keys().map(String::as_str).collect();
        self.row_write(RowWrite::Create {
            parent: &request.parent,
            is_a: &request.is_a,
            properties,
        })
        .await?;
        self.inner.create_under_row_grant(request).await
    }

    async fn set(&mut self, subject: &str, prop_vals: HashMap<String, Json>) -> Result<(), String> {
        if self.app_may_write(subject).await {
            return self.inner.set(subject, prop_vals).await;
        }
        let properties: Vec<&str> = prop_vals.keys().map(String::as_str).collect();
        self.row_write(RowWrite::Set {
            subject,
            properties,
        })
        .await?;
        self.inner.set_under_row_grant(subject, prop_vals).await
    }

    async fn remove(&mut self, subject: &str, properties: Vec<String>) -> Result<(), String> {
        if self.app_may_write(subject).await {
            return self.inner.remove(subject, properties).await;
        }
        let names: Vec<&str> = properties.iter().map(String::as_str).collect();
        self.row_write(RowWrite::Set {
            subject,
            properties: names,
        })
        .await?;
        self.inner.remove_under_row_grant(subject, properties).await
    }

    async fn destroy(&mut self, subject: &str) -> Result<(), String> {
        if self.app_may_write(subject).await {
            return self.inner.destroy(subject).await;
        }
        self.row_write(RowWrite::Destroy { subject }).await?;
        Err("Letting an app edit rows does not let it delete them".into())
    }
}

#[cfg(test)]
#[path = "after_commit_test.rs"]
mod tests;
