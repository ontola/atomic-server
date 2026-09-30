//! The durable `afterCommit` hook (#1851) against a real store, with a
//! fixture JS plugin installed from a release and shown as a table's view.
//!
//! The fixture plugin logs every delivery it gets as a resource under its own
//! Installation (its name is the JSON of what it saw), which is how these
//! tests observe what was delivered. What else it does is switched by a JSON
//! object in the Installation's description, which it reads each run.

use std::cell::Cell;

use atomic_lib::{
    agents::Agent,
    db::app_agent::{AppAgent, AppAgentKey},
    Resource,
};

use super::*;
use crate::plugins::app_row_grant::{TABLE_VIEWS, VIEW_CLASS, VIEW_KIND};
use crate::plugins::test_fixture::{
    fixture_with_args, genesis, install_release, js_release_with_source, Fixture,
};

const SOURCE: &str = r#"
export const manifest = {
  schemaVersion: 2,
  world: 'extension',
  entrypoints: { run: true, afterCommit: true },
};
export function run() { return { intents: [] }; }
const NAME = 'https://atomicdata.dev/properties/name';
const DESC = 'https://atomicdata.dev/properties/description';
const PARENT = 'https://atomicdata.dev/properties/parent';
export async function afterCommit(ctx) {
  const e = ctx.event;
  const me = ctx.read(e.app);
  const cfg = JSON.parse(me[DESC] || '{}');
  if (cfg.throwAlways || (cfg.throwOnFirst && e.attempt === 1)) {
    throw new Error('boom on attempt ' + e.attempt);
  }
  let other = null;
  if (cfg.readOther) {
    try { ctx.changes(cfg.readOther, {}); other = 'allowed'; }
    catch (err) { other = String(err && err.message ? err.message : err); }
  }
  let own = null;
  if (cfg.readOwn) {
    const page = ctx.changes(e.table, {});
    own = page.changes ? page.changes.length : page.error;
  }
  const intents = [{
    op: 'create', localId: 'log', parent: e.app, isA: [],
    set: { [NAME]: JSON.stringify({
      at: Date.now(), reset: e.reset, hasMore: e.hasMore, attempt: e.attempt,
      grant: e.grant.status, other, own,
      changes: e.changes.map(c => [c.subject, c.kind, !!c.version]),
    }) },
  }];
  for (const c of e.changes) {
    if (c.kind === 'deleted') continue;
    if (cfg.writeRows) intents.push({ op: 'set', subject: c.subject, set: { [DESC]: 'seen by the hook' } });
    if (cfg.writeParent) intents.push({ op: 'set', subject: c.subject, set: { [PARENT]: e.app } });
  }
  return { intents, resync: !!cfg.resync };
}
"#;

fn manifest() -> Json {
    json!({"schemaVersion": 2, "world": "extension",
           "namespace": "test", "name": "sync-app",
           "entrypoints": {"run": true, "afterCommit": true}})
}

struct T {
    f: Fixture,
    app: String,
    app_agent: String,
    class: String,
    table: String,
    view: String,
    worker: Mutex<Worker>,
    now: Cell<i64>,
}

impl T {
    fn db(&self) -> &Db {
        &self.f.appstate.store
    }

    fn me(&self) -> String {
        self.db().get_default_agent().unwrap().subject.to_string()
    }

    /// One worker pass, an hour after the previous one: past any debounce
    /// and backoff, and outside the loop cap's window.
    async fn drain(&self) -> usize {
        self.now.set(self.now.get() + 3_600_000);
        drain_at(&self.f.appstate, &self.worker, self.now.get()).await
    }

    fn sub(&self) -> Subscription {
        find(self.db(), &self.f.drive, &self.app, &self.table)
            .unwrap()
            .unwrap()
    }

    async fn configure(&self, cfg: Json) {
        let mut app = self
            .db()
            .get_resource(&self.app.as_str().into())
            .await
            .unwrap();
        app.set_unsafe(urls::DESCRIPTION.into(), Value::Markdown(cfg.to_string()))
            .unwrap();
        app.save(self.db()).await.unwrap();
    }

    async fn row(&self, name: &str) -> String {
        genesis(
            self.db(),
            vec![
                (
                    urls::IS_A,
                    Value::ResourceArray(vec![self.class.as_str().into()]),
                ),
                (urls::PARENT, Value::AtomicUrl(self.table.as_str().into())),
                (urls::NAME, Value::String(name.into())),
            ],
        )
        .await
    }

    async fn rename(&self, row: &str, name: &str) {
        let mut r = self.db().get_resource(&row.into()).await.unwrap();
        r.set_unsafe(urls::NAME.into(), Value::String(name.into()))
            .unwrap();
        r.save(self.db()).await.unwrap();
    }

    async fn get(&self, row: &str, property: &str) -> Option<String> {
        self.db()
            .get_resource(&row.into())
            .await
            .unwrap()
            .get(property)
            .ok()
            .map(|v| v.to_string())
    }

    /// Every delivery the plugin logged, oldest first.
    async fn logs(&self) -> Vec<Json> {
        let app = self
            .db()
            .get_resource(&self.app.as_str().into())
            .await
            .unwrap();
        let mut logs: Vec<Json> = app
            .get_children(self.db())
            .await
            .unwrap()
            .iter()
            .filter_map(|c| c.get(urls::NAME).ok().map(|v| v.to_string()))
            .filter(|name| name.starts_with('{'))
            .map(|name| serde_json::from_str(&name).unwrap())
            .collect();
        logs.sort_by_key(|l| l["at"].as_i64());
        logs
    }

