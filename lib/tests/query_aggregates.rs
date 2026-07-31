//! A query can ask the store for statistics over **every** row it matches, so a
//! client gets "sum of Amount: 615" without fetching the rows to add them up.
//! The numbers must summarize exactly the filtered set — never the page, never
//! more than the filter allows — and a breakdown must add back up to the total.
//! Run: cargo test -p atomic_lib --features db-redb --test query_aggregates
#![cfg(feature = "db-redb")]

use atomic_lib::{
    agents::ForAgent,
    aggregate::{Aggregate, AggregateFunction, AggregateGrouping, Aggregation, GroupGranularity},
    storelike::{PropVal, Query},
    urls, Db, Storelike, Subject, Value,
};

/// Stands in for an "amount" column: any INTEGER property will do, and
/// `filesize` is one that exists in every store's defaults.
const AMOUNT: &str = urls::FILESIZE;
/// Stands in for a "category" select column: an AtomicUrl the rows share.
const CATEGORY: &str = urls::PARENT;
const SPENT_AT: &str = urls::CREATED_AT;

/// A query over the children of `table`, with the given aggregation.
fn query_for(table: &str, aggregation: Aggregation, limit: Option<usize>) -> Query {
    Query {
        property: Some(urls::PARENT.into()),
        value: Some(Value::AtomicUrl(table.to_string().into())),
        filters: Vec::new(),
        limit,
        start_val: None,
        end_val: None,
        offset: 0,
        sort_by: Some(urls::SORT_ORDER.into()),
        sort_desc: false,
        include_external: false,
        include_nested: false,
        for_agent: ForAgent::Sudo,
        drive: Some(atomic_lib::db::drive_prefix_from_subject(&Subject::from(
            table.to_string(),
        ))),
        aggregation: Some(aggregation),
    }
}

fn sum_of(property: &str) -> Aggregate {
    Aggregate {
        property: Some(property.into()),
        function: AggregateFunction::Sum,
    }
}

#[tokio::test]
async fn totals_cover_every_matching_row_not_just_the_page() {
    let store = Db::init_temp("aggregates_totals").await.unwrap();
    let (_agent, drive) = store.setup("Alice").await.unwrap();

    let table = store
        .create_resource(urls::FOLDER, &drive, "Expenses", None)
        .await
        .unwrap();

    for amount in [100, 250, 15, 250] {
        store
            .create_resource(
                urls::FOLDER,
                &table,
                &format!("Expense {amount}"),
                Some(vec![(AMOUNT, Value::Integer(amount))]),
            )
            .await
            .unwrap();
    }

    // A page of one row — the totals must ignore the paging entirely.
    let result = store
        .query(&query_for(
            &table,
            Aggregation {
                aggregates: vec![
                    sum_of(AMOUNT),
                    Aggregate {
                        property: Some(AMOUNT.into()),
                        function: AggregateFunction::Avg,
                    },
                    Aggregate {
                        property: Some(AMOUNT.into()),
                        function: AggregateFunction::Min,
                    },
                    Aggregate {
                        property: Some(AMOUNT.into()),
                        function: AggregateFunction::Max,
                    },
                    Aggregate {
                        property: None,
                        function: AggregateFunction::Count,
                    },
                ],
                group_by: None,
            },
            Some(1),
        ))
        .await
        .unwrap();

    assert_eq!(result.subjects.len(), 1, "the page is still one row");
    let values: Vec<Option<f64>> = result.aggregates.iter().map(|a| a.value).collect();
    assert_eq!(
        values,
        vec![
            Some(615.0),
            Some(153.75),
            Some(15.0),
            Some(250.0),
            Some(4.0)
        ],
        "sum / avg / min / max / count over all four rows"
    );
}

