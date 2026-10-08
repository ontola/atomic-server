//! OR groups (`value_in`) and filters over related resources (path filters).
//!
//! Both are answered from the existing property/value and reverse-reference
//! indexes, ANDed with everything else in the query, and never reveal rows (or
//! related rows) the querying agent cannot read.
//! Run: cargo test -p atomic_lib --features db-redb --test query_composite
#![cfg(feature = "db-redb")]

use atomic_lib::{
    agents::ForAgent,
    collections::CollectionBuilder,
    storelike::{CompositeFilter, PathFilter, Query, ValueIn},
    urls, Db, Resource, Storelike, Subject, Value,
};

fn strings(values: &[&str]) -> Vec<Value> {
    values.iter().map(|v| Value::String((*v).into())).collect()
}

fn names_in(values: &[&str]) -> ValueIn {
    ValueIn {
        property: urls::NAME.into(),
        values: strings(values),
    }
}

/// Children whose parent has one of `parent_names`.
fn parent_named(parent_names: &[&str]) -> PathFilter {
    PathFilter {
        via: urls::PARENT.into(),
        target: names_in(parent_names),
    }
}

fn drive_query(drive: &str, composite: CompositeFilter) -> Query {
    Query {
        drive: Some(Subject::from(drive.to_string())),
        sort_by: Some(urls::NAME.into()),
        include_nested: false,
        composite,
        ..Query::new()
    }
}

async fn names(store: &Db, q: &Query) -> Vec<String> {
    let result = store.query(q).await.unwrap();
    let mut out = Vec::new();
    for subject in &result.subjects {
        let r = store.get_resource(subject).await.unwrap();
        out.push(r.get(urls::NAME).unwrap().to_string());
    }
    out
}

struct Fixture {
    store: Db,
    drive: String,
    /// "Alpha", "Beta", "Gamma" folders.
    folders: Vec<String>,
}

/// Three folders, each holding two children: `a1 a2`, `b1 b2`, `c1 c2`.
async fn fixture(name: &str) -> Fixture {
    let store = Db::init_temp(name).await.unwrap();
    let (_alice, drive) = store.setup("Alice").await.unwrap();
    let mut folders = Vec::new();
    for (folder, kids) in [
        ("Alpha", ["a1", "a2"]),
        ("Beta", ["b1", "b2"]),
        ("Gamma", ["c1", "c2"]),
    ] {
        let f = store
            .create_resource(urls::FOLDER, &drive, folder, None)
            .await
            .unwrap();
        for kid in kids {
            store
                .create_resource(urls::FOLDER, &f, kid, None)
                .await
                .unwrap();
        }
        folders.push(f);
    }
    Fixture {
        store,
        drive,
        folders,
    }
}

#[tokio::test]
async fn value_in_is_an_or_over_values() {
    let fx = fixture("composite_value_in").await;
    let q = drive_query(
        &fx.drive,
        CompositeFilter {
            value_in: vec![names_in(&["a1", "b2", "nope"])],
            paths: vec![],
        },
    );
    assert_eq!(names(&fx.store, &q).await, ["a1", "b2"]);

    // Descending + paging, count unaffected by the page.
    let mut q = drive_query(
        &fx.drive,
        CompositeFilter {
            value_in: vec![names_in(&["a1", "b1", "c1", "c2"])],
            paths: vec![],
        },
    );
    q.sort_desc = true;
    q.limit = Some(2);
    q.offset = 1;
    let result = fx.store.query(&q).await.unwrap();
    assert_eq!(result.count, 4);
    assert_eq!(result.subjects.len(), 2);
    assert_eq!(names(&fx.store, &q).await, ["c1", "b1"]);
}

#[tokio::test]
async fn value_in_is_anded_with_other_constraints_and_clauses() {
    let fx = fixture("composite_value_in_and").await;
    // AND with a plain constraint: only Alpha's children.
    let mut q = drive_query(
        &fx.drive,
        CompositeFilter {
            value_in: vec![names_in(&["a1", "b1"])],
            paths: vec![],
        },
    );
    q.property = Some(urls::PARENT.into());
    q.value = Some(Value::AtomicUrl(fx.folders[0].clone().into()));
    assert_eq!(names(&fx.store, &q).await, ["a1"]);

    // Two clauses are ANDed with each other.
    let q = drive_query(
        &fx.drive,
        CompositeFilter {
            value_in: vec![
                names_in(&["a1", "b1", "b2"]),
                ValueIn {
                    property: urls::PARENT.into(),
                    values: vec![Value::AtomicUrl(fx.folders[1].clone().into())],
                },
            ],
            paths: vec![],
        },
    );
    assert_eq!(names(&fx.store, &q).await, ["b1", "b2"]);
}