    async fn grant(&self) -> RowGrant {
        app_row_grant::grant(
            self.db(),
            &self.f.drive,
            &self.table,
            &self.app,
            &self.view,
            &self.me(),
            app_row_grant::VIA_ADD_VIEW,
        )
        .await
        .unwrap()
    }
}

fn changed(log: &Json) -> Vec<(String, String)> {
    log["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c[0].as_str().unwrap().to_string(),
                c[1].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

/// A drive with the fixture plugin installed and shown as a view of a table
/// with one row. With `flag`, the server runs with `--plugin-after-commit`
/// and the view's gesture subscribed it; the initial delivery has run.
async fn setup(name: &str, flag: bool) -> (T, String) {
    let args: &[&str] = if flag {
        &["--plugin-after-commit"]
    } else {
        &[]
    };
    let f = fixture_with_args(name, args).await;
    let store = f.appstate.store.clone();
    let app = install_release(&f, &js_release_with_source(SOURCE, manifest()))
        .await
        .unwrap();

    // The Installation's own key, which may write its own subtree.
    let agent = Agent::new(Some("sync app")).unwrap();
    let mut app_resource = store.get_resource(&app.as_str().into()).await.unwrap();
    app_resource
        .push(urls::WRITE, agent.subject.to_string().into(), true)
        .unwrap();
    app_resource.save(&store).await.unwrap();
    store
        .set_app_agent(
            &AppAgentKey::new(&f.drive, &app),
            &AppAgent::new(agent.subject.to_string(), agent.build_secret().unwrap(), 0),
        )
        .unwrap();

    let class = genesis(
        &store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::CLASS.into()])),
            (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
            (urls::SHORTNAME, Value::Slug("task".into())),
            (urls::DESCRIPTION, Value::Markdown("A task".into())),
            (
                urls::RECOMMENDS,
                Value::ResourceArray(vec![urls::NAME.into(), urls::DESCRIPTION.into()]),
            ),
        ],
    )
    .await;
    let table = genesis(
        &store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::TABLE.into()])),
            (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
            (urls::NAME, Value::String("Tasks".into())),
            (
                urls::CLASSTYPE_PROP,
                Value::AtomicUrl(class.as_str().into()),
            ),
        ],
    )
    .await;
    let view = genesis(
        &store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![VIEW_CLASS.into()])),
            (urls::PARENT, Value::AtomicUrl(table.as_str().into())),
            (urls::NAME, Value::String("Sync".into())),
            (VIEW_KIND, Value::String(app.clone())),
        ],
    )
    .await;
    let mut table_resource = store.get_resource(&table.as_str().into()).await.unwrap();
    table_resource
        .set_unsafe(
            TABLE_VIEWS.into(),
            Value::ResourceArray(vec![view.as_str().into()]),
        )
        .unwrap();
    table_resource.save(&store).await.unwrap();

    let t = T {
        app,
        app_agent: agent.subject.to_string(),
        class,
        table,
        view,
        worker: Mutex::new(Worker {
            debounce_ms: 0,
            ..Default::default()
        }),
        now: Cell::new(atomic_lib::utils::now()),
        f,
    };
    let row = t.row("First").await;
    if flag {
        let sub = follow(
            t.db(),
            &t.f.drive,
            &t.table,
            &t.app,
            &t.view,
            &t.me(),
            app_row_grant::VIA_ADD_VIEW,
        )
        .await
        .unwrap()
        .expect("the hook is on and the plugin exports it");
        assert_eq!(sub.cursor, None);
        assert_eq!(t.drain().await, 1, "the initial delivery runs");
    }
    (t, row)
}

#[actix_rt::test]
async fn a_new_subscription_starts_at_the_head_and_then_gets_each_change() {
    let (t, row) = setup("ac_delivery", true).await;
    let logs = t.logs().await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0]["reset"], "initial");
    assert!(
        changed(&logs[0]).is_empty(),
        "existing rows are not replayed"
    );
    assert_eq!(logs[0]["grant"], "none");
    assert!(t.sub().cursor.is_some());

    t.rename(&row, "Renamed").await;
    let added = t.row("Second").await;
    assert_eq!(t.drain().await, 1, "two commits, one run");
    let logs = t.logs().await;
    assert_eq!(logs.len(), 2);
    assert_eq!(logs[1]["reset"], Json::Null);
    let mut got = changed(&logs[1]);
    got.sort();
    let mut want = vec![
        (t.db().change_list_table_key(&row), "updated".to_string()),
        (t.db().change_list_table_key(&added), "created".to_string()),
    ];
    want.sort();
    assert_eq!(got, want);
    assert!(
        logs[1]["changes"][0][2].as_bool().unwrap(),
        "with a version"
    );

    // Nothing new: nothing runs.
    assert_eq!(t.drain().await, 0);
}

