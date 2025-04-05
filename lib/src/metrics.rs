//! Application-level metrics for atomic_lib, exported via OpenTelemetry.
//! All functions compile to no-ops when the `telemetry` feature is disabled.

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
    external_fetch,
    "resources.fetched.external",
    "External HTTP resource fetches via fetch_body"
);
counter!(
    query_indexed,
    "queries.indexed",
    "New QueryFilters built and persisted (cache miss)"
);