#[tokio::test]
async fn a_filtered_query_only_totals_what_it_matches() {
    let store = Db::init_temp("aggregates_filtered").await.unwrap();
    let (_agent, drive) = store.setup("Alice").await.unwrap();

    let table = store
        .create_resource(urls::FOLDER, &drive, "Expenses", None)
        .await
        .unwrap();
    let other = store
        .create_resource(urls::FOLDER, &drive, "Other table", None)
        .await
        .unwrap();

    for (parent, amount) in [(&table, 40), (&table, 60), (&other, 1000)] {
        store
            .create_resource(
                urls::FOLDER,
                parent,
                &format!("Row {amount}"),
                Some(vec![(AMOUNT, Value::Integer(amount))]),
            )
            .await
            .unwrap();
    }

    let result = store
        .query(&query_for(
            &table,
            Aggregation {
                aggregates: vec![sum_of(AMOUNT)],
                group_by: None,
            },
            None,
        ))
        .await
        .unwrap();

    assert_eq!(
        result.aggregates[0].value,
        Some(100.0),
        "the other table's 1000 must not leak into this table's total"
    );

    // Narrowing further with an extra constraint narrows the total with it.
    let mut narrowed = query_for(
        &table,
        Aggregation {
            aggregates: vec![sum_of(AMOUNT)],
            group_by: None,
        },
        None,
    );
    narrowed.filters = vec![PropVal {
        property: Some(AMOUNT.into()),
        value: Some(Value::Integer(60)),
        operator: atomic_lib::storelike::FilterOperator::GreaterThanOrEqual,
    }];

    let result = store.query(&narrowed).await.unwrap();
    assert_eq!(
        result.aggregates[0].value,
        Some(60.0),
        "only the rows the filter keeps are summed"
    );
}

#[tokio::test]
async fn a_breakdown_splits_the_total_per_group() {
    let store = Db::init_temp("aggregates_breakdown").await.unwrap();
    let (_agent, drive) = store.setup("Alice").await.unwrap();

    let table = store
        .create_resource(urls::FOLDER, &drive, "Expenses", None)
        .await
        .unwrap();
    let groceries = store
        .create_resource(urls::FOLDER, &table, "Groceries", None)
        .await
        .unwrap();
    let travel = store
        .create_resource(urls::FOLDER, &table, "Travel", None)
        .await
        .unwrap();

    // Rows live under the category so `parent` doubles as the category column.
    for (category, amount) in [
        (&groceries, 10),
        (&groceries, 20),
        (&travel, 300),
        (&travel, 100),
    ] {
        store
            .create_resource(
                urls::FOLDER,
                category,
                &format!("Row {amount}"),
                Some(vec![(AMOUNT, Value::Integer(amount))]),
            )
            .await
            .unwrap();
    }

    // Everything under the table, one level down: query the categories' rows by
    // asking for both parents at once is not expressible, so query per category
    // and group by `parent` — the shape a "sum per category" breakdown has.
    let mut query = query_for(
        &groceries,
        Aggregation {
            aggregates: vec![sum_of(AMOUNT)],
            group_by: Some(AggregateGrouping {
                property: CATEGORY.into(),
                granularity: GroupGranularity::Exact,
                tz_offset_minutes: 0,
                limit: None,
            }),
        },
        None,
    );
    query.value = Some(Value::AtomicUrl(groceries.clone().into()));

    let result = store.query(&query).await.unwrap();
    let outcome = &result.aggregates[0];

    assert_eq!(outcome.value, Some(30.0), "the total for this category");
    assert_eq!(outcome.groups.len(), 1, "one bucket: the category itself");
    assert_eq!(outcome.groups[0].value, Some(30.0));
    assert_eq!(outcome.groups[0].count, 2);
    assert!(
        outcome.groups[0].key.contains(&groceries),
        "the bucket key is the grouping value: {}",
        outcome.groups[0].key
    );

    // Groups always add back up to the total — the invariant that makes a
    // breakdown trustworthy.
    let summed_groups: f64 = outcome.groups.iter().filter_map(|g| g.value).sum();
    assert_eq!(summed_groups, outcome.value.unwrap());
}