#[actix_rt::test]
async fn a_paused_installation_is_skipped_without_counting_and_catches_up() {
    let (t, row) = setup("ac_paused", true).await;
    let mut app = t.db().get_resource(&t.app.as_str().into()).await.unwrap();
    app.set_unsafe(
        urls::INSTALLATION_STATUS.into(),
        Value::String("paused".into()),
    )
    .unwrap();
    app.save(t.db()).await.unwrap();

    for (i, name) in ["a", "b", "c"].iter().enumerate() {
        if i == 0 {
            t.rename(&row, name).await;
        } else {
            t.row(name).await;
        }
    }
    assert_eq!(t.drain().await, 0);
    assert!(delivery(t.db(), &t.sub().id).unwrap().is_none());
    assert!(t.db().after_commit_wake(&t.sub().id).unwrap().is_some());

    let mut app = t.db().get_resource(&t.app.as_str().into()).await.unwrap();
    app.set_unsafe(
        urls::INSTALLATION_STATUS.into(),
        Value::String("active".into()),
    )
    .unwrap();
    app.save(t.db()).await.unwrap();
    assert_eq!(t.drain().await, 1);
    let logs = t.logs().await;
    assert_eq!(
        changed(logs.last().unwrap()).len(),
        3,
        "all three, in one page"
    );
}

#[actix_rt::test]
async fn a_throw_is_redelivered_with_the_same_page() {
    let (t, row) = setup("ac_redeliver", true).await;
    t.configure(json!({"throwOnFirst": true})).await;
    t.rename(&row, "x").await;
    // The configure commit is on the app, not the table: one change.
    assert_eq!(t.drain().await, 1);
    let sub = t.sub();
    let d = delivery(t.db(), &sub.id).unwrap().unwrap();
    assert_eq!(d.attempts, 1);
    assert!(sub.last_error.unwrap().contains("boom on attempt 1"));
    let cursor = sub.cursor.clone();

    assert_eq!(t.drain().await, 1);
    let logs = t.logs().await;
    let last = logs.last().unwrap();
    assert_eq!(last["attempt"], 2);
    assert_eq!(
        changed(last),
        vec![(t.db().change_list_table_key(&row), "updated".to_string())]
    );
    assert_ne!(t.sub().cursor, cursor, "acknowledged, so the cursor moved");
    assert!(delivery(t.db(), &t.sub().id).unwrap().is_none());
}

#[actix_rt::test]
async fn eight_failures_stop_the_table_until_retry_and_nothing_is_lost() {
    let (t, row) = setup("ac_poison", true).await;
    t.configure(json!({"throwAlways": true})).await;
    t.rename(&row, "x").await;
    let cursor = t.sub().cursor.clone();
    for _ in 0..MAX_ATTEMPTS {
        assert_eq!(t.drain().await, 1);
    }
    let sub = t.sub();
    let stopped = sub.stopped.clone().expect("stopped after eight failures");
    assert_eq!(stopped.attempts, MAX_ATTEMPTS);
    assert!(sub.last_error.unwrap().contains("boom"));
    assert_eq!(sub.cursor, cursor, "the cursor did not move");

    // Stopped: more changes coalesce, nothing runs.
    t.row("later").await;
    assert_eq!(t.drain().await, 0);

    t.configure(json!({})).await;
    retry(t.db(), &t.f.drive, &t.table, &t.app).unwrap();
    assert_eq!(t.drain().await, 1, "the same page, delivered");
    let logs = t.logs().await;
    let last = logs.last().unwrap();
    assert_eq!(last["attempt"], 1);
    assert_eq!(
        changed(last),
        vec![(t.db().change_list_table_key(&row), "updated".to_string())]
    );
    // Then the change made while it was stopped.
    assert_eq!(t.drain().await, 1);
    assert_eq!(changed(t.logs().await.last().unwrap()).len(), 1);
    assert!(t.sub().stopped.is_none());
}

#[actix_rt::test]
async fn a_finished_journal_is_acknowledged_once_without_rerunning() {
    let (t, row) = setup("ac_crash_window", true).await;
    t.rename(&row, "x").await;
    let before = t.sub();
    assert_eq!(t.drain().await, 1);
    let runs = t.logs().await.len();
    let after = t.sub();

    // Rewind to "the run finished, the acknowledgement was lost": the
    // delivery is back, the cursor is the old one, the journal is finished.
    let finished = t
        .db()
        .kv
        .scan_prefix(Tree::PluginMeta, b"plugin-journal/v1/")
        .flatten()
        .filter_map(|(k, _)| String::from_utf8(k.to_vec()).ok())
        .filter(|k| k.contains("after-commit:") && k.ends_with("/finished"))
        .collect::<Vec<_>>();
    let id = finished
        .iter()
        .filter_map(|k| k.split("after-commit:").nth(1))
        .map(|rest| rest.split('"').next().unwrap().to_string())
        .next_back()
        .unwrap();
    let rewound = Delivery {
        id,
        subscription: before.id.clone(),
        from: before.cursor.clone(),
        to: after.cursor.clone().unwrap(),
        changes: vec![],
        has_more: false,
        reset: None,
        attempts: 0,
        next_attempt_at: 0,
        at: 0,
        verdict: None,
        waiting_for_review: false,
        source_hash: None,
    };
    save_delivery(t.db(), &rewound).unwrap();
    save(t.db(), &before).unwrap();

    assert_eq!(t.drain().await, 0, "acknowledged, not rerun");
    assert_eq!(t.logs().await.len(), runs);
    assert_eq!(t.sub().cursor, after.cursor);
    assert!(delivery(t.db(), &before.id).unwrap().is_none());
}

