/// Start logging / tracing. Creates a subscribers that logs to stdout.
/// Also optionally creates a Chrome trace file. Starts OpenTelemetry if configured.
/// Returns a [tracing_chrome::FlushGuard] that should be dropped when the server is no longer needed.
pub fn init_tracing(config: &crate::config::Config) -> Option<tracing_chrome::FlushGuard> {
    // Enable logging, but hide most tantivy logs
    let log_level = match config.opts.log_level {
        crate::config::LogLevel::Warn => "warn",
        crate::config::LogLevel::Info => "info",
        crate::config::LogLevel::Debug => "debug",
        crate::config::LogLevel::Trace => "trace",
    };
    std::env::set_var("RUST_LOG", format!("{},tantivy=warn", log_level));
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
    // Start tracing
    // STDOUT log
    let filter = tracing_subscriber::EnvFilter::from_default_env();
    let tracing_registry = tracing_subscriber::registry().with(filter);

    match config.opts.trace {
        crate::config::Tracing::Stdout => {
            let terminal_layer = tracing_subscriber::fmt::Layer::default();
            tracing_registry.with(terminal_layer).init();
        }
        crate::config::Tracing::Chrome => {
            let (chrome_layer, flush_guard) = tracing_chrome::ChromeLayerBuilder::new()
                .include_args(true)
                .build();
            tracing_registry.with(chrome_layer).init();
            tracing::info!(
                "Enabling tracing for Chrome. Saving file (after run) to ./trace-timestamp.json",
            );
            return Some(flush_guard);
        }
        crate::config::Tracing::Opentelemetry => {
            #[cfg(feature = "telemetry")]
            {
                use opentelemetry::trace::TracerProvider;
                use opentelemetry::KeyValue;
                use opentelemetry_otlp::{Protocol, WithExportConfig};
                use opentelemetry_sdk::{trace as sdktrace, Resource};
                use tracing_subscriber::layer::SubscriberExt;

                let endpoint = std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
                    .unwrap_or_else(|_| "http://localhost:4317".into()); // gRPC

                println!("Enabling OTel gRPC at {}", endpoint);

                // gRPC exporter (no `.tonic()` in 0.29, just enable "tonic" feature)
                let exporter = opentelemetry_otlp::SpanExporter::builder()
                    .with_tonic()
                    .with_endpoint(endpoint)
                    .with_protocol(Protocol::Grpc)
                    .build()
                    .expect("build OTLP gRPC exporter");

                let resource = Resource::builder()
                    .with_attributes(vec![
                        KeyValue::new("service.name", "atomic-server"),
                        KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
                    ])
                    .build();

                let provider = sdktrace::SdkTracerProvider::builder()
                    .with_resource(resource)
                    .with_sampler(sdktrace::Sampler::AlwaysOn)
                    .with_batch_exporter(exporter) // runtime is set by Cargo feature
                    .build();

                let tracer = provider.tracer("atomic-server");

                let layer = tracing_opentelemetry::layer().with_tracer(tracer);
                tracing_registry.with(layer).init();

                opentelemetry::global::set_tracer_provider(provider);
            }
            #[cfg(not(feature = "telemetry"))]
            {
                tracing::warn!("OpenTelemetry tracing is not enabled, compile atomic-server with `--features opentelemetry` to enable");
            }
        }
    }

    None
}
