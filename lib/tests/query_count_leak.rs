//! A query's `count` (and a collection's `totalItems` / `totalPages`) must only
//! ever count rows the requesting agent can read. Otherwise anyone can probe a
//! private value by watching the number change (issue #286): a query for a
//! secret value has to answer exactly what a query for a value that does not
//! exist answers.
//! Run: cargo test -p atomic_lib --features db-redb --test query_count_leak
#![cfg(feature = "db-redb")]

use atomic_lib::{
    agents::ForAgent,
    aggregate::{Aggregate, AggregateFunction, Aggregation},
    collections::CollectionBuilder,
    storelike::{CompositeFilter, PropVal, Query, ValueIn},
    urls, Db, Storelike, Subject, Value,
};

const SECRET: &str = "hunter2";
const SECRET_PROP: &str = urls::DESCRIPTION;

struct Fixture {
    store: Db,
    drive: String,
    bob: ForAgent,
}

/// `secret` rows Bob cannot read and `shared` rows (same secret value) he can.
async fn fixture(name: &str, secret: usize, shared: usize) -> Fixture {
    let store = Db::init_temp(name).await.unwrap();
    let (_alice, drive) = store.setup("Alice").await.unwrap();
    let bob = store.create_agent(Some("Bob")).await.unwrap();
    for i in 0..(secret + shared) {
        let subject = store
            .create_resource(
                urls::FOLDER,
                &drive,
                &format!("row {i:02}"),
                Some(vec![(SECRET_PROP, Value::String(SECRET.into()))]),
            )
            .await
            .unwrap();
        if i >= secret {
            let mut r = store.get_resource(&Subject::from(subject)).await.unwrap();
            r.set_unsafe(
                urls::READ.into(),
                Value::ResourceArray(vec![bob.subject.to_string().into()]),
            )
            .unwrap();
            store
                .add_resource_opts(&r, false, true, true)
                .await
                .unwrap();
        }
    }
    Fixture {
        store,
        drive,
        bob: ForAgent::AgentSubject(bob.subject.clone()),
    }
}

/// Every query path, for `value`: plain index, sorted index, AND filters,
/// composite OR, each with several page shapes.
fn queries(fx: &Fixture, value: &str, agent: &ForAgent) -> Vec<(String, Query)> {
    let drive = Subject::from(fx.drive.clone());
    let val = Value::String(value.into());
    let base = |agent: &ForAgent| Query {
        drive: Some(drive.clone()),
        for_agent: agent.clone(),
        ..Query::new()
    };
    let mut out = Vec::new();
    for (limit, offset) in [(None, 0), (Some(1), 0), (Some(2), 3), (Some(100), 0)] {
        let page = |mut q: Query| {
            q.limit = limit;
            q.offset = offset;
            q
        };
        let mut basic = base(agent);
        basic.property = Some(SECRET_PROP.into());
        basic.value = Some(val.clone());
        out.push((format!("basic {limit:?}/{offset}"), page(basic)));

        let mut sorted = base(agent);
        sorted.property = Some(SECRET_PROP.into());
        sorted.value = Some(val.clone());
        sorted.sort_by = Some(urls::NAME.into());
        out.push((format!("sorted {limit:?}/{offset}"), page(sorted)));

        let mut filtered = base(agent);
        filtered.filters = vec![PropVal {
            property: Some(SECRET_PROP.into()),
            value: Some(val.clone()),
            ..Default::default()
        }];
        out.push((format!("filters {limit:?}/{offset}"), page(filtered)));

        let mut composite = base(agent);
        composite.sort_by = Some(urls::NAME.into());
        composite.composite = CompositeFilter {
            value_in: vec![ValueIn {
                property: SECRET_PROP.into(),
                values: vec![val.clone()],
            }],
            paths: vec![],
        };
        out.push((format!("composite {limit:?}/{offset}"), page(composite)));

        // Nested bodies take the same route through the counting code.
        let mut nested = base(agent);
        nested.property = Some(SECRET_PROP.into());
        nested.value = Some(val.clone());
        nested.include_nested = true;
        out.push((format!("nested {limit:?}/{offset}"), page(nested)));
    }
    out
}

#[tokio::test]
async fn unreadable_rows_are_not_counted_and_look_like_no_match() {
    let fx = fixture("count_leak_all_secret", 7, 0).await;

    for ((label, secret_q), (_, absent_q)) in queries(&fx, SECRET, &fx.bob)
        .into_iter()
        .zip(queries(&fx, "no-such-value", &fx.bob))
    {
        let secret = fx.store.query(&secret_q).await.unwrap();
        let absent = fx.store.query(&absent_q).await.unwrap();
        assert_eq!(secret.count, 0, "{label}: count leaks hidden rows");
        assert_eq!(secret.count, absent.count, "{label}");
        assert!(secret.subjects.is_empty(), "{label}");
        assert!(secret.resources.is_empty(), "{label}");
    }

    // The owner still sees everything.
    let mut q = queries(&fx, SECRET, &ForAgent::Sudo).remove(0).1;
    q.limit = Some(1);
    assert_eq!(fx.store.query(&q).await.unwrap().count, 7);
}

#[tokio::test]
async fn count_is_the_number_of_readable_rows_whatever_the_page() {
    // Hidden rows sort before the readable ones, so every page shape meets some.
    let fx = fixture("count_leak_mixed", 4, 3).await;
    for (label, q) in queries(&fx, SECRET, &fx.bob) {
        let result = fx.store.query(&q).await.unwrap();
        assert_eq!(result.count, 3, "{label}: count must be the readable rows");
    }
}

#[tokio::test]
async fn collection_totals_and_aggregates_ignore_unreadable_rows() {
    let fx = fixture("count_leak_collection", 6, 0).await;

    let builder = |value: &str, page_size: usize| {
        let mut b =
            CollectionBuilder::class_collection(urls::FOLDER, "folders", &fx.store).unwrap();
        b.property = Some(SECRET_PROP.into());
        b.value = Some(value.into());
        b.page_size = page_size;
        b.include_nested = false;
        b.drive = Some(Subject::from(fx.drive.clone()));
        b.aggregation = Some(Aggregation {
            aggregates: vec![Aggregate {
                id: None,
                expression: None,
                property: None,
                function: AggregateFunction::Count,
            }],
            group_by: None,
            now_ms: None,
        });
        b
    };

    for page_size in [1, 2, 50] {
        let secret = builder(SECRET, page_size)
            .into_collection(&fx.store, &fx.bob)
            .await
            .unwrap();
        let absent = builder("no-such-value", page_size)
            .into_collection(&fx.store, &fx.bob)
            .await
            .unwrap();
        assert_eq!(secret.total_items, 0, "page size {page_size}");
        assert_eq!(secret.total_pages, 0, "page size {page_size}");
        assert_eq!(secret.total_items, absent.total_items);
        assert_eq!(secret.total_pages, absent.total_pages);
        assert!(secret.members.is_empty());
    }

    // Aggregates go through `matching_subjects`.
    let mut q = Query {
        property: Some(SECRET_PROP.into()),
        value: Some(Value::String(SECRET.into())),
        drive: Some(Subject::from(fx.drive.clone())),
        for_agent: fx.bob.clone(),
        limit: Some(1),
        ..Query::new()
    };
    q.aggregation = builder(SECRET, 1).aggregation;
    let result = fx.store.query(&q).await.unwrap();
    assert_eq!(result.count, 0);
    assert_eq!(result.aggregates[0].count, 0);
}