#[tokio::test]
async fn a_breakdown_by_day_buckets_timestamps() {
    let store = Db::init_temp("aggregates_by_day").await.unwrap();
    let (_agent, drive) = store.setup("Alice").await.unwrap();

    let table = store
        .create_resource(urls::FOLDER, &drive, "Hours", None)
        .await
        .unwrap();

    // Three entries across two days (millis since the epoch).
    let day_one = 1_785_400_000_000; // 2026-07-30
    let day_two = day_one + 86_400_000;

    for (stamp, amount) in [(day_one, 2), (day_one, 3), (day_two, 5)] {
        store
            .create_resource(
                urls::FOLDER,
                &table,
                &format!("Entry {stamp}-{amount}"),
                Some(vec![
                    (AMOUNT, Value::Integer(amount)),
                    (SPENT_AT, Value::Timestamp(stamp)),
                ]),
            )
            .await
            .unwrap();
    }

    let result = store
        .query(&query_for(
            &table,
            Aggregation {
                aggregates: vec![sum_of(AMOUNT)],
                group_by: Some(AggregateGrouping {
                    property: SPENT_AT.into(),
                    granularity: GroupGranularity::Day,
                    tz_offset_minutes: 0,
                    limit: None,
                }),
            },
            None,
        ))
        .await
        .unwrap();

    let outcome = &result.aggregates[0];
    assert_eq!(outcome.value, Some(10.0));

    let buckets: Vec<(String, Option<f64>)> = outcome
        .groups
        .iter()
        .map(|g| (g.key.clone(), g.value))
        .collect();

    assert_eq!(
        buckets,
        vec![
            ("2026-07-30".to_string(), Some(5.0)),
            ("2026-07-31".to_string(), Some(5.0)),
        ],
        "day buckets read chronologically, one per calendar day"
    );
}

#[tokio::test]
async fn rows_without_a_value_are_counted_but_do_not_change_the_sum() {
    let store = Db::init_temp("aggregates_missing").await.unwrap();
    let (_agent, drive) = store.setup("Alice").await.unwrap();

    let table = store
        .create_resource(urls::FOLDER, &drive, "Expenses", None)
        .await
        .unwrap();

    store
        .create_resource(
            urls::FOLDER,
            &table,
            "With amount",
            Some(vec![(AMOUNT, Value::Integer(70))]),
        )
        .await
        .unwrap();
    store
        .create_resource(urls::FOLDER, &table, "Without amount", None)
        .await
        .unwrap();

    let result = store
        .query(&query_for(
            &table,
            Aggregation {
                aggregates: vec![
                    sum_of(AMOUNT),
                    Aggregate {
                        property: None,
                        function: AggregateFunction::Count,
                    },
                ],
                group_by: None,
            },
            None,
        ))
        .await
        .unwrap();

    assert_eq!(
        result.aggregates[0].value,
        Some(70.0),
        "sum ignores the gap"
    );
    assert_eq!(
        result.aggregates[0].count, 1,
        "and reports how many rows actually contributed"
    );
    assert_eq!(
        result.aggregates[1].value,
        Some(2.0),
        "count still counts every matching row"
    );
}

#[tokio::test]
async fn an_empty_set_has_no_sum_but_counts_zero() {
    let store = Db::init_temp("aggregates_empty").await.unwrap();
    let (_agent, drive) = store.setup("Alice").await.unwrap();

    let table = store
        .create_resource(urls::FOLDER, &drive, "Nothing here", None)
        .await
        .unwrap();

    let result = store
        .query(&query_for(
            &table,
            Aggregation {
                aggregates: vec![
                    sum_of(AMOUNT),
                    Aggregate {
                        property: None,
                        function: AggregateFunction::Count,
                    },
                ],
                group_by: None,
            },
            None,
        ))
        .await
        .unwrap();

    // `None` and `0` are different answers: nothing to sum vs. a sum of zero.
    assert_eq!(result.aggregates[0].value, None);
    assert_eq!(result.aggregates[1].value, Some(0.0));
}

#[tokio::test]
async fn a_query_without_aggregation_returns_none() {
    let store = Db::init_temp("aggregates_absent").await.unwrap();
    let (_agent, drive) = store.setup("Alice").await.unwrap();

    let table = store
        .create_resource(urls::FOLDER, &drive, "Expenses", None)
        .await
        .unwrap();
    store
        .create_resource(urls::FOLDER, &table, "A row", None)
        .await
        .unwrap();

    let mut query = query_for(
        &table,
        Aggregation {
            aggregates: vec![],
            group_by: None,
        },
        None,
    );
    query.aggregation = None;

    let result = store.query(&query).await.unwrap();
    assert!(
        result.aggregates.is_empty(),
        "asking for nothing computes nothing"
    );
    assert_eq!(result.subjects.len(), 1, "the query itself still works");
}
