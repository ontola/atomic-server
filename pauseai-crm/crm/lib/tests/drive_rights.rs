//! Validates the drive-first rights fix for the parent-before-child 401 race:
//! a resource is stamped with its `drive` at genesis, and `check_rights`
//! resolves via that stable drive grant rather than walking the parent chain.
//! Run: cargo test -p atomic_lib --features db-redb --test drive_rights
#![cfg(feature = "db-redb")]

use atomic_lib::{
    agents::ForAgent,
    hierarchy::{check_append, check_rights, Right},
    urls, Db, Resource, Storelike, Subject, Value,
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

/// An external commenter gets explicit read + append grants on a discussion
/// ChatRoom. Append lets them post Messages (children) without any write
/// rights on the chatroom or the drive.
#[tokio::test]
async fn external_commenter_appends_to_chatroom_without_drive_rights() {
    let store = Db::init_temp("external_commenter").await.unwrap();
    let (_alice, drive) = store.setup("Alice").await.unwrap();
    let bob = store.create_agent(Some("Bob")).await.unwrap();
    let carol = store.create_agent(Some("Carol")).await.unwrap();

    let chatroom = store
        .create_resource(urls::CHATROOM, &drive, "Comments", None)
        .await
        .expect("create chatroom");

    // Grant Bob read + append on the chatroom only.
    let mut chat_res = store
        .get_resource(&Subject::from(chatroom.clone()))
        .await
        .unwrap();
    chat_res
        .set_unsafe(
            urls::READ.into(),
            Value::ResourceArray(vec![bob.subject.to_string().into()]),
        )
        .unwrap();
    chat_res
        .set_unsafe(
            urls::APPEND.into(),
            Value::ResourceArray(vec![bob.subject.to_string().into()]),
        )
        .unwrap();
    store
        .add_resource_opts(&chat_res, false, true, true)
        .await
        .unwrap();

    // An unsaved Message whose parent is the chatroom.
    let mut message = Resource::new("http://localhost/new-message".into());
    message
        .set_unsafe(
            urls::PARENT.into(),
            Value::AtomicUrl(chatroom.clone().into()),
        )
        .unwrap();

    let bob_agent = ForAgent::AgentSubject(bob.subject.clone());
    check_append(&store, &message, &bob_agent)
        .await
        .expect("append grant on the chatroom should let Bob post a message");

    // Bob cannot edit the chatroom itself, nor anything else in the drive.
    assert!(
        check_rights(&store, &chat_res, &bob_agent, Right::Write)
            .await
            .is_err(),
        "append+read must not imply write on the chatroom"
    );
    let drive_res = store.get_resource(&Subject::from(drive)).await.unwrap();
    assert!(
        check_rights(&store, &drive_res, &bob_agent, Right::Write)
            .await
            .is_err(),
        "Bob must not gain drive-level rights"
    );

    // Carol has no grants at all and cannot post.
    let carol_agent = ForAgent::AgentSubject(carol.subject.clone());
    assert!(
        check_append(&store, &message, &carol_agent).await.is_err(),
        "without grants, appending to the chatroom must fail"
    );
}