#[actix_rt::test]
async fn an_expired_cursor_asks_for_a_full_compare() {
    let (t, row) = setup("ac_expired", true).await;
    t.db().set_table_change_retention(std::time::Duration::ZERO);
    let mut r = t.db().get_resource(&row.as_str().into()).await.unwrap();
    r.destroy(t.db()).await.unwrap();
    assert_eq!(t.drain().await, 1);
    let logs = t.logs().await;
    assert_eq!(logs.last().unwrap()["reset"], "expired");
    // The cursor is at the head now: the next change is a plain delta.
    t.row("after").await;
    assert_eq!(t.drain().await, 1);
    assert_eq!(t.logs().await.last().unwrap()["reset"], Json::Null);
}

#[actix_rt::test]
async fn a_backlog_arrives_in_pages_not_counted_by_the_loop_cap() {
    let (t, _) = setup("ac_pages", true).await;
    for i in 0..(2 * PAGE_SIZE + 10) {
        t.row(&format!("r{i}")).await;
    }
    let mut sizes = vec![];
    let mut more = vec![];
    for _ in 0..3 {
        assert_eq!(t.drain().await, 1);
        let last = t.logs().await.pop().unwrap();
        sizes.push(changed(&last).len());
        more.push(last["hasMore"].as_bool().unwrap());
    }
    assert_eq!(sizes, vec![PAGE_SIZE, PAGE_SIZE, 10]);
    assert_eq!(more, vec![true, true, false]);
    assert_eq!(t.drain().await, 0);
    // Only the woken runs count: the initial one and the first page.
    let fires = t.worker.lock().await.fires.get(&t.app).map(|f| f.len());
    assert!(fires.unwrap_or(0) <= 2, "{fires:?}");
}

#[actix_rt::test]
async fn under_a_grant_the_hooks_row_writes_apply_and_do_not_wake_it_again() {
    let (t, row) = setup("ac_echo", true).await;
    t.grant().await;
    t.configure(json!({"writeRows": true})).await;
    t.rename(&row, "edited by a person").await;
    assert_eq!(t.drain().await, 1);
    assert_eq!(
        t.get(&row, urls::DESCRIPTION).await.as_deref(),
        Some("seen by the hook")
    );
    let runs = t.logs().await.len();
    assert_eq!(t.logs().await.last().unwrap()["grant"], "granted");
    // Signed by the app's own agent.
    let envelope = atomic_lib::envelopes::latest_envelope(t.db(), &pure(&row)).unwrap();
    let commit: Json = serde_json::from_str(&envelope.json).unwrap();
    assert_eq!(
        pure(commit[urls::SIGNER].as_str().unwrap()),
        pure(&t.app_agent)
    );

    // Its own write comes back as an echo: dropped, no run.
    assert_eq!(t.drain().await, 0);
    assert_eq!(t.logs().await.len(), runs);
    assert!(t.sub().pending.is_none());

    // A person's edit right after is delivered.
    t.rename(&row, "again").await;
    assert_eq!(t.drain().await, 1);
    assert_eq!(t.logs().await.len(), runs + 1);
}

#[actix_rt::test]
async fn without_a_grant_writes_wait_for_review_and_the_table_pauses() {
    let (t, row) = setup("ac_review", true).await;
    t.configure(json!({"writeRows": true})).await;
    t.rename(&row, "edited").await;
    assert_eq!(t.drain().await, 1);
    let sub = t.sub();
    let pending = sub
        .pending
        .clone()
        .unwrap_or_else(|| panic!("held for review: {sub:?} {:?}", delivery(t.db(), &sub.id)));
    assert!(pending.in_scope);
    assert!(pending.rows >= 1);
    assert_eq!(
        t.get(&row, urls::DESCRIPTION).await,
        None,
        "nothing written"
    );
    let logs_before = t.logs().await.len();

    // Paused on this table while it waits (decision 4).
    let other = t.row("while waiting").await;
    assert_eq!(t.drain().await, 0);

    let answered = review(t.db(), &t.f.drive, &t.table, &t.app, Answer::Apply, &t.me())
        .await
        .unwrap();
    assert!(answered.pending.is_none());
    assert_eq!(
        t.get(&row, urls::DESCRIPTION).await.as_deref(),
        Some("seen by the hook")
    );
    assert!(
        t.logs().await.len() > logs_before,
        "the log intent applied too"
    );
    assert!(app_row_grant::live(t.db(), &t.f.drive, &t.table, &t.app)
        .await
        .unwrap()
        .is_none());

    // Then it catches up with what changed meanwhile, which again waits.
    assert_eq!(t.drain().await, 1);
    let pending = t.sub().pending.expect("the next proposal");
    assert!(pending
        .subjects
        .iter()
        .any(|s| pure(s) == t.db().change_list_table_key(&other)));
}

