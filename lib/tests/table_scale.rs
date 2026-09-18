//! Table-scale stress: create N child resources under a parent (the shape a
//! Table's row collection queries) and time the store paths that open, page,
//! sort, and total that table.
//!
//! Not a pass/fail regression. Prints a per-N breakdown so we can tell whether
//! the cost is the write (redb / Loro snapshot / index), the query (count
//! walk, QueryMembers rebuild, nested bodies), or JSON-AD serialisation — the
//! same three layers the browser's OPFS ClientDb, `Collection.fetchPageFromLocalDb`,
//! and the table grid sit on.
//!
//! Run:
//!   cargo test -p atomic_lib --features db-redb --test table_scale -- --ignored --nocapture
//!
//! Optional:
//!   TABLE_STRESS_N=100000          max rows (default 100000)
//!   TABLE_STRESS_FULL_BODIES=1     also fetch+serialise every nested body at the
//!                                  largest N (very heavy; skipped by default
//!                                  above 10k)
#![cfg(feature = "db-redb")]

use std::time::{Duration, Instant};

use atomic_lib::{
    agents::ForAgent,
    aggregate::{Aggregate, AggregateFunction, Aggregation},
    db::trees::Tree,
    storelike::{FilterOperator, PropVal, Query, QueryResult},
    urls, Db, Storelike, Subject, Value,
};

const PAGE: usize = 30;
const AMOUNT: &str = urls::FILESIZE;

fn max_n() -> usize {
    std::env::var("TABLE_STRESS_N")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000)
}

fn want_full_bodies(n: usize) -> bool {
    n <= 10_000 || std::env::var("TABLE_STRESS_FULL_BODIES").is_ok()
}

