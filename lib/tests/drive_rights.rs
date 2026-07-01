//! Validates the drive-first rights fix for the parent-before-child 401 race:
//! a resource is stamped with its `drive` at genesis, and `check_rights`
//! resolves via that stable drive grant rather than walking the parent chain.
//! Run: cargo test -p atomic_lib --features db-redb --test drive_rights
#![cfg(feature = "db-redb")]

use atomic_lib::{
    agents::ForAgent,
    hierarchy::{check_rights, Right},
    urls, Db, Storelike, Subject,
};

#[tokio::test]
async fn drive_stamped_at_genesis_and_rights_resolve_via_drive() {
    let store = Db::init_temp("drive_rights").await.unwrap();
    let (agent, drive_str) = store.setup("Alice").await.unwrap();

    // Nested creation: a table under the drive, then a row under the table.
    let table = store
        .create_resource(urls::CLASS, &drive_str, "Table", None)
        .await
        .expect("create table");
    let row = store
        .create_resource(urls::CLASS, &table, "Row", None)
        .await
        .expect("create row");

    // 1) Both the table and the row are stamped with the drive at genesis
    //    (table.parent = drive → drive; row.parent = table → table's drive).
    let table_res = store
        .get_resource(&Subject::from(table.clone()))
        .await
        .unwrap();
    assert_eq!(
        table_res.get(urls::DRIVE_PROP).map(|v| v.to_string()).ok(),
        Some(drive_str.clone()),
        "table should be stamped with the drive at genesis"
    );

    let row_res = store
        .get_resource(&Subject::from(row.clone()))
        .await
        .unwrap();
    assert_eq!(
        row_res.get(urls::DRIVE_PROP).map(|v| v.to_string()).ok(),
        Some(drive_str.clone()),
        "row should inherit the drive stamp (not the table) at genesis"
    );

    // 2) The creating agent's write right resolves — via the drive grant, not a
    //    parent walk. (The grant lives on the drive from `setup`.)
    let for_agent = ForAgent::AgentSubject(agent.subject.clone());
    let reason = check_rights(&store, &row_res, &for_agent, Right::Write)
        .await
        .expect("write right should resolve for the row's creator");
    assert!(!reason.is_empty(), "non-empty reason: {reason}");
}