#[actix_rt::test]
async fn allow_all_records_a_grant_and_decline_moves_on() {
    let (t, row) = setup("ac_allow_all", true).await;
    t.configure(json!({"writeRows": true})).await;
    t.rename(&row, "edited").await;
    t.drain().await;
    let cursor = t.sub().cursor;
    review(
        t.db(),
        &t.f.drive,
        &t.table,
        &t.app,
        Answer::AllowAll,
        &t.me(),
    )
    .await
    .unwrap();
    let grant = app_row_grant::live(t.db(), &t.f.drive, &t.table, &t.app)
        .await
        .unwrap()
        .expect("a grant");
    assert_eq!(grant.via, app_row_grant::VIA_HOOK_REVIEW);
    assert_eq!(
        t.get(&row, urls::DESCRIPTION).await.as_deref(),
        Some("seen by the hook")
    );
    assert_ne!(t.sub().cursor, cursor);

    // Decline, on another table's worth of state: revoke, edit, decline.
    app_row_grant::revoke(t.db(), &t.table, &t.app, &t.me(), app_row_grant::VIA_MENU)
        .await
        .unwrap();
    let second = t.row("second").await;
    t.drain().await;
    assert!(t.sub().pending.is_some());
    let cursor = t.sub().cursor;
    review(
        t.db(),
        &t.f.drive,
        &t.table,
        &t.app,
        Answer::Decline,
        &t.me(),
    )
    .await
    .unwrap();
    assert_eq!(t.get(&second, urls::DESCRIPTION).await, None);
    assert!(t.sub().pending.is_none());
    assert_ne!(t.sub().cursor, cursor, "declined, and moved past it");
}

#[actix_rt::test]
async fn writes_outside_the_grant_are_held_and_cannot_be_allowed_in_general() {
    let (t, row) = setup("ac_out_of_scope", true).await;
    t.grant().await;
    t.configure(json!({"writeParent": true})).await;
    t.rename(&row, "edited").await;
    assert_eq!(t.drain().await, 1);
    let pending = t.sub().pending.expect("held: parent is never granted");
    assert!(!pending.in_scope);
    let refused = review(
        t.db(),
        &t.f.drive,
        &t.table,
        &t.app,
        Answer::AllowAll,
        &t.me(),
    )
    .await;
    assert!(refused.unwrap_err().contains("only be applied once"));
    assert_eq!(
        app_row_grant::parent_of(&t.db().get_resource(&row.as_str().into()).await.unwrap()),
        Some(pure(&t.table))
    );
}

#[actix_rt::test]
async fn ctx_changes_reads_only_the_events_table() {
    let (t, _) = setup("ac_reads", true).await;
    let other = genesis(
        t.db(),
        vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::TABLE.into()])),
            (urls::PARENT, Value::AtomicUrl(t.f.drive.as_str().into())),
            (urls::NAME, Value::String("Other".into())),
            (
                urls::CLASSTYPE_PROP,
                Value::AtomicUrl(t.class.as_str().into()),
            ),
        ],
    )
    .await;
    t.configure(json!({"readOther": other, "readOwn": true}))
        .await;
    t.row("x").await;
    assert_eq!(t.drain().await, 1);
    let last = t.logs().await.pop().unwrap();
    assert!(
        last["other"].as_str().unwrap().contains("only the table"),
        "{last}"
    );
    assert_eq!(last["own"], 2, "the full list of its own table: both rows");
}

#[actix_rt::test]
async fn setting_view_kind_by_hand_subscribes_nothing_and_removing_the_view_ends_it() {
    let (t, _) = setup("ac_scope", true).await;
    // A second table whose view names the app, set by hand: no gesture.
    let other = genesis(
        t.db(),
        vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::TABLE.into()])),
            (urls::PARENT, Value::AtomicUrl(t.f.drive.as_str().into())),
            (urls::NAME, Value::String("By hand".into())),
            (
                urls::CLASSTYPE_PROP,
                Value::AtomicUrl(t.class.as_str().into()),
            ),
        ],
    )
    .await;
    genesis(
        t.db(),
        vec![
            (urls::IS_A, Value::ResourceArray(vec![VIEW_CLASS.into()])),
            (urls::PARENT, Value::AtomicUrl(other.as_str().into())),
            (urls::NAME, Value::String("By hand".into())),
            (VIEW_KIND, Value::String(t.app.clone())),
        ],
    )
    .await;
    assert!(find(t.db(), &t.f.drive, &t.app, &other).unwrap().is_none());

    // Switching the subscribed view to another kind ends the subscription.
    let mut view = t.db().get_resource(&t.view.as_str().into()).await.unwrap();
    view.set(VIEW_KIND.into(), Value::String("table".into()), t.db())
        .await
        .unwrap();
    view.save(t.db()).await.unwrap();
    let sub = t.sub();
    assert_eq!(
        sub.ended_via.as_deref(),
        Some(app_row_grant::VIA_VIEW_KIND_CHANGED)
    );
    t.row("after").await;
    assert!(t.db().after_commit_wake(&sub.id).unwrap().is_none());
    assert_eq!(t.drain().await, 0);
}

#[actix_rt::test]
async fn the_loop_cap_stops_a_plugin_its_own_writes_keep_waking() {
    let (t, row) = setup("ac_cap", true).await;
    {
        let mut w = t.worker.lock().await;
        let now = t.now.get() + 3_600_000;
        let fires = w.fires.entry(t.app.clone()).or_default();
        for _ in 0..RATE_LIMIT {
            fires.push_back(now);
        }
    }
    t.rename(&row, "one too many").await;
    assert_eq!(t.drain().await, 0);
    let sub = t.sub();
    assert!(sub.stopped.unwrap().reason.contains("keep waking"));
    assert!(
        t.db().after_commit_wake(&sub.id).unwrap().is_some(),
        "the change is kept for later"
    );
}

