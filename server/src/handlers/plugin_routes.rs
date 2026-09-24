//! Serves the plugin route mounts: every path on `<slug>.<ATOMIC_ROUTES_ORIGIN>`
//! (`installation-origin`) and `/_routes/<slug>/...` on the API origin
//! (`drive-prefix`). What each request gets is decided by
//! [`crate::plugins::route_registry::RouteRegistry::answer`].
//!
//! Compiled only with the `plugin-routes` feature, and the guards only match
//! while `--plugin-routes` is at least `read-only`: at `off`, `/_routes/...`
//! falls through to the ordinary handlers (and finds no resource, since none
//! can be created there) and a routes host gets nothing special.
//!
//! A matched route runs the installation's handler: see
//! [`crate::plugins::route_exec`].
use actix_web::{guard, http::header, web, HttpRequest, HttpResponse};

use crate::appstate::AppState;
use crate::plugins::manifest_http::Mount;
use crate::plugins::route_exec::{self, RouteCors};
use crate::plugins::route_registry::{Answer, State, PAUSED_RETRY_AFTER_SECS};

fn request_host(head: &actix_web::dev::RequestHead) -> &str {
    head.headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .or_else(|| head.uri.host())
        .unwrap_or("")
}

fn registry(ctx: &guard::GuardContext<'_>) -> Option<web::Data<AppState>> {
    ctx.app_data::<web::Data<AppState>>()
        .filter(|state| state.route_registry.enabled())
        .cloned()
}

/// Every path on the routes origin and its subdomains belongs to plugins.
fn on_routes_host(ctx: &guard::GuardContext<'_>) -> bool {
    registry(ctx).is_some_and(|state| {
        state
            .route_registry
            .routes_host_label(request_host(ctx.head()))
            .is_some()
    })
}

fn routes_enabled(ctx: &guard::GuardContext<'_>) -> bool {
    registry(ctx).is_some()
}

/// Register before every other route: on a routes host, nothing of the
/// server's is served.
pub fn configure(app: &mut web::ServiceConfig) {
    app.service(
        web::resource("/{tail:.*}")
            .guard(guard::fn_guard(on_routes_host))
            .to(serve),
    )
    .service(
        web::resource("/_routes")
            .guard(guard::fn_guard(routes_enabled))
            .to(serve),
    )
    .service(
        web::resource("/_routes/{tail:.*}")
            .guard(guard::fn_guard(routes_enabled))
            .to(serve),
    );
}

fn problem(status: u16, kind: &str, title: &str, detail: &str) -> serde_json::Value {
    serde_json::json!({
        "type": kind,
        "status": status,
        "title": title,
        "detail": detail,
    })
}

async fn serve(
    state: web::Data<AppState>,
    req: HttpRequest,
    payload: web::Payload,
) -> HttpResponse {
    let host = request_host(req.head()).to_string();
    let answer = state
        .route_registry
        .answer(
            &host,
            req.method().as_str(),
            req.path(),
            atomic_lib::utils::now(),
        )
        .unwrap_or(Answer::NotFound);
    let target = match &answer {
        Answer::Matched { route } => state
            .route_registry
            .target(&host, req.path())
            .map(|target| (route.clone(), target)),
        _ => None,
    };
    let mut response = match target {
        Some((route, (installation, mount, path))) => {
            route_exec::execute(&state, &req, payload, &installation, mount, &path, &route).await
        }
        None => respond(answer),
    };
    // The server's CORS layer does not speak for plugin routes: a route is
    // exactly as cross-origin as it declared, and the host's own answers on
    // a plugin mount are not cross-origin at all.
    if response.extensions().get::<RouteCors>().is_none() {
        response.extensions_mut().insert(RouteCors::default());
    }
    response
}

/// `readRouteStatus` (design 2.10): per route of an installation, its URL,
/// request and error counts for the last 24 hours, and the last error; and
/// the sampled run log. Readable by whoever may read the Installation.
#[derive(serde::Deserialize)]
pub struct StatusQuery {
    installation: String,
}

