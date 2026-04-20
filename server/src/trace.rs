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
    // Only set RUST_LOG if not already set (allow .env to override).
    // Third-party libraries kept at `warn` or higher to prevent log floods:
    // - tantivy: normal indexing operations log at info, drowns our logs.
    // - loro_internal: every snapshot export logs per-block-section counters.
    // - pkarr / reqwest: chatty DHT/HTTP internals.
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var(
            "RUST_LOG",
            format!(
                "{log_level},tantivy=warn,loro_internal=warn,pkarr=warn,reqwest=warn"
            ),
        );
    }
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
    // Start tracing
    // STDOUT log
    let filter = tracing_subscriber::EnvFilter::from_default_env();
    let tracing_registry = tracing_subscriber::registry().with(filter);

    match config.opts.trace {
        crate::config::Tracing::Stdout => {
            let terminal_layer = tracing_subscriber::fmt::Layer::default();
            let _ = tracing_registry.with(terminal_layer).try_init();
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
                use opentelemetry_otlp::WithTonicConfig;
                use opentelemetry_sdk::{
                    logs::SdkLoggerProvider, metrics::SdkMeterProvider, trace::SdkTracerProvider,
                    Resource,
                };

                // Install ring as the rustls 0.23 crypto provider (required by tonic TLS).
                // Ignore the error — it just means another provider was already installed.
                let _ = rustls023::crypto::ring::default_provider().install_default();

                let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT")
                    .or_else(|_| std::env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"))
                    .unwrap_or_else(|_| "http://localhost:4317".into());
                println!("Enabling OTel gRPC at {}", endpoint);

                let tls = tonic::transport::ClientTlsConfig::new().with_native_roots();

                let resource = Resource::builder()
                    .with_attributes(vec![
                        KeyValue::new("service.name", "atomic-server"),
                        KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
                    ])
                    .build();

                // Traces
                let span_exporter = opentelemetry_otlp::SpanExporter::builder()
                    .with_tonic()
                    .with_tls_config(tls.clone())
                    .build()
                    .expect("build OTLP span exporter");
                let tracer_provider = SdkTracerProvider::builder()
                    .with_resource(resource.clone())
                    .with_batch_exporter(span_exporter)
                    .build();

                // Logs — bridges tracing events to SigNoz logs (linked to traces)
                let log_exporter = opentelemetry_otlp::LogExporter::builder()
                    .with_tonic()
                    .with_tls_config(tls.clone())
                    .build()
                    .expect("build OTLP log exporter");
                let logger_provider = SdkLoggerProvider::builder()
                    .with_resource(resource.clone())
                    .with_batch_exporter(log_exporter)
                    .build();

                // Metrics
                let metric_exporter = opentelemetry_otlp::MetricExporter::builder()
                    .with_tonic()
                    .with_tls_config(tls)
                    .build()
                    .expect("build OTLP metric exporter");
                let meter_provider = SdkMeterProvider::builder()
                    .with_resource(resource)
                    .with_periodic_exporter(metric_exporter)
                    .build();

                let tracer = tracer_provider.tracer("atomic-server");
                let otel_trace_layer = tracing_opentelemetry::layer().with_tracer(tracer);
                let otel_log_layer =
                    opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge::new(
                        &logger_provider,
                    );
                let terminal_layer = tracing_subscriber::fmt::Layer::default();
                tracing_registry
                    .with(terminal_layer)
                    .with(otel_trace_layer)
                    .with(otel_log_layer)
                    .init();

                opentelemetry::global::set_tracer_provider(tracer_provider);
                opentelemetry::global::set_meter_provider(meter_provider);
            }
            #[cfg(not(feature = "telemetry"))]
            {
                tracing::warn!("OpenTelemetry tracing is not enabled, compile atomic-server with `--features opentelemetry` to enable");
            }
        }
    }

    None
}