#[actix_rt::test]
async fn a_new_release_restarts_a_stopped_table() {
    let (t, row) = setup("ac_release", true).await;
    t.configure(json!({"throwAlways": true})).await;
    t.rename(&row, "x").await;
    for _ in 0..MAX_ATTEMPTS {
        t.drain().await;
    }
    assert!(t.sub().stopped.is_some());
    // A fixed release: same code, with a comment, so its hash differs.
    t.configure(json!({})).await;
    let fixed = format!("{SOURCE}\n// fixed\n");
    let id = t
        .db()
        .publish_plugin_release(&js_release_with_source(&fixed, manifest()))
        .unwrap();
    let mut app = t.db().get_resource(&t.app.as_str().into()).await.unwrap();
    app.set_unsafe(urls::RELEASE_ID.into(), Value::String(id.clone()))
        .unwrap();
    app.set_unsafe(urls::RELEASE_PROP.into(), Value::String(id))
        .unwrap();
    app.save(t.db()).await.unwrap();
    assert_eq!(t.drain().await, 1);
    assert!(t.sub().stopped.is_none());
}

#[actix_rt::test]
async fn a_lost_marker_is_recovered_by_the_sweep() {
    let (t, row) = setup("ac_sweep", true).await;
    t.rename(&row, "x").await;
    let id = t.sub().id;
    t.db().claim_after_commit_wake(&id).unwrap();
    assert_eq!(t.drain().await, 0, "no marker, no run");
    assert_eq!(sweep(t.db()).await.unwrap(), 1);
    assert_eq!(t.drain().await, 1);
    assert_eq!(sweep(t.db()).await.unwrap(), 0, "caught up");
}

#[actix_rt::test]
async fn views_with_a_live_grant_are_backfilled() {
    let (t, _) = setup("ac_backfill", true).await;
    let sub = t.sub();
    end(t.db(), sub, "test", "test").unwrap();
    // Forget the ended record, as if it never existed.
    remove(t.db(), &sub_key(&t.f.drive, &t.app, &t.table)).unwrap();
    t.grant().await;
    assert_eq!(backfill_from_grants(t.db()).await.unwrap(), 1);
    assert_eq!(t.sub().via, VIA_GRANT_BACKFILL);
}

#[actix_rt::test]
async fn with_the_flag_off_nothing_happens() {
    let (t, row) = setup("ac_flag_off", false).await;
    assert!(!t.db().after_commit_enabled());
    let sub = follow(
        t.db(),
        &t.f.drive,
        &t.table,
        &t.app,
        &t.view,
        &t.me(),
        app_row_grant::VIA_ADD_VIEW,
    )
    .await
    .unwrap();
    assert!(sub.is_none());
    t.rename(&row, "x").await;
    assert!(t.db().after_commit_wakes().unwrap().is_empty());
    assert_eq!(t.drain().await, 0);
    assert!(t.logs().await.is_empty());
}

#[test]
fn backoff_doubles_from_thirty_seconds_to_an_hour() {
    assert_eq!(backoff(1), 30_000);
    assert_eq!(backoff(2), 60_000);
    assert_eq!(backoff(4), 240_000);
    assert_eq!(backoff(8), 3_600_000);
    assert_eq!(backoff(30), 3_600_000);
}

#[test]
fn a_marker_is_due_after_the_debounce_or_the_cap() {
    let wake = Wake {
        first_at: 0,
        last_at: 9_000,
        count: 5,
        hint: vec![],
    };
    assert!(!due(&wake, 9_500, 2_000));
    assert!(due(&wake, 10_000, 2_000), "ten seconds after the first");
    let quiet = Wake {
        first_at: 0,
        last_at: 1_000,
        ..wake
    };
    assert!(due(&quiet, 3_000, 2_000));
}

// ------------------------------------------------ durability (subprocess)

#[actix_rt::test]
#[ignore = "subprocess helper"]
async fn child_edits_a_followed_table_then_exits_without_cleanup() {
    let Ok(path) = std::env::var("ATOMIC_AFTER_COMMIT_CRASH_REPORT") else {
        return;
    };
    let (t, row) = setup("ac_hard_restart", true).await;
    t.rename(&row, "edited before the crash").await;
    t.db().flush().unwrap();
    std::fs::write(
        path,
        serde_json::to_vec(&json!({
            "data": t.f.appstate.config.store_path.parent().unwrap(),
            "config": t.f.appstate.config.config_dir,
            "drive": t.f.drive, "app": t.app, "table": t.table, "row": row,
        }))
        .unwrap(),
    )
    .unwrap();
    // No destructors, no graceful shutdown of the database.
    std::process::exit(73);
}

