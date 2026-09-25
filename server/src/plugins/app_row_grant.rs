//! An app shown as a table's view may edit that table's rows, through an
//! explicit grant tied to the gesture that made it the view (#1740).
//!
//! **What does not grant anything.** Setting a View's `view-kind` to an app.
//! Anyone who may write the table can set that property without going through
//! the menu, so the property alone is not consent. It only decides what the
//! tab renders.
//!
//! **What does.** Someone who may write the table (and use the app) confirms
//! "<App> can edit rows in this table", from the table's "+ Add view" menu, a
//! tab's "View type" list, the tab's own menu, or an app asking with
//! `store.requestRowAccess()`.
//! The page then asks the server for a [`RowGrant`]. The server records it
//! with the signer of that request as `grantedBy`, its own clock as
//! `grantedAt`, and the gesture as `via`: nothing the page says about who
//! granted it is trusted.
//!
//! **Why a server record, not a `write` right on the table for the app's
//! agent.** A right would be simpler to enforce (the ordinary rights walk
//! already runs on every `/app-write`), but it reaches the table itself: its
//! name, schema, views and its own rights, and every row whatever its class.
//! It would also be a plain value on the table that anyone with write could
//! add by hand, which is the same hole as `view-kind`. A record the server
//! writes only on a signed grant request stays the single source of truth,
//! can be narrowed to "rows of the table's row class, their class's
//! properties only", and carries who, when and how for #1785. The cost: a
//! peer that re-checks a row commit's signer against the rights walk alone
//! would not see the grant. Commits written through `/app-write` are applied
//! with `validate_rights: false` on this server, like every other app write.
//!
//! **Scope.** On rows whose parent is the table and whose class is the table's
//! row class (`classtype`): `save` and `remove` of properties the row class
//! requires or recommends, and `create` of a row of exactly that class. Never
//! `destroy`, never `parent`, `isA` or rights, never the table or its views.
//!
//! **Lifetime.** A grant lapses, and is recorded as revoked, when its View is
//! destroyed or leaves the table's `table-views`, when the View's kind stops
//! naming the app, when the person who granted it can no longer write the
//! table, or when the app's key changes. Revoking by hand is a menu action on
//! the tab. Revoked grants stay in the record with `revokedAt`, `revokedBy`
//! and `revokedVia`, so the history of who allowed what survives.

use atomic_lib::{
    agents::ForAgent,
    class_extender::{ClassExtender, CommitExtenderContext},
    db::trees::Tree,
    errors::AtomicResult,
    hierarchy::check_write,
    urls, Db, Resource, Storelike, Subject, Value,
};
use serde::{Deserialize, Serialize};

pub const VIEW_CLASS: &str = "https://atomicdata.dev/classes/View";
pub const VIEW_KIND: &str = "https://atomicdata.dev/properties/view-kind";
pub const TABLE_VIEWS: &str = "https://atomicdata.dev/properties/table-views";

/// Added from the table's "+ Add view" menu.
pub const VIA_ADD_VIEW: &str = "add-view";
/// An existing tab switched to the app in its "View type" list.
pub const VIA_VIEW_TYPE: &str = "view-type";
/// The app asked with `store.requestRowAccess()` and the person agreed.
pub const VIA_REQUEST: &str = "request";
/// Given or revoked from the tab's menu.
pub const VIA_MENU: &str = "menu";
/// Revoked because the View was destroyed or left the table.
pub const VIA_VIEW_REMOVED: &str = "view-removed";
/// Revoked because the View's kind no longer names the app.
pub const VIA_VIEW_KIND_CHANGED: &str = "view-kind-changed";
/// Lapsed because the person who granted it can no longer write the table.
pub const VIA_GRANTER_LOST_WRITE: &str = "granter-lost-write";
/// Lapsed because the app's key is not the one it was granted to.
pub const VIA_APP_KEY_CHANGED: &str = "app-key-changed";

const GRANT_VIAS: [&str; 4] = [VIA_ADD_VIEW, VIA_VIEW_TYPE, VIA_REQUEST, VIA_MENU];

/// Never writable through a grant, whatever the row class declares.
const NEVER: [&str; 6] = [
    urls::PARENT,
    urls::IS_A,
    urls::READ,
    urls::WRITE,
    urls::APPEND,
    urls::LAST_COMMIT,
];

