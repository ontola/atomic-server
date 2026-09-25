//! An app shown as a table's view edits that table's rows only through the
//! grant someone gave it there (#1740), against a real store.

use actix_web::{test, web::Data, App};
use atomic_lib::{agents::Agent, db::app_agent::AppAgentKey, urls, Storelike, Value};
use serde_json::{json, Value as Json};

use super::app_endpoints_test::{app_fixture, body_of, share, signed, signed_as};
use crate::plugins::app_row_grant::{TABLE_VIEWS, VIEW_CLASS, VIEW_KIND};
use crate::plugins::test_fixture::{genesis, Fixture};

/// A table of `Transaction` rows next to the app, with one row and a View of
/// the table showing the app. The app's own rights reach none of it.
struct Table {
    subject: String,
    row_class: String,
    row: String,
    view: String,
}

async fn table(fixture: &Fixture, app: &str, name: &str) -> Table {
    let store = &fixture.appstate.store;
    let drive = fixture.drive.as_str();

    // Columns: name and description. `money-category` / `money-note` in the
    // money app are the same thing, a row class's recommended properties.
    let row_class = genesis(
        store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::CLASS.into()])),
            (urls::PARENT, Value::AtomicUrl(drive.into())),
            (urls::SHORTNAME, Value::Slug(format!("{name}-row"))),
            (urls::DESCRIPTION, Value::Markdown("A row".into())),
            (
                urls::RECOMMENDS,
                Value::ResourceArray(vec![urls::NAME.into(), urls::DESCRIPTION.into()]),
            ),
        ],
    )
    .await;

    let subject = genesis(
        store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![urls::TABLE.into()])),
            (urls::PARENT, Value::AtomicUrl(drive.into())),
            (urls::NAME, Value::String(name.into())),
            (
                urls::CLASSTYPE_PROP,
                Value::AtomicUrl(row_class.as_str().into()),
            ),
        ],
    )
    .await;

    let row = genesis(
        store,
        vec![
            (
                urls::IS_A,
                Value::ResourceArray(vec![row_class.as_str().into()]),
            ),
            (urls::PARENT, Value::AtomicUrl(subject.as_str().into())),
            (urls::NAME, Value::String("Coffee".into())),
        ],
    )
    .await;

    let view = genesis(
        store,
        vec![
            (urls::IS_A, Value::ResourceArray(vec![VIEW_CLASS.into()])),
            (urls::PARENT, Value::AtomicUrl(subject.as_str().into())),
            (urls::NAME, Value::String("Money".into())),
            (VIEW_KIND, Value::String(app.into())),
        ],
    )
    .await;

    let mut table_resource = store.get_resource(&subject.as_str().into()).await.unwrap();
    table_resource
        .set_unsafe(
            TABLE_VIEWS.into(),
            Value::ResourceArray(vec![view.as_str().into()]),
        )
        .unwrap();
    table_resource.save(store).await.unwrap();

    Table {
        subject,
        row_class,
        row,
        view,
    }
}

// Macros rather than helper functions: the test service's request type is
// `actix_http::Request`, which this crate cannot name without depending on
// actix-http directly.
macro_rules! service {
    ($fixture:expr) => {
        test::init_service(
            App::new()
                .app_data(Data::new($fixture.appstate.clone()))
                .configure(crate::routes::config_routes),
        )
        .await
    };
}

/// Posts JSON, signed as the node's agent or as `$agent`; `(status, body)`.
macro_rules! post {
    (@send $service:expr, $request:expr, $body:expr) => {{
        let response = test::call_service(
            &$service,
            $request
                .method(actix_web::http::Method::POST)
                .insert_header(("Content-Type", "application/json"))
                .set_payload(($body).to_string())
                .to_request(),
        )
        .await;
        let status = response.status().as_u16();
        (status, body_of(response))
    }};
    ($service:expr, $fixture:expr, $path:expr, $body:expr) => {
        post!(@send $service, signed($path, &$fixture.appstate), $body)
    };
    ($service:expr, $fixture:expr, $path:expr, $body:expr, $agent:expr) => {
        post!(@send $service, signed_as($path, &$fixture.appstate, $agent), $body)
    };
}

