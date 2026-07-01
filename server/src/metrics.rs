//! Application-level metrics exported via OpenTelemetry.
//! Each function increments a named counter by 1.
//! All functions compile to no-ops when the `telemetry` feature is disabled.

/// Increment a named OTel counter by 1.
/// The instrument is created once via OnceLock and reused on every call.
macro_rules! counter {
    ($fn_name:ident, $metric:literal, $desc:literal) => {
        pub fn $fn_name() {
            #[cfg(feature = "telemetry")]
            {
                use opentelemetry::metrics::Counter;
                use std::sync::OnceLock;
                static C: OnceLock<Counter<u64>> = OnceLock::new();
                C.get_or_init(|| {
                    opentelemetry::global::meter("atomic-server")
                        .u64_counter($metric)
                        .with_description($desc)
                        .build()
                })
                .add(1, &[]);
            }
        }
    };
}

counter!(
    commit_applied,
    "commits.applied",
    "Commits applied to the store"
);
counter!(
    resource_fetched_http,
    "resources.fetched.http",
    "Resources fetched via HTTP GET"
);
counter!(
    search_performed,
    "search.queries",
    "Full-text search queries performed"
);
counter!(drive_created, "drives.created", "Drive resources created");