pub async fn status(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<StatusQuery>,
    context: crate::context::RequestContext,
) -> crate::errors::AtomicServerResult<HttpResponse> {
    use atomic_lib::Storelike;
    let store = &state.store;
    let path_and_query = req
        .head()
        .uri
        .path_and_query()
        .ok_or("Path must be given")?
        .to_string();
    let signed_subject =
        atomic_lib::Subject::from_raw(&path_and_query, None).resolve(&context.origin);
    let agent = crate::helpers::get_client_agent(req.headers(), &state, &signed_subject).await?;
    let resource = store
        .get_resource(&query.installation.as_str().into())
        .await?;
    atomic_lib::hierarchy::check_read(store, &resource, &agent).await?;

    let registry = &state.route_registry;
    let slug = crate::plugins::route_registry::slug(&query.installation);
    let manifest = resource
        .get(atomic_lib::urls::RELEASE_ID)
        .ok()
        .and_then(|id| store.get_plugin_release(&id.to_string()).ok())
        .and_then(|release| crate::plugins::manifest::Manifest::parse(release.manifest).ok())
        .flatten();
    let http = manifest.as_ref().and_then(|m| m.http.as_ref());
    let base = match http.map(|h| h.mount) {
        Some(Mount::InstallationOrigin) => registry.config().routes_origin().map(|origin| {
            let mut url = origin.clone();
            let host = format!("{slug}.{}", origin.host_str().unwrap_or_default());
            let _ = url.set_host(Some(&host));
            url.as_str().trim_end_matches('/').to_string()
        }),
        Some(Mount::DrivePrefix) => Some(format!(
            "{}/{}/{slug}",
            context.origin.trim_end_matches('/'),
            atomic_lib::subject::PLUGIN_ROUTES_SEGMENT
        )),
        _ => None,
    };
    let routes: Vec<(String, String)> = http
        .map(|h| {
            h.routes
                .iter()
                .map(|r| {
                    (
                        r.id.clone(),
                        base.as_ref()
                            .map(|b| format!("{b}{}", r.path))
                            .unwrap_or_default(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let state_name = match registry.state(&query.installation) {
        Some(State::Active) => "active".to_string(),
        Some(State::Paused) => "paused".to_string(),
        Some(State::Retired { .. }) => "retired".to_string(),
        Some(State::Degraded(_)) => "degraded".to_string(),
        None => "unregistered".to_string(),
    };
    let degraded = match registry.state(&query.installation) {
        Some(State::Degraded(reason)) => Some(reason),
        _ => None,
    };
    let mut body = state
        .route_exec
        .status(&query.installation, &routes, atomic_lib::utils::now());
    body["installation"] = query.installation.clone().into();
    body["slug"] = slug.into();
    body["state"] = state_name.into();
    body["degraded"] = degraded.into();
    body["level"] = registry.config().level().as_str().into();
    Ok(HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(body))
}

pub fn respond(answer: Answer) -> HttpResponse {
    let json = |mut builder: actix_web::HttpResponseBuilder, body: serde_json::Value| {
        builder
            .content_type("application/problem+json")
            .insert_header((header::CACHE_CONTROL, "no-store"))
            .body(body.to_string())
    };
    match answer {
        // `serve` runs a matched route; this is only reached when the
        // installation disappeared between the two lookups.
        Answer::Matched { .. } => HttpResponse::NotFound().finish(),
        Answer::MethodNotAllowed { allow } => {
            let mut builder = HttpResponse::MethodNotAllowed();
            builder.insert_header((header::ALLOW, allow.join(", ")));
            json(
                builder,
                problem(
                    405,
                    "route-method-not-allowed",
                    "Method not allowed",
                    &format!("This route answers {}.", allow.join(", ")),
                ),
            )
        }
        Answer::Paused => {
            let mut builder = HttpResponse::ServiceUnavailable();
            builder.insert_header((header::RETRY_AFTER, PAUSED_RETRY_AFTER_SECS.to_string()));
            json(
                builder,
                problem(
                    503,
                    "installation-paused",
                    "This plugin is paused",
                    "The plugin that serves this URL is paused. Try again later.",
                ),
            )
        }
        Answer::Gone => json(
            HttpResponse::Gone(),
            problem(
                410,
                "installation-removed",
                "This plugin was removed",
                "The plugin that served this URL was uninstalled from this server.",
            ),
        ),
        Answer::NotFound => HttpResponse::NotFound().finish(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::route_registry::{slug, RouteRegistry, State};
    use crate::plugins::test_fixture::{
        fixture_with_args, hello_route_release, install_release, js_release, Fixture,
    };
    use actix_web::{test, App};
    use atomic_lib::{db::plugin_meta::PluginMetaKey, urls, Db, Storelike, Value};
    use serde_json::json;

    const ROUTES: [&str; 4] = [
        "--plugin-routes",
        "read-only",
        "--routes-origin",
        "http://routes.localhost:9883",
    ];

    /// Installs a plugin `acme/<name>` with this `http` block.
    async fn try_install(
        f: &Fixture,
        name: &str,
        http: serde_json::Value,
    ) -> Result<String, String> {
        let release = js_release(json!({
            "schemaVersion": 3,
            "name": name,
            "namespace": "acme",
            "capabilities": [{"name": "storage", "reason": "keeps a cursor"}],
            "http": http,
        }));
        install_release(f, &release).await
    }

    async fn set_status(db: &Db, subject: &str, status: &str) {
        let mut r = db.get_resource(&subject.into()).await.unwrap();
        r.set_unsafe(
            urls::INSTALLATION_STATUS.into(),
            Value::String(status.into()),
        )
        .unwrap();
        r.save(db).await.unwrap();
    }

    fn drive_prefix() -> serde_json::Value {
        json!({
            "mount": "drive-prefix",
            "routes": [{"id": "hello", "path": "/hello/{name}", "methods": ["GET"]}]
        })
    }

    macro_rules! app {
        ($appstate:expr) => {
            test::init_service(
                App::new()
                    .app_data(web::Data::new($appstate.clone()))
                    .configure(crate::routes::config_routes),
            )
            .await
        };
    }

    #[actix_rt::test]
    async fn install_pause_resume_and_revoke_drive_prefix_routes() {
        let f = fixture_with_args("routes_lifecycle", &ROUTES).await;
        let installation = install_release(&f, &hello_route_release()).await.unwrap();
        let app = app!(f.appstate);
        let url = format!("/_routes/{}/hello/alice", slug(&installation));
        let get = || test::TestRequest::get().uri(&url).to_request();

        let resp = test::call_service(&app, get()).await;
        assert_eq!(resp.status(), 200);
        assert_eq!(test::read_body(resp).await, "Hello, alice");

        let resp = test::call_service(&app, test::TestRequest::post().uri(&url).to_request()).await;
        assert_eq!(resp.status(), 405);
        assert_eq!(resp.headers().get(header::ALLOW).unwrap(), "GET, HEAD");

        set_status(&f.appstate.store, &installation, "paused").await;
        let resp = test::call_service(&app, get()).await;
        assert_eq!(resp.status(), 503);
        assert_eq!(resp.headers().get(header::RETRY_AFTER).unwrap(), "3600");

        set_status(&f.appstate.store, &installation, "active").await;
        assert_eq!(test::call_service(&app, get()).await.status(), 200);

        set_status(&f.appstate.store, &installation, "revoked").await;
        assert_eq!(test::call_service(&app, get()).await.status(), 410);

        // A fresh registry (a restart) remembers the retirement.
        let restarted = RouteRegistry::new(f.appstate.config.plugin_routes.clone());
        restarted.rebuild(&f.appstate.store).await.unwrap();
        assert!(matches!(
            restarted.state(&installation),
            Some(State::Retired { .. })
        ));
    }

    #[actix_rt::test]
    async fn installation_origin_routes_answer_on_their_host_only() {
        let f = fixture_with_args("routes_origin", &ROUTES).await;
        let installation = try_install(
            &f,
            "origin",
            json!({"routes": [{"id": "root", "path": "/", "methods": ["GET"]}]}),
        )
        .await
        .unwrap();
        let app = app!(f.appstate);
        let host = format!("{}.routes.localhost:9883", slug(&installation));
        let resp = test::call_service(
            &app,
            test::TestRequest::get()
                .uri("/")
                .insert_header((header::HOST, host.as_str()))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 200);
        // The server's own routes are not served on a routes host.
        let resp = test::call_service(
            &app,
            test::TestRequest::post()
                .uri("/commit")
                .insert_header((header::HOST, host.as_str()))
                .to_request(),
        )
        .await;
        assert_eq!(resp.status(), 404);
    }

    #[actix_rt::test]
    async fn reserved_paths_and_a_missing_routes_origin_refuse_the_install() {
        let f = fixture_with_args("routes_reserved", &ROUTES).await;
        let err = try_install(
            &f,
            "reserved",
            json!({"routes": [{"id": "pw", "path": "/.well-known/change-password", "methods": ["GET"]}]}),
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("reserves") && err.contains("change-password"),
            "{err}"
        );
        // Refused before the installation hook: nothing materialized.
        assert!(f
            .appstate
            .store
            .get_plugin_meta(&PluginMetaKey::new(&f.drive, "acme", "reserved"))
            .unwrap()
            .is_none());

        let f = fixture_with_args("routes_no_origin", &ROUTES[..2]).await;
        let err = try_install(
            &f,
            "origin",
            json!({"routes": [{"id": "root", "path": "/", "methods": ["GET"]}]}),
        )
        .await
        .unwrap_err();
        assert!(err.contains("ATOMIC_ROUTES_ORIGIN"), "{err}");
        // drive-prefix needs no routes origin.
        try_install(&f, "prefix", drive_prefix()).await.unwrap();
    }

    /// Registration is the execution owner's: an activation that arrives
    /// from a peer registers nothing, now or after a restart.
    #[actix_rt::test]
    async fn an_activation_from_a_peer_registers_nothing() {
        let f = fixture_with_args("routes_replica", &ROUTES).await;
        let installation = atomic_lib::sync::ws_apply::import_scope(
            Some("peer".into()),
            try_install(&f, "synced", drive_prefix()),
        )
        .await
        .unwrap();
        let registry = &f.appstate.route_registry;
        assert!(!registry.knows(&installation));
        let app = app!(f.appstate);
        let url = format!("/_routes/{}/hello/alice", slug(&installation));
        let resp = test::call_service(&app, test::TestRequest::get().uri(&url).to_request()).await;
        assert_eq!(resp.status(), 404);

        let restarted = RouteRegistry::new(f.appstate.config.plugin_routes.clone());
        assert_eq!(restarted.rebuild(&f.appstate.store).await.unwrap(), 0);
        assert!(!restarted.knows(&installation));
    }

    /// A restart restores the owner's routes; one with the gates lowered
    /// degrades them to 404.
    #[actix_rt::test]
    async fn a_restart_restores_routes_and_degrades_what_the_gates_no_longer_allow() {
        let f = fixture_with_args("routes_restart", &["--plugin-routes", "read-write"]).await;
        let reader = try_install(&f, "reader", drive_prefix()).await.unwrap();
        let writer = try_install(
            &f,
            "writer",
            json!({
                "mount": "drive-prefix",
                "routes": [{"id": "w", "path": "/in", "methods": ["POST"], "principal": "installation", "auth": "atomic"}]
            }),
        )
        .await
        .unwrap();

        let same = RouteRegistry::new(f.appstate.config.plugin_routes.clone());
        assert_eq!(same.rebuild(&f.appstate.store).await.unwrap(), 2);

        let lowered = crate::plugin_routes::resolve(
            crate::plugin_routes::PluginRoutesOptions {
                level: crate::plugin_routes::PluginRoutesLevel::ReadOnly,
                ..Default::default()
            },
            true,
            crate::plugin_routes::OriginContext {
                api_origin: "http://localhost:9883",
                ..Default::default()
            },
        )
        .unwrap();
        let restarted = RouteRegistry::new(lowered);
        assert_eq!(restarted.rebuild(&f.appstate.store).await.unwrap(), 1);
        assert_eq!(restarted.state(&reader), Some(State::Active));
        assert!(matches!(restarted.state(&writer), Some(State::Degraded(_))));
        assert_eq!(
            respond(
                restarted
                    .answer(
                        "localhost",
                        "POST",
                        &format!("/_routes/{}/in", slug(&writer)),
                        0
                    )
                    .unwrap()
            )
            .status(),
            404
        );
    }
}