/// `GET /app-row-grant` for the app on the table, as the node's agent.
macro_rules! status {
    ($service:expr, $fixture:expr, $app:expr, $table:expr) => {{
        let path = format!(
            "/app-row-grant?drive={}&table={}&app={}",
            urlencoding::encode(&$fixture.drive),
            urlencoding::encode(&$table.subject),
            urlencoding::encode($app),
        );
        let response =
            test::call_service(&$service, signed(&path, &$fixture.appstate).to_request()).await;
        assert_eq!(response.status(), 200);
        let json: Json = serde_json::from_str(&body_of(response)).unwrap();
        json
    }};
}

fn grant_body(fixture: &Fixture, app: &str, table: &Table, via: &str) -> Json {
    json!({
        "op": "grant",
        "drive": fixture.drive,
        "table": table.subject,
        "app": app,
        "view": table.view,
        "via": via,
    })
}

fn save_body(fixture: &Fixture, app: &str, subject: &str, property: &str, value: &str) -> Json {
    json!({
        "drive": fixture.drive,
        "app": app,
        "op": "save",
        "subject": subject,
        "propVals": { property: value },
    })
}

async fn name_of(fixture: &Fixture, subject: &str) -> String {
    fixture
        .appstate
        .store
        .get_resource(&subject.into())
        .await
        .unwrap()
        .get(urls::NAME)
        .unwrap()
        .to_string()
}

#[actix_rt::test]
async fn adding_the_view_with_a_grant_lets_the_app_save_a_row() {
    let (fixture, app) = app_fixture("row_grant_add_view").await;
    let table = table(&fixture, &app, "transactions").await;
    let service = service!(fixture);

    let (code, body) = post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table, "add-view")
    );
    assert_eq!(code, 200, "{body}");

    let (code, body) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table.row, urls::NAME, "Coffee with Ana")
    );
    assert_eq!(code, 200, "{body}");
    assert_eq!(name_of(&fixture, &table.row).await, "Coffee with Ana");

    // A removal goes through the same grant.
    let (code, body) = post!(
        service,
        fixture,
        "/app-write",
        json!({"drive": fixture.drive, "app": app, "op": "remove", "subject": table.row, "properties": [urls::NAME]})
    );
    assert_eq!(code, 200, "{body}");

    // Authored by the app, as every app write is. Checked on a new row: a
    // genesis commit is kept, where a content commit's envelope is not.
    let (code, body) = post!(
        service,
        fixture,
        "/app-write",
        json!({"drive": fixture.drive, "app": app, "op": "create", "parent": table.subject, "isA": [table.row_class], "propVals": { urls::NAME: "Tea" }})
    );
    assert_eq!(code, 200, "{body}");
    let created: Json = serde_json::from_str(&body).unwrap();
    let row = fixture
        .appstate
        .store
        .get_resource(&created["subject"].as_str().unwrap().into())
        .await
        .unwrap();
    let commit = fixture
        .appstate
        .store
        .get_resource(
            &row.get(urls::LAST_COMMIT)
                .unwrap()
                .to_string()
                .as_str()
                .into(),
        )
        .await
        .unwrap();
    let app_agent = fixture
        .appstate
        .store
        .get_app_agent_info(&AppAgentKey::new(&fixture.drive, &app))
        .unwrap()
        .unwrap()
        .agent;
    assert_eq!(commit.get(urls::SIGNER).unwrap().to_string(), app_agent);
}

#[actix_rt::test]
async fn the_grant_records_who_when_and_how() {
    let (fixture, app) = app_fixture("row_grant_record").await;
    let table = table(&fixture, &app, "transactions").await;
    let service = service!(fixture);

    let before = atomic_lib::utils::now();
    let (code, body) = post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table, "add-view")
    );
    assert_eq!(code, 200, "{body}");
    let grant: Json = serde_json::from_str(&body).unwrap();

    let me = fixture
        .appstate
        .store
        .get_default_agent()
        .unwrap()
        .subject
        .to_string();
    assert_eq!(grant["grantedBy"], json!(me));
    assert_eq!(grant["via"], "add-view");
    assert_eq!(grant["view"], json!(table.view));
    assert_eq!(grant["table"], json!(table.subject));
    let at = grant["grantedAt"].as_i64().unwrap();
    assert!(at >= before && at <= atomic_lib::utils::now());
    assert!(grant.get("revokedAt").is_none());

    // Granting again is not a second grant.
    let (_, again) = post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table, "view-type")
    );
    let again: Json = serde_json::from_str(&again).unwrap();
    assert_eq!(again["id"], grant["id"]);

    let grants = status!(service, fixture, &app, table);
    assert_eq!(grants["grant"]["id"], grant["id"]);
    assert_eq!(grants["history"].as_array().unwrap().len(), 1);
}