#[tokio::test]
async fn path_filter_follows_a_reference() {
    let fx = fixture("composite_path").await;
    let q = drive_query(
        &fx.drive,
        CompositeFilter {
            value_in: vec![],
            paths: vec![parent_named(&["Alpha", "Beta"])],
        },
    );
    assert_eq!(names(&fx.store, &q).await, ["a1", "a2", "b1", "b2"]);

    // Combined with an OR on the row itself.
    let q = drive_query(
        &fx.drive,
        CompositeFilter {
            value_in: vec![names_in(&["a2", "c1"])],
            paths: vec![parent_named(&["Alpha", "Beta"])],
        },
    );
    assert_eq!(names(&fx.store, &q).await, ["a2"]);

    // Index-backed, so a change to the related resource shows up immediately.
    let mut beta = fx
        .store
        .get_resource(&Subject::from(fx.folders[1].clone()))
        .await
        .unwrap();
    beta.set_unsafe(urls::NAME.into(), Value::String("Delta".into()))
        .unwrap();
    fx.store
        .add_resource_opts(&beta, false, true, true)
        .await
        .unwrap();
    let q = drive_query(
        &fx.drive,
        CompositeFilter {
            value_in: vec![],
            paths: vec![parent_named(&["Beta"])],
        },
    );
    assert!(names(&fx.store, &q).await.is_empty());
    let q = drive_query(
        &fx.drive,
        CompositeFilter {
            value_in: vec![],
            paths: vec![parent_named(&["Delta"])],
        },
    );
    assert_eq!(names(&fx.store, &q).await, ["b1", "b2"]);
}

#[tokio::test]
async fn path_filter_respects_read_rights_of_both_rows() {
    let fx = fixture("composite_path_rights").await;
    let bob = fx.store.create_agent(Some("Bob")).await.unwrap();
    let bob_agent = ForAgent::AgentSubject(bob.subject.clone());

    let q_for = |agent: &ForAgent| {
        let mut q = drive_query(
            &fx.drive,
            CompositeFilter {
                value_in: vec![],
                paths: vec![parent_named(&["Alpha", "Beta"])],
            },
        );
        q.for_agent = agent.clone();
        q
    };

    // No grants: nothing.
    assert!(names(&fx.store, &q_for(&bob_agent)).await.is_empty());

    // Bob may read Alpha (and so its children, by inheritance), not Beta.
    let grant = |subject: String| {
        let store = &fx.store;
        let bob = bob.subject.to_string();
        async move {
            let mut r: Resource = store.get_resource(&Subject::from(subject)).await.unwrap();
            r.set_unsafe(urls::READ.into(), Value::ResourceArray(vec![bob.into()]))
                .unwrap();
            store
                .add_resource_opts(&r, false, true, true)
                .await
                .unwrap();
        }
    };
    grant(fx.folders[0].clone()).await;
    assert_eq!(names(&fx.store, &q_for(&bob_agent)).await, ["a1", "a2"]);

    // Bob reads Beta's child b1 directly but not Beta itself: b1 must not be
    // matchable through a property of a resource Bob can't see.
    let b1 = fx
        .store
        .query(&drive_query(
            &fx.drive,
            CompositeFilter {
                value_in: vec![names_in(&["b1"])],
                paths: vec![],
            },
        ))
        .await
        .unwrap()
        .subjects
        .remove(0);
    grant(b1.to_string()).await;
    assert_eq!(names(&fx.store, &q_for(&bob_agent)).await, ["a1", "a2"]);

    // The same plain OR query still shows b1: it IS readable.
    let mut q = drive_query(
        &fx.drive,
        CompositeFilter {
            value_in: vec![names_in(&["b1", "b2"])],
            paths: vec![],
        },
    );
    q.for_agent = bob_agent;
    assert_eq!(names(&fx.store, &q).await, ["b1"]);
}

#[tokio::test]
async fn collection_builder_carries_composite_filters() {
    let fx = fixture("composite_collection").await;
    let builder = CollectionBuilder {
        subject: "http://localhost/query".into(),
        property: None,
        value: None,
        filters: vec![],
        sort_by: Some(urls::NAME.into()),
        sort_desc: false,
        current_page: 0,
        page_size: 10,
        name: None,
        include_nested: false,
        include_external: false,
        drive: Some(Subject::from(fx.drive.clone())),
        aggregation: None,
        expression_filters: vec![],
        composite: CompositeFilter {
            value_in: vec![names_in(&["a1", "c2", "b2"])],
            paths: vec![parent_named(&["Alpha", "Gamma"])],
        },
    };
    let collection =
        atomic_lib::collections::Collection::collect_members(&fx.store, builder, &ForAgent::Sudo)
            .await
            .unwrap();
    assert_eq!(collection.total_items, 2);
}