#[actix_rt::test]
async fn an_edit_survives_a_hard_restart_and_is_delivered() {
    use clap::Parser;
    let report = std::env::temp_dir().join(format!(
        "atomic-after-commit-{}.json",
        atomic_lib::utils::random_string(16)
    ));
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "plugins::after_commit::tests::child_edits_a_followed_table_then_exits_without_cleanup",
            "--exact",
            "--ignored",
        ])
        .env("ATOMIC_AFTER_COMMIT_CRASH_REPORT", &report)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(73));
    let meta: Json = serde_json::from_slice(&std::fs::read(&report).unwrap()).unwrap();
    let opts = crate::config::Opts::parse_from([
        "atomic-server",
        "--plugin-after-commit",
        "--data-dir",
        meta["data"].as_str().unwrap(),
        "--config-dir",
        meta["config"].as_str().unwrap(),
    ]);
    let appstate = AppState::init(crate::config::build_config(opts).unwrap())
        .await
        .unwrap();
    let worker = Mutex::new(Worker {
        debounce_ms: 0,
        ..Default::default()
    });
    let drive = meta["drive"].as_str().unwrap();
    let app = meta["app"].as_str().unwrap();
    let table = meta["table"].as_str().unwrap();
    let sub = find(&appstate.store, drive, app, table).unwrap().unwrap();
    assert!(appstate.store.after_commit_wake(&sub.id).unwrap().is_some());
    assert_eq!(
        drain_at(&appstate, &worker, atomic_lib::utils::now() + 60_000).await,
        1
    );
    let app_resource = appstate.store.get_resource(&app.into()).await.unwrap();
    let delivered = app_resource
        .get_children(&appstate.store)
        .await
        .unwrap()
        .iter()
        .filter_map(|c| c.get(urls::NAME).ok().map(|v| v.to_string()))
        .filter(|n| n.starts_with('{'))
        .any(|n| {
            n.contains(
                &appstate
                    .store
                    .change_list_table_key(meta["row"].as_str().unwrap()),
            )
        });
    assert!(
        delivered,
        "the edit made before the crash reached the plugin"
    );
    std::fs::remove_file(report).unwrap();
}

/// Keep `Resource` in use for the helpers above on every feature set.
#[allow(dead_code)]
fn _uses(_: Resource) {}

/// Sets the Installation's status, the way pausing and revoking do.
async fn set_status(t: &T, status: &str) {
    let mut app = t.db().get_resource(&t.app.as_str().into()).await.unwrap();
    app.set_unsafe(
        urls::INSTALLATION_STATUS.into(),
        Value::String(status.into()),
    )
    .unwrap();
    app.save(t.db()).await.unwrap();
}

/// A proposal waiting for review on the table.
async fn waiting_proposal(t: &T, row: &str) {
    t.configure(json!({"writeRows": true})).await;
    t.rename(row, "edited").await;
    assert_eq!(t.drain().await, 1);
    assert!(t.sub().pending.is_some(), "held for review");
}

#[actix_rt::test]
async fn revoking_the_installation_ends_the_subscription_and_drops_its_proposal() {
    let (t, row) = setup("ac_revoke", true).await;
    waiting_proposal(&t, &row).await;
    // The first tick subscribes the worker to the store's events.
    tick(&t.f.appstate, &t.worker).await;
    assert!(t.sub().is_live());

    set_status(&t, "revoked").await;
    tick(&t.f.appstate, &t.worker).await;
    let sub = t.sub();
    assert!(
        !sub.is_live(),
        "ended on the revoke, not at the next delivery"
    );
    assert_eq!(sub.ended_via.as_deref(), Some(VIA_REVOKED));
    assert!(sub.pending.is_none());
    assert!(
        delivery(t.db(), &sub.id).unwrap().is_none(),
        "proposal dropped"
    );
    assert!(
        review(t.db(), &t.f.drive, &t.table, &t.app, Answer::Apply, &t.me())
            .await
            .is_err()
    );
    assert_eq!(
        t.get(&row, urls::DESCRIPTION).await,
        None,
        "nothing written"
    );
}

#[actix_rt::test]
async fn a_paused_installation_is_not_ended() {
    let (t, _row) = setup("ac_pause_not_end", true).await;
    tick(&t.f.appstate, &t.worker).await;
    set_status(&t, "paused").await;
    tick(&t.f.appstate, &t.worker).await;
    assert_eq!(sweep(t.db()).await.unwrap(), 0);
    assert!(t.sub().is_live());
}

#[actix_rt::test]
async fn uninstalling_ends_the_subscription_at_the_sweep() {
    let (t, row) = setup("ac_uninstall", true).await;
    waiting_proposal(&t, &row).await;
    let mut app = t.db().get_resource(&t.app.as_str().into()).await.unwrap();
    app.destroy(t.db()).await.unwrap();
    // Without the event (the worker was not listening), the sweep ends it.
    sweep(t.db()).await.unwrap();
    let sub = t.sub();
    assert_eq!(sub.ended_via.as_deref(), Some(VIA_UNINSTALLED));
    assert!(delivery(t.db(), &sub.id).unwrap().is_none());
    assert!(t.db().after_commit_wake(&sub.id).unwrap().is_none());
}