#[actix_rt::test]
async fn setting_the_view_kind_alone_grants_nothing() {
    let (fixture, app) = app_fixture("row_grant_view_kind").await;
    // The table has a View whose kind names the app, set directly: no menu,
    // no confirmation, no grant.
    let table = table(&fixture, &app, "transactions").await;
    let service = service!(fixture);

    let (code, body) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table.row, urls::NAME, "Nope")
    );
    assert_eq!(code, 400, "{body}");
    assert!(body.contains("requestRowAccess"), "{body}");
    assert_eq!(name_of(&fixture, &table.row).await, "Coffee");

    let grants = status!(service, fixture, &app, table);
    assert!(grants["grant"].is_null());
}

#[actix_rt::test]
async fn a_request_the_person_confirms_lets_the_app_write() {
    let (fixture, app) = app_fixture("row_grant_request").await;
    let table = table(&fixture, &app, "transactions").await;
    let service = service!(fixture);

    let (code, _) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table.row, urls::NAME, "Early")
    );
    assert_eq!(code, 400);

    let (code, body) = post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table, "request")
    );
    assert_eq!(code, 200, "{body}");
    let grant: Json = serde_json::from_str(&body).unwrap();
    assert_eq!(grant["via"], "request");

    let (code, body) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table.row, urls::NAME, "Granted")
    );
    assert_eq!(code, 200, "{body}");
    assert_eq!(name_of(&fixture, &table.row).await, "Granted");
}

#[actix_rt::test]
async fn a_grant_is_not_something_the_page_can_invent() {
    let (fixture, app) = app_fixture("row_grant_refused").await;
    let table = table(&fixture, &app, "transactions").await;
    let other = table_elsewhere(&fixture, &app).await;
    let service = service!(fixture);

    // Only through a gesture.
    let (code, body) = post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table, "because")
    );
    assert_eq!(code, 400, "{body}");

    // Only for a view of this table that shows the app.
    let mut wrong_view = grant_body(&fixture, &app, &table, "add-view");
    wrong_view["view"] = json!(other.view);
    let (code, body) = post!(service, fixture, "/app-row-grant", wrong_view);
    assert_eq!(code, 400, "{body}");

    // Only by someone who can edit the table: read is not enough.
    let onlooker = Agent::new(Some("onlooker")).unwrap();
    share(&fixture, &table.subject, &onlooker, urls::READ).await;
    share(&fixture, &app, &onlooker, urls::WRITE).await;
    let (code, body) = post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table, "add-view"),
        &onlooker
    );
    assert_eq!(code, 400, "{body}");
    assert!(body.contains("can edit this table"), "{body}");
}

/// A second table with its own View of the app and no grant.
async fn table_elsewhere(fixture: &Fixture, app: &str) -> Table {
    table(fixture, app, "statements").await
}

