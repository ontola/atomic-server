use actix_cors::Cors;
use actix_web::{body::MessageBody, dev::{ServiceRequest, ServiceResponse}, middleware, web, Error, HttpServer};
use atomic_lib::{urls, Storelike};
use tracing_actix_web::{DefaultRootSpanBuilder, RootSpanBuilder};

/// Custom span builder: uses "{method} {path}" when no route pattern is matched
/// (e.g. static files), so spans are legible in SigNoz instead of just "GET".
struct AtomicRootSpanBuilder;

impl RootSpanBuilder for AtomicRootSpanBuilder {
    fn on_request_start(request: &ServiceRequest) -> tracing::Span {
        if request.match_pattern().is_none() {
            let name = format!("{} {}", request.method(), request.path());
            return tracing::info_span!("HTTP request", "otel.name" = name, "http.method" = %request.method(), "http.target" = %request.path());
        }
        DefaultRootSpanBuilder::on_request_start(request)
    }

    fn on_request_end<B: MessageBody>(span: tracing::Span, outcome: &Result<ServiceResponse<B>, Error>) {
        DefaultRootSpanBuilder::on_request_end(span, outcome);
    }
}

use crate::errors::AtomicServerResult;

/// Clears and rebuilds the Store & Search indexes
async fn rebuild_indexes(appstate: &crate::appstate::AppState) -> AtomicServerResult<()> {
    let appstate_clone = appstate.clone();

    actix_web::rt::spawn(async move {
        appstate_clone
            .store
            .clear_index()
            .expect("Failed to clear value index");
        appstate_clone
            .store
            .build_index(true)
            .expect("Failed to build value index");
    });

    tracing::info!("Removing existing search index...");
    appstate
        .search_state
        .writer
        .write()
        .expect("Could not get a lock on search writer")
        .delete_all_documents()?;
    appstate
        .search_state
        .add_all_resources(&appstate.store)
        .await?;
    Ok(())
}

/// Removes all remote resources from the store.
async fn clear_remote_cache(appstate: &crate::appstate::AppState) -> AtomicServerResult<()> {
    tracing::info!("Removing remote resources...");
    let mut count = 0;
    let mut subjects_to_remove = Vec::new();
    for resource in appstate.store.all_resources(true) {
        let subject = resource.get_subject();
        if matches!(subject, atomic_lib::Subject::External(_)) {
            subjects_to_remove.push(subject.clone());
        }
    }

    for subject in subjects_to_remove {
        appstate.store.remove_resource(&subject).await?;
        appstate.search_state.remove_resource(subject.as_str())?;
        count += 1;
    }

    appstate.search_state.writer.write()?.commit()?;

    tracing::info!("Successfully removed {} remote resources.", count);
    Ok(())
}

/// Spawns a background task that periodically announces local drives to the DHT.
fn spawn_dht_announcer(appstate: crate::appstate::AppState) {
    if let Some(dht) = appstate.dht.clone() {
        let port = if appstate.config.opts.https {
            appstate.config.opts.port_https
        } else {
            appstate.config.opts.port
        };

        tracing::info!("DHT: Spawning drive announcer on port {}", port);

        actix_web::rt::spawn(async move {
            let interval_secs = if std::env::var("ATOMIC_DHT_BOOTSTRAP").is_ok() {
                15
            } else {
                20 * 60
            };
            let mut interval =
                actix_web::rt::time::interval(std::time::Duration::from_secs(interval_secs));
            loop {
                interval.tick().await;
                tracing::info!("DHT: Starting periodic drive announcement...");

                // Find all local drives
                let all_resources = appstate.store.all_resources(false);
                let mut announced_count = 0;

                for resource in all_resources {
                    let mut is_drive = false;
                    if let Ok(classes_val) = resource.get(urls::IS_A) {
                        if let Ok(classes) = classes_val.to_subjects(None) {
                            if classes.contains(&urls::DRIVE.to_string()) {
                                is_drive = true;
                            }
                        }
                    }

                    if is_drive {
                        let drive_did = resource.get_subject().as_str();
                        if let Err(e) = dht.announce_drive(drive_did, port as u16) {
                            let e: atomic_lib::errors::AtomicError = e;
                            tracing::error!(
                                "DHT: Failed to announce drive {}: {}",
                                drive_did,
                                e
                            );
                        } else {
                            announced_count += 1;
                        }
                    }
                }
                tracing::info!("DHT: Finished announcing {} drives.", announced_count);
            }
        });
    }
}