#[actix_rt::test]
async fn losing_read_access_ends_the_subscription_as_soon_as_the_rights_change() {
    let (t, row) = setup("ac_lost_read", true).await;
    // Someone else turned it on, with write access to this table only.
    let other = Agent::new(Some("colleague")).unwrap();
    t.db()
        .add_resource(&other.to_resource().unwrap())
        .await
        .unwrap();
    let mut table = t.db().get_resource(&t.table.as_str().into()).await.unwrap();
    table
        .push(urls::WRITE, other.subject.to_string().into(), true)
        .unwrap();
    table.save(t.db()).await.unwrap();
    let mut sub = t.sub();
    sub.activated_by = other.subject.to_string();
    save(t.db(), &sub).unwrap();
    assert_eq!(end_reason(t.db(), &sub).await, None);
    tick(&t.f.appstate, &t.worker).await;

    // A row edit is not a reason to look.
    t.rename(&row, "still here").await;
    tick(&t.f.appstate, &t.worker).await;
    assert!(t.sub().is_live());

    let mut table = t.db().get_resource(&t.table.as_str().into()).await.unwrap();
    table
        .set_unsafe(urls::WRITE.into(), Value::ResourceArray(vec![]))
        .unwrap();
    table.save(t.db()).await.unwrap();
    tick(&t.f.appstate, &t.worker).await;
    let sub = t.sub();
    assert!(!sub.is_live());
    assert_eq!(sub.ended_via.as_deref(), Some(VIA_ACTIVATOR_LOST_READ));
}

/// Publishes `SOURCE` plus a comment as a new release and pins it.
async fn update_release(t: &T) {
    let changed = format!("{SOURCE}\n// updated\n");
    let id = t
        .db()
        .publish_plugin_release(&js_release_with_source(&changed, manifest()))
        .unwrap();
    let mut app = t.db().get_resource(&t.app.as_str().into()).await.unwrap();
    app.set_unsafe(urls::RELEASE_ID.into(), Value::String(id.clone()))
        .unwrap();
    app.set_unsafe(urls::RELEASE_PROP.into(), Value::String(id))
        .unwrap();
    app.save(t.db()).await.unwrap();
}

#[actix_rt::test]
async fn a_proposal_from_the_previous_release_is_refused_and_proposed_again() {
    let (t, row) = setup("ac_stale_review", true).await;
    waiting_proposal(&t, &row).await;
    let old = delivery(t.db(), &t.sub().id).unwrap().unwrap();
    update_release(&t).await;

    let err = review(t.db(), &t.f.drive, &t.table, &t.app, Answer::Apply, &t.me())
        .await
        .unwrap_err();
    assert!(err.contains("updated"), "{err}");
    assert_eq!(t.get(&row, urls::DESCRIPTION).await, None, "not applied");
    let rerun = delivery(t.db(), &t.sub().id).unwrap().unwrap();
    assert_ne!(rerun.id, old.id);
    assert_eq!(rerun.changes, old.changes, "the same page");
    assert!(!rerun.waiting_for_review);
    assert!(t.sub().pending.is_none());

    // The new release proposes again, and that one can be applied.
    assert_eq!(t.drain().await, 1);
    assert!(t.sub().pending.is_some());
    review(t.db(), &t.f.drive, &t.table, &t.app, Answer::Apply, &t.me())
        .await
        .unwrap();
    assert_eq!(
        t.get(&row, urls::DESCRIPTION).await.as_deref(),
        Some("seen by the hook")
    );
}

#[actix_rt::test]
async fn the_worker_discards_a_stale_proposal_without_a_review() {
    let (t, row) = setup("ac_stale_worker", true).await;
    waiting_proposal(&t, &row).await;
    let logs = t.logs().await.len();
    update_release(&t).await;
    assert_eq!(t.drain().await, 0, "the discard pass does not run");
    assert!(t.sub().pending.is_none());
    assert_eq!(t.drain().await, 1, "then the new source runs the page");
    assert!(t.sub().pending.is_some());
    assert_eq!(t.logs().await.len(), logs, "log intents wait with the rest");
}

/// A person's edit lands on a row after the hook saw it and before the
/// hook's write: here, while the write waits for review, the widest window.
/// Both survive (Loro merges per property), and the person's edit is
/// delivered next rather than swallowed as the hook's own echo: an own write
/// is only recorded when the row was still at the version the hook saw.
#[actix_rt::test]
async fn a_persons_edit_just_before_the_hooks_write_is_kept_and_delivered() {
    let (t, row) = setup("ac_race", true).await;
    waiting_proposal(&t, &row).await;
    let logs = t.logs().await.len();
    t.rename(&row, "the person's").await;
    review(t.db(), &t.f.drive, &t.table, &t.app, Answer::Apply, &t.me())
        .await
        .unwrap();
    assert_eq!(
        t.get(&row, urls::NAME).await.as_deref(),
        Some("the person's")
    );
    assert_eq!(
        t.get(&row, urls::DESCRIPTION).await.as_deref(),
        Some("seen by the hook")
    );
    assert!(
        get_json::<OwnWrite>(
            t.db(),
            &own_key(&t.sub().id, &t.db().change_list_table_key(&row))
        )
        .unwrap()
        .is_none(),
        "not recorded as an echo"
    );
    assert!(t.logs().await.len() > logs, "the reviewed proposal applied");
    assert_eq!(t.drain().await, 1, "the person's edit is delivered");
    // Without a grant the hook's answer waits again; the page it got holds
    // the row.
    let page = delivery(t.db(), &t.sub().id).unwrap().unwrap();
    assert!(page
        .changes
        .iter()
        .any(|c| c.subject == t.db().change_list_table_key(&row)));
}