/// One grant, live or revoked. Serialized as the record and as the API answer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowGrant {
    pub id: String,
    pub drive: String,
    /// The app, as the View's `view-kind` names it.
    pub app: String,
    /// The app's agent when this was granted. A different key is a different
    /// signer, so the grant does not follow a re-keyed app.
    pub app_agent: String,
    pub table: String,
    /// The View whose gesture this grant is tied to.
    pub view: String,
    pub granted_by: String,
    /// Milliseconds since the epoch, by this server's clock.
    pub granted_at: i64,
    /// `add-view`, `view-type`, `request` or `menu`.
    pub via: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_via: Option<String>,
}

impl RowGrant {
    pub fn is_live(&self) -> bool {
        self.revoked_at.is_none()
    }
}

/// What a write through a grant asks to do. Checked by [`check_scope`].
pub enum RowWrite<'a> {
    Create {
        parent: &'a str,
        is_a: &'a [String],
        properties: Vec<&'a str>,
    },
    Set {
        subject: &'a str,
        properties: Vec<&'a str>,
    },
    Destroy {
        subject: &'a str,
    },
}

fn pure(subject: &str) -> String {
    Subject::from_raw(subject, None).pure_id()
}

fn prefix_for_table(table: &str) -> String {
    // A JSON array with its closing bracket left off, so a scan finds every
    // grant on the table, or on the table for one app, and nothing else.
    format!("app-row-grant/v1/[{}", serde_json::json!(pure(table)))
}

fn prefix_for(table: &str, app: &str) -> String {
    format!(
        "{},{},",
        prefix_for_table(table),
        serde_json::json!(pure(app))
    )
}

fn key_of(grant: &RowGrant) -> String {
    format!(
        "{}{}]",
        prefix_for(&grant.table, &grant.app),
        serde_json::json!(grant.id)
    )
}