// Increase the maximum payload size (for POSTing a body, for example) to 50MB
const PAYLOAD_MAX: usize = 50_242_880;
const SERVER_VERSION_HEADER: &str = "X-Atomic-Server-Version";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Start the server
pub async fn serve(config: crate::config::Config) -> AtomicServerResult<()> {
    println!("Atomic-server {} \nUse --help for instructions. Visit https://docs.atomicdata.dev and https://github.com/atomicdata-dev/atomic-server for more info.", env!("CARGO_PKG_VERSION"));
    let tracing_chrome_flush_guard = crate::trace::init_tracing(&config);

    // Setup the database and more
    let appstate = crate::appstate::AppState::init(config.clone()).await?;

    // Start async processes
    if config.opts.rebuild_indexes {
        rebuild_indexes(&appstate).await?;
    }
    if config.opts.clear_remote_cache {
        clear_remote_cache(&appstate).await?;
    }

    // Start discovery / announcement services
    spawn_dht_announcer(appstate.clone());

    let server = HttpServer::new(move || {
        let cors = Cors::permissive();

        actix_web::App::new()
            .app_data(web::PayloadConfig::new(PAYLOAD_MAX))
            .app_data(web::Data::new(appstate.clone()))
            .wrap(cors)
            .wrap(
                middleware::DefaultHeaders::new()
                    .add((SERVER_VERSION_HEADER, SERVER_VERSION)),
            )
            .wrap(tracing_actix_web::TracingLogger::<AtomicRootSpanBuilder>::new())
            .wrap(middleware::Compress::default())
            // Here are the actual handlers / endpoints
            .configure(crate::routes::config_routes)
            .default_service(web::to(|| {
                tracing::error!("Wrong route, should not happen with normal requests");
                actix_web::HttpResponse::NotFound()
            }))
            .app_data(
                web::JsonConfig::default()
                    // register error_handler for JSON extractors.
                    .error_handler(crate::jsonerrors::json_error_handler),
            )
    });

    let protocol = if config.opts.https { "https" } else { "http" };
    let port = if config.opts.https {
        config.opts.port_https
    } else {
        config.opts.port
    };
    let message = format!(
        "{}\n\nVisit {}://{}:{}\n\n",
        BANNER, protocol, config.opts.domain, port
    );

    if config.opts.https {
        if cfg!(feature = "https") {
            #[cfg(feature = "https")]
            {
                // If there is no certificate file, or the certs are too old, start HTTPS initialization
                {
                    if crate::https::should_renew_certs_check(&config)? {
                        crate::https::request_cert(&config).await?;
                    }
                }
                let https_config = crate::https::get_https_config(&config)
                    .expect("HTTPS TLS Configuration with Let's Encrypt failed.");
                let endpoint = format!("{}:{}", config.opts.ip, config.opts.port_https);
                tracing::info!("Binding HTTPS server to endpoint {}", endpoint);
                println!("{}", message);
                server
                    .bind_rustls(&endpoint, https_config)
                    .map_err(|e| format!("Cannot bind to endpoint {}: {}", &endpoint, e))?
                    .shutdown_timeout(TIMEOUT)
                    .run()
                    .await?;
            }
        } else {
            return Err("The HTTPS feature has been disabled for this build. Please compile atomic-server with the HTTP feature. `cargo install atomic-server`".into());
        }
    } else {
        let endpoint = format!("{}:{}", config.opts.ip, config.opts.port);
        tracing::info!("Binding HTTP server to endpoint {}", endpoint);
        println!("{}", message);
        server
            .bind(&format!("{}:{}", config.opts.ip, config.opts.port))
            .map_err(|e| format!("Cannot bind to endpoint {}: {}", &endpoint, e))?
            .shutdown_timeout(TIMEOUT)
            .run()
            .await?;
    }

    tracing::info!("Cleaning up");
    // Cleanup, runs when server is stopped
    // Note that more cleanup code is in Appstate::exit
    if let Some(guard) = tracing_chrome_flush_guard {
        guard.flush()
    }

    tracing::info!("Server stopped");
    Ok(())
}

/// Amount of seconds before server shuts down connections after SIGTERM signal
const TIMEOUT: u64 = 15;

const BANNER: &str = r#"
         __                  _
  ____ _/ /_____  ____ ___  (_)____      ________  ______   _____  _____
 / __ `/ __/ __ \/ __ `__ \/ / ___/_____/ ___/ _ \/ ___/ | / / _ \/ ___/
/ /_/ / /_/ /_/ / / / / / / / /__/_____(__  )  __/ /   | |/ /  __/ /
\__,_/\__/\____/_/ /_/ /_/_/\___/     /____/\___/_/    |___/\___/_/
"#;