#[actix_rt::test]
async fn the_grant_reaches_rows_of_this_table_and_their_columns_only() {
    let (fixture, app) = app_fixture("row_grant_scope").await;
    let table_a = table(&fixture, &app, "transactions").await;
    let table_b = table_elsewhere(&fixture, &app).await;
    let service = service!(fixture);

    let (code, body) = post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table_a, "add-view")
    );
    assert_eq!(code, 200, "{body}");

    // Another table, even one the app is also a view of.
    let (code, _) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table_b.row, urls::NAME, "x")
    );
    assert_eq!(code, 400);
    assert_eq!(name_of(&fixture, &table_b.row).await, "Coffee");

    // The table's own properties.
    let (code, _) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table_a.subject, urls::NAME, "Renamed")
    );
    assert_eq!(code, 400);
    assert_eq!(name_of(&fixture, &table_a.subject).await, "transactions");

    // Its views, which are children of the table but not rows.
    let (code, _) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table_a.view, urls::NAME, "Mine")
    );
    assert_eq!(code, 400);

    // Rights on a row.
    let (code, body) = post!(
        service,
        fixture,
        "/app-write",
        json!({"drive": fixture.drive, "app": app, "op": "save", "subject": table_a.row, "propVals": { urls::WRITE: [app] }})
    );
    assert_eq!(code, 400, "{body}");

    // A property that is not one of the table's columns.
    let (code, _) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table_a.row, urls::SHORTNAME, "x")
    );
    assert_eq!(code, 400);

    // Deleting a row.
    let (code, body) = post!(
        service,
        fixture,
        "/app-write",
        json!({"drive": fixture.drive, "app": app, "op": "destroy", "subject": table_a.row})
    );
    assert_eq!(code, 400, "{body}");
    assert!(body.contains("delete"), "{body}");

    // A new row must be of the row class, and only that.
    let (code, _) = post!(
        service,
        fixture,
        "/app-write",
        json!({"drive": fixture.drive, "app": app, "op": "create", "parent": table_a.subject, "isA": [urls::TABLE], "propVals": {}})
    );
    assert_eq!(code, 400);
    let (code, body) = post!(
        service,
        fixture,
        "/app-write",
        json!({"drive": fixture.drive, "app": app, "op": "create", "parent": table_a.subject, "isA": [table_a.row_class], "propVals": { urls::NAME: "Tea" }})
    );
    assert_eq!(code, 200, "{body}");
}

#[actix_rt::test]
async fn revoking_from_the_menu_refuses_further_writes() {
    let (fixture, app) = app_fixture("row_grant_revoke_menu").await;
    let table = table(&fixture, &app, "transactions").await;
    let service = service!(fixture);

    post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table, "add-view")
    );

    let (code, body) = post!(
        service,
        fixture,
        "/app-row-grant",
        json!({"op": "revoke", "drive": fixture.drive, "table": table.subject, "app": app, "via": "menu"})
    );
    assert_eq!(code, 200, "{body}");
    let revoked: Json = serde_json::from_str(&body).unwrap();
    assert_eq!(revoked["revokedVia"], "menu");
    assert!(revoked["revokedAt"].is_i64());

    let (code, _) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table.row, urls::NAME, "After")
    );
    assert_eq!(code, 400);

    // The history keeps it.
    let grants = status!(service, fixture, &app, table);
    assert!(grants["grant"].is_null());
    assert_eq!(grants["history"][0]["revokedVia"], "menu");
}

#[actix_rt::test]
async fn removing_the_view_revokes_the_grant() {
    let (fixture, app) = app_fixture("row_grant_revoke_view").await;
    let table = table(&fixture, &app, "transactions").await;
    let service = service!(fixture);
    let store = &fixture.appstate.store;

    post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table, "add-view")
    );

    // What the tab menu's Delete does: the View is destroyed.
    let mut view = store
        .get_resource(&table.view.as_str().into())
        .await
        .unwrap();
    view.destroy(store).await.unwrap();

    let (code, _) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table.row, urls::NAME, "After")
    );
    assert_eq!(code, 400);
    let grants = status!(service, fixture, &app, table);
    assert_eq!(grants["history"][0]["revokedVia"], "view-removed");
}

#[actix_rt::test]
async fn switching_the_view_away_revokes_and_switching_back_does_not_restore() {
    let (fixture, app) = app_fixture("row_grant_revoke_kind").await;
    let table = table(&fixture, &app, "transactions").await;
    let service = service!(fixture);
    let store = &fixture.appstate.store;

    post!(
        service,
        fixture,
        "/app-row-grant",
        grant_body(&fixture, &app, &table, "add-view")
    );

    for kind in ["table", app.as_str()] {
        let mut view = store
            .get_resource(&table.view.as_str().into())
            .await
            .unwrap();
        view.set_unsafe(VIEW_KIND.into(), Value::String(kind.into()))
            .unwrap();
        view.save(store).await.unwrap();
    }

    let (code, _) = post!(
        service,
        fixture,
        "/app-write",
        save_body(&fixture, &app, &table.row, urls::NAME, "After")
    );
    assert_eq!(code, 400);
    let grants = status!(service, fixture, &app, table);
    assert!(grants["grant"].is_null());
    assert_eq!(grants["history"][0]["revokedVia"], "view-kind-changed");
}