fn put(db: &Db, grant: &RowGrant) -> Result<(), String> {
    db.kv
        .insert(
            Tree::PluginMeta,
            key_of(grant).as_bytes(),
            &serde_json::to_vec(grant).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    db.flush().map_err(|e| e.to_string())
}

fn scan(db: &Db, prefix: &str) -> Result<Vec<RowGrant>, String> {
    let mut found = db
        .kv
        .scan_prefix(Tree::PluginMeta, prefix.as_bytes())
        .map(|row| {
            row.map_err(|e| e.to_string()).and_then(|(_, v)| {
                serde_json::from_slice::<RowGrant>(&v).map_err(|e| e.to_string())
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    found.sort_by_key(|g| g.granted_at);
    Ok(found)
}

/// Every grant this app ever had on this table, oldest first, revoked ones
/// included. The record #1785 asks for, per table and app.
pub fn history(db: &Db, table: &str, app: &str) -> Result<Vec<RowGrant>, String> {
    scan(db, &prefix_for(table, app))
}

fn revoke_record(db: &Db, mut grant: RowGrant, by: &str, via: &str) -> Result<RowGrant, String> {
    grant.revoked_at = Some(atomic_lib::utils::now());
    grant.revoked_by = Some(by.to_string());
    grant.revoked_via = Some(via.to_string());
    put(db, &grant)?;
    Ok(grant)
}

fn string_of(value: &Value) -> Option<String> {
    match value {
        Value::AtomicUrl(s) => Some(s.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn subjects_of(resource: &Resource, property: &str) -> Vec<String> {
    resource
        .get(property)
        .ok()
        .and_then(|v| v.to_subjects(None).ok())
        .unwrap_or_default()
        .iter()
        .map(|s| pure(s))
        .collect()
}

fn parent_of(resource: &Resource) -> Option<String> {
    resource
        .get(urls::PARENT)
        .ok()
        .and_then(string_of)
        .map(|s| pure(&s))
}

/// The app's current agent, by the same resolution `/app-write` signs with.
async fn app_agent_of(db: &Db, drive: &str, app: &str) -> Result<String, String> {
    let resolved = super::installation::resolve(db, drive, app).await?;
    let key = resolved
        .signing_as
        .filter(|key| key.app == app)
        .ok_or("This app has no key of its own, so it cannot be given rows to edit")?;
    Ok(db
        .get_app_agent_info(&key)
        .map_err(|e| e.to_string())?
        .ok_or("This app's identity is missing")?
        .agent)
}

/// Why `view` does not (or no longer) show `app` on `table`, if it does not.
async fn view_problem(db: &Db, table: &str, app: &str, view: &str) -> Option<&'static str> {
    let Ok(view_resource) = db.get_resource(&view.into()).await else {
        return Some(VIA_VIEW_REMOVED);
    };
    let Ok(table_resource) = db.get_resource(&table.into()).await else {
        return Some(VIA_VIEW_REMOVED);
    };
    if parent_of(&view_resource).as_deref() != Some(pure(table).as_str())
        || !subjects_of(&table_resource, TABLE_VIEWS).contains(&pure(view))
    {
        return Some(VIA_VIEW_REMOVED);
    }
    let kind = view_resource.get(VIEW_KIND).ok().and_then(string_of);
    if kind.map(|k| pure(&k)) != Some(pure(app)) {
        return Some(VIA_VIEW_KIND_CHANGED);
    }
    None
}

async fn may_write(db: &Db, subject: &str, agent: &str) -> bool {
    let Ok(resource) = db.get_resource(&subject.into()).await else {
        return false;
    };
    check_write(db, &resource, &ForAgent::AgentSubject(agent.into()))
        .await
        .is_ok()
}

/// The live grant for `app` on `table`, re-checked now. A grant whose
/// conditions no longer hold is recorded as revoked here and not returned,
/// so a write never rides on one that should have lapsed.
pub async fn live(
    db: &Db,
    drive: &str,
    table: &str,
    app: &str,
) -> Result<Option<RowGrant>, String> {
    let Some(grant) = history(db, table, app)?.into_iter().find(RowGrant::is_live) else {
        return Ok(None);
    };
    let lapsed = if let Some(why) = view_problem(db, table, app, &grant.view).await {
        Some(why)
    } else if !may_write(db, table, &grant.granted_by).await {
        Some(VIA_GRANTER_LOST_WRITE)
    } else if app_agent_of(db, drive, app).await.ok().as_deref() != Some(&grant.app_agent) {
        Some(VIA_APP_KEY_CHANGED)
    } else {
        None
    };
    if let Some(why) = lapsed {
        revoke_record(
            db,
            grant,
            &db.get_default_agent()
                .map_err(|e| e.to_string())?
                .subject
                .to_string(),
            why,
        )?;
        return Ok(None);
    }
    Ok(Some(grant))
}

/// Records a grant from `granted_by` to `app` on `table`, tied to `view`.
///
/// `granted_by` is the signer of the request, never something the page said.
/// They must be able to write the table and use the app, and `view` must be a
/// view of the table that shows the app. An existing live grant is returned
/// as it is: granting twice is not two grants.
pub async fn grant(
    db: &Db,
    drive: &str,
    table: &str,
    app: &str,
    view: &str,
    granted_by: &str,
    via: &str,
) -> Result<RowGrant, String> {
    if !GRANT_VIAS.contains(&via) {
        return Err(format!(
            "A grant is given by adding a view, choosing a view type, the tab's menu or answering a request, not by '{via}'"
        ));
    }
    if !may_write(db, table, granted_by).await {
        return Err("Only someone who can edit this table can let an app edit its rows".into());
    }
    if !may_write(db, app, granted_by).await {
        return Err("Only someone who can use this app can let it edit rows".into());
    }
    if view_problem(db, table, app, view).await.is_some() {
        return Err("That view is not a view of this table showing this app".into());
    }
    if let Some(existing) = live(db, drive, table, app).await? {
        return Ok(existing);
    }
    let grant = RowGrant {
        id: ulid::Ulid::new().to_string().to_lowercase(),
        drive: drive.to_string(),
        app: pure(app),
        app_agent: app_agent_of(db, drive, app).await?,
        table: pure(table),
        view: pure(view),
        granted_by: granted_by.to_string(),
        granted_at: atomic_lib::utils::now(),
        via: via.to_string(),
        revoked_at: None,
        revoked_by: None,
        revoked_via: None,
    };
    put(db, &grant)?;
    Ok(grant)
}

/// Revokes the live grant, if there is one. Anyone who may write the table
/// may take it away, not only the person who gave it.
pub async fn revoke(
    db: &Db,
    table: &str,
    app: &str,
    revoked_by: &str,
    via: &str,
) -> Result<Option<RowGrant>, String> {
    if !may_write(db, table, revoked_by).await {
        return Err("Only someone who can edit this table can change what apps may edit".into());
    }
    let Some(grant) = history(db, table, app)?.into_iter().find(RowGrant::is_live) else {
        return Ok(None);
    };
    revoke_record(db, grant, revoked_by, via).map(Some)
}

/// Whether `table` has a view showing `app`: a table the app is a view of,
/// so a refused write can say how to ask rather than only that it failed.
pub async fn is_app_view_of(db: &Db, table: &str, app: &str) -> bool {
    let Ok(table_resource) = db.get_resource(&table.into()).await else {
        return false;
    };
    for view in subjects_of(&table_resource, TABLE_VIEWS) {
        if view_problem(db, table, app, &view).await.is_none() {
            return true;
        }
    }
    false
}

/// Refuses unless `write` stays within what a grant on `grant.table` reaches.
pub async fn check_scope(db: &Db, grant: &RowGrant, write: &RowWrite<'_>) -> Result<(), String> {
    let table = db
        .get_resource(&grant.table.as_str().into())
        .await
        .map_err(|e| format!("The table could not be read: {e}"))?;
    let row_class = table
        .get(urls::CLASSTYPE_PROP)
        .ok()
        .and_then(string_of)
        .map(|c| pure(&c))
        .ok_or("This table names no row class, so no row can be edited through a grant")?;
    let class = db
        .get_class(&row_class)
        .await
        .map_err(|e| format!("The row class could not be read: {e}"))?;
    let allowed: Vec<String> = class
        .requires
        .iter()
        .chain(class.recommends.iter())
        .map(|p| p.to_string())
        .collect();

    let check_properties = |properties: &[&str]| -> Result<(), String> {
        for property in properties {
            if NEVER.contains(property) || !allowed.iter().any(|a| a == property) {
                return Err(format!(
                    "This app may edit this table's columns only, not {property}"
                ));
            }
        }
        Ok(())
    };

    match write {
        RowWrite::Create {
            parent,
            is_a,
            properties,
        } => {
            if pure(parent) != grant.table {
                return Err("This app may only add rows to the table it is a view of".into());
            }
            if is_a.len() != 1 || pure(&is_a[0]) != row_class {
                return Err(
                    "A row added through a grant must be of the table's row class, and only that"
                        .into(),
                );
            }
            check_properties(properties)
        }
        RowWrite::Set {
            subject,
            properties,
        } => {
            let row = db
                .get_resource(&(*subject).into())
                .await
                .map_err(|e| format!("{subject} could not be read: {e}"))?;
            if parent_of(&row).as_deref() != Some(grant.table.as_str()) {
                return Err("This app may only edit rows of the table it is a view of".into());
            }
            if !subjects_of(&row, urls::IS_A).contains(&row_class) {
                return Err("This app may only edit rows of the table's row class".into());
            }
            check_properties(properties)
        }
        RowWrite::Destroy { .. } => {
            Err("Letting an app edit rows does not let it delete them".into())
        }
    }
}

/// Revokes grants when their View is destroyed or stops showing the app,
/// at the moment it happens, so setting the kind back later does not bring
/// an old grant back.
pub fn build_view_extender() -> ClassExtender {
    ClassExtender::builder()
        .id("app-row-grant-views")
        .class(VIEW_CLASS)
        .after_commit_fn(on_view_commit)
        .build()
}

fn on_view_commit(
    context: CommitExtenderContext,
) -> atomic_lib::class_extender::BoxFuture<AtomicResult<()>> {
    Box::pin(async move {
        let CommitExtenderContext {
            store,
            commit,
            resource,
            changed_props,
            ..
        } = context;
        let destroyed = commit.destroy == Some(true);
        if !destroyed && !changed_props.contains(VIEW_KIND) {
            return Ok(());
        }
        let Some(table) = parent_of(resource) else {
            return Ok(());
        };
        let view = resource.get_subject().pure_id();
        let kind = resource
            .get(VIEW_KIND)
            .ok()
            .and_then(string_of)
            .map(|k| pure(&k));
        let signer = commit.signer.to_string();

        for grant in
            scan(store, &prefix_for_table(&table)).map_err(atomic_lib::AtomicError::from)?
        {
            if !grant.is_live() || grant.view != view {
                continue;
            }
            let via = if destroyed {
                VIA_VIEW_REMOVED
            } else if kind.as_deref() != Some(grant.app.as_str()) {
                VIA_VIEW_KIND_CHANGED
            } else {
                continue;
            };
            revoke_record(store, grant, &signer, via).map_err(atomic_lib::AtomicError::from)?;
        }
        Ok(())
    })
}
