//! Measures how per-commit cost scales with the number of watched query
//! filters accumulated on a store — the scenario `(drive, property)`-routed
//! filter matching exists for (historically, leaked filters reached 13k+ and
//! visibly slowed rapid-save e2e tests).
//!
//! Not a pass/fail regression test: it prints timings for a paired
//! comparison across commits. Run explicitly:
//! `cargo test -p atomic_lib --features db-redb --test watched_filter_scaling -- --ignored --nocapture`
#![cfg(feature = "db-redb")]

use atomic_lib::{db::QueryFilter, urls, Db, Storelike, Subject, Value};

const CREATES_PER_ROUND: usize = 200;
const FILTER_COUNTS: [usize; 3] = [0, 2000, 10_000];

async fn time_creates(store: &Db, drive: &str, label: &str) -> std::time::Duration {
    let start = std::time::Instant::now();
    for j in 0..CREATES_PER_ROUND {
        store
            .create_resource(
                urls::CLASS,
                drive,
                &format!("item {label} {j}"),
                Some(vec![(
                    urls::SHORTNAME,
                    Value::Slug(format!("wfs-{label}-{j}")),
                )]),
            )
            .await
            .unwrap();
    }
    start.elapsed()
}

#[tokio::test]
#[ignore = "perf measurement, run explicitly with --ignored --nocapture"]
async fn commit_cost_vs_watched_filter_count() {
    let store = Db::init_temp("watched_filter_scaling").await.unwrap();
    let (_agent, drive) = store.setup("Bench").await.unwrap();
    let drive_subject = Subject::from(drive.clone());

    let mut registered = 0usize;
    for target in FILTER_COUNTS {
        // Top up to `target` watched filters, each on a distinct property the
        // created resources never carry — pure bystander filters, exactly
        // what accumulates on a long-running server.
        while registered < target {
            let filter = QueryFilter::single(
                Some(format!("https://example.com/bench/prop-{registered}")),
                Some(Value::AtomicUrl(
                    format!("https://example.com/bench/val-{registered}").into(),
                )),
                None,
                drive_subject.clone(),
            );
            filter.watch(&store).unwrap();
            registered += 1;
        }

        // One warmup + one measured round.
        let _ = time_creates(&store, &drive, &format!("warm{target}")).await;
        let took = time_creates(&store, &drive, &format!("meas{target}")).await;
        println!(
            "filters={target:>6}  creates={CREATES_PER_ROUND}  total={:?}  per-create={:.3}ms",
            took,
            took.as_secs_f64() * 1000.0 / CREATES_PER_ROUND as f64
        );
    }
}