fn checkpoints(max: usize) -> Vec<usize> {
    let mut out = vec![1_000, 10_000, 100_000]
        .into_iter()
        .filter(|&n| n <= max)
        .collect::<Vec<_>>();
    if out.last().copied() != Some(max) {
        out.push(max);
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn table_query(table: &str, class: &str, drive: &Subject) -> Query {
    Query {
        property: Some(urls::PARENT.into()),
        value: Some(Value::AtomicUrl(table.to_string().into())),
        filters: vec![PropVal {
            property: Some(urls::IS_A.into()),
            value: Some(Value::AtomicUrl(class.into())),
            operator: FilterOperator::Equal,
        }],
        expression_filters: Vec::new(),
        limit: None,
        start_val: None,
        end_val: None,
        offset: 0,
        sort_by: None,
        sort_desc: false,
        include_external: false,
        include_nested: false,
        for_agent: ForAgent::Sudo,
        drive: Some(drive.clone()),
        aggregation: None,
    }
}

async fn time_query(store: &Db, q: Query) -> (Duration, QueryResult) {
    let start = Instant::now();
    let result = store.query(&q).await.unwrap();
    (start.elapsed(), result)
}

fn ms(d: Duration) -> String {
    format!("{:.1}", d.as_secs_f64() * 1000.0)
}

fn json_ad_bytes(store: &Db, subjects: &[Subject], n: usize) -> (Duration, usize) {
    let start = Instant::now();
    let mut bytes = 0usize;
    for subject in subjects.iter().take(n) {
        let resource = store.get_resource_shallow(subject).unwrap();
        bytes += resource.to_json_ad(None).unwrap().len();
    }
    (start.elapsed(), bytes)
}

fn json_ad_of_resources(resources: &[atomic_lib::Resource]) -> (Duration, usize) {
    let start = Instant::now();
    let mut bytes = 0usize;
    for resource in resources {
        bytes += resource.to_json_ad(None).unwrap().len();
    }
    (start.elapsed(), bytes)
}

fn tree_counts(store: &Db) -> Vec<(&'static str, usize)> {
    let trees = [
        (Tree::Resources, "Resources"),
        (Tree::PropValSub, "PropValSub"),
        (Tree::ValPropSub, "ValPropSub"),
        (Tree::QueryMembers, "QueryMembers"),
        (Tree::WatchedQueries, "WatchedQueries"),
        (Tree::LoroSnapshots, "LoroSnapshots"),
        (Tree::Envelopes, "Envelopes"),
        (Tree::SearchPostings, "SearchPostings"),
        (Tree::SearchDocs, "SearchDocs"),
        (Tree::SearchDocTokens, "SearchDocTokens"),
        (Tree::SearchTrigrams, "SearchTrigrams"),
    ];
    trees
        .into_iter()
        .map(|(tree, name)| (name, store.kv.len(tree).unwrap_or(0)))
        .collect()
}

fn file_bytes(id: &str) -> Option<u64> {
    std::fs::metadata(format!(".temp/db/{id}/atomic.redb"))
        .ok()
        .map(|m| m.len())
}

async fn measure_at(store: &Db, table: &str, class: &str, drive: &Subject, n: usize, db_id: &str) {
    println!("\n=== N={n} rows ===");

    // What Collection.fetchPageFromLocalDb actually does for a table:
    // parent + isA extra filter, no sort_by, no limit, include_nested = true.
    // First call builds QueryMembers; the second is an index hit.
    let (first, first_res) = time_query(store, {
        let mut q = table_query(table, class, drive);
        q.include_nested = true;
        q
    })
    .await;
    println!(
        "  collection-open (nested, unpaged, 1st / index-build)  {:>8} ms   subjects={} bodies={} count={}",
        ms(first),
        first_res.subjects.len(),
        first_res.resources.len(),
        first_res.count
    );
    if !first_res.resources.is_empty() && want_full_bodies(n) {
        let (ser_t, ser_b) = json_ad_of_resources(&first_res.resources);
        println!(
            "    json-ad of those nested bodies (incl. loroUpdate)   {:>8} ms   {} bytes ({:.1} KB/row)",
            ms(ser_t),
            ser_b,
            ser_b as f64 / first_res.resources.len() as f64 / 1024.0
        );
    }

    let (second, second_res) = time_query(store, {
        let mut q = table_query(table, class, drive);
        q.include_nested = true;
        q
    })
    .await;
    println!(
        "  collection-open (nested, unpaged, 2nd / index-hit)    {:>8} ms   subjects={} bodies={}",
        ms(second),
        second_res.subjects.len(),
        second_res.resources.len()
    );

    // Subjects only, still unpaged: isolates index walk + count from body
    // materialisation (the WASM layer currently asks for bodies).
    let mut subjects_all = table_query(table, class, drive);
    subjects_all.include_nested = false;
    let (subj_all, subj_all_res) = time_query(store, subjects_all).await;
    println!(
        "  subjects-only unpaged                                 {:>8} ms   count={}",
        ms(subj_all),
        subj_all_res.count
    );

    // The page the grid actually renders: 30 nested bodies.
    let mut page = table_query(table, class, drive);
    page.include_nested = true;
    page.limit = Some(PAGE);
    let (page_t, page_res) = time_query(store, page).await;
    println!(
        "  nested page of {PAGE} (still walks for totalMembers)    {:>8} ms   page={} count={}",
        ms(page_t),
        page_res.subjects.len(),
        page_res.count
    );

    // Subjects-only page: what a cursor/`hasMore` query could return.
    let mut page_subj = table_query(table, class, drive);
    page_subj.include_nested = false;
    page_subj.limit = Some(PAGE);
    let (page_subj_t, page_subj_res) = time_query(store, page_subj).await;
    println!(
        "  subjects-only page of {PAGE}                            {:>8} ms   page={} count={}",
        ms(page_subj_t),
        page_subj_res.subjects.len(),
        page_subj_res.count
    );

    // Default table sort (`sortOrder`). Collection currently sorts in JS
    // because WASM DID-drive sort is broken; this is the server/index path.
    let mut sorted = table_query(table, class, drive);
    sorted.sort_by = Some(urls::SORT_ORDER.into());
    sorted.include_nested = false;
    sorted.limit = Some(PAGE);
    let (sorted_t, sorted_res) = time_query(store, sorted).await;
    println!(
        "  sorted (sortOrder) subjects page of {PAGE}              {:>8} ms   page={} count={}",
        ms(sorted_t),
        sorted_res.subjects.len(),
        sorted_res.count
    );

    // Totals: the extra pass `compute_aggregation` makes over every match.
    let mut totals = table_query(table, class, drive);
    totals.limit = Some(1);
    totals.aggregation = Some(Aggregation {
        aggregates: vec![
            Aggregate {
                id: Some("count".into()),
                property: None,
                expression: None,
                function: AggregateFunction::Count,
            },
            Aggregate {
                id: Some("sum".into()),
                property: Some(AMOUNT.into()),
                expression: None,
                function: AggregateFunction::Sum,
            },
        ],
        group_by: None,
        now_ms: None,
    });
    let (agg_t, agg_res) = time_query(store, totals).await;
    let agg_summary = agg_res
        .aggregates
        .iter()
        .map(|o| format!("{}={:?}", o.id.as_deref().unwrap_or("?"), o.value))
        .collect::<Vec<_>>()
        .join(" ");
    println!(
        "  aggregation (count + sum, page_size=1)                {:>8} ms   {}",
        ms(agg_t),
        agg_summary
    );

    // JSON-AD of the visible page vs (optionally) every body — the worker →
    // main-thread payload Collection hydrates for client-side sort.
    let (page_ser, page_bytes) = json_ad_bytes(store, &page_res.subjects, PAGE);
    println!(
        "  json-ad serialize {PAGE} shallow rows                   {:>8} ms   {} bytes",
        ms(page_ser),
        page_bytes
    );
    if !page_res.resources.is_empty() {
        let (nested_t, nested_b) = json_ad_of_resources(&page_res.resources);
        println!(
            "  json-ad serialize {PAGE} nested bodies (loroUpdate)     {:>8} ms   {} bytes",
            ms(nested_t),
            nested_b
        );
    }

    if want_full_bodies(n) && !second_res.subjects.is_empty() {
        let take = second_res.subjects.len().min(n);
        let (all_ser, all_bytes) = json_ad_bytes(store, &second_res.subjects, take);
        println!(
            "  json-ad serialize {take} shallow rows (all matches)     {:>8} ms   {} bytes ({:.1} KB/row)",
            ms(all_ser),
            all_bytes,
            all_bytes as f64 / take as f64 / 1024.0
        );
    } else {
        println!(
            "  json-ad serialize all matches                        skipped (set TABLE_STRESS_FULL_BODIES=1)"
        );
    }

    store.flush().unwrap();
    if let Some(bytes) = file_bytes(db_id) {
        println!(
            "  redb file                                           {:>10} bytes ({:.1} MB, {:.0} bytes/row)",
            bytes,
            bytes as f64 / 1_048_576.0,
            bytes as f64 / n as f64
        );
    }
    for (name, count) in tree_counts(store) {
        if count == 0 {
            continue;
        }
        println!("  tree {name:<16} {count:>10}");
    }
}

#[tokio::test]
#[ignore = "perf measurement, run explicitly with --ignored --nocapture"]
async fn table_scale_create_and_query() {
    let max = max_n();
    let db_id = format!("table_scale_{max}");
    let store = Db::init_temp(&db_id).await.unwrap();
    let (_agent, drive) = store.setup("TableScale").await.unwrap();
    let drive_subject = atomic_lib::db::drive_prefix_from_subject(&Subject::from(drive.clone()));

    // A Table with a dedicated row class — same shape `useTableData` queries:
    // parent=<table> AND isA=<row class>.
    let row_class = urls::FOLDER;
    let table = store
        .create_resource(
            urls::TABLE,
            &drive,
            "Stress table",
            Some(vec![(
                urls::CLASSTYPE_PROP,
                Value::AtomicUrl(row_class.into()),
            )]),
        )
        .await
        .unwrap();

    println!("table={table}");
    println!("drive={drive}");
    println!("max_n={max}");

    let marks = checkpoints(max);
    let mut created = 0usize;
    let mut create_total = Duration::ZERO;

    for target in marks {
        let batch = target - created;
        let start = Instant::now();
        for j in created..target {
            if j > 0 && j % 10_000 == 0 {
                println!("  … created {j}/{max}");
            }
            store
                .create_resource(
                    row_class,
                    &table,
                    &format!("Row {j:06}"),
                    Some(vec![
                        (AMOUNT, Value::Integer((j % 1000) as i64)),
                        (urls::SORT_ORDER, Value::Float(j as f64)),
                    ]),
                )
                .await
                .unwrap();
        }
        let batch_t = start.elapsed();
        create_total += batch_t;
        created = target;
        println!(
            "\ncreated {created} (+{batch} in {} ms, {:.3} ms/row, cumulative {:.3} ms/row)",
            ms(batch_t),
            batch_t.as_secs_f64() * 1000.0 / batch as f64,
            create_total.as_secs_f64() * 1000.0 / created as f64
        );
        measure_at(&store, &table, row_class, &drive_subject, created, &db_id).await;
    }

    println!(
        "\nDONE n={created} create_total={} ms ({:.3} ms/row)",
        ms(create_total),
        create_total.as_secs_f64() * 1000.0 / created as f64
    );
}
