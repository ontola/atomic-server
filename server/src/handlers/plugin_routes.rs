//! Serves the plugin route mounts: every path on `<slug>.<ATOMIC_ROUTES_ORIGIN>`
//! (`installation-origin`), `/_routes/<slug>/...` on the API origin
//! (`drive-prefix`), and on hosts shared with the server (a drive's hosts,
//! the API origin) only the paths an installation registered there: its
//! `drive-host` routes and its `/.well-known/` claims. What each request gets
//! is decided by [`RouteRegistry::dispatch`].
//!
//! Compiled only with the `plugin-routes` feature, and the guards only match
//! while `--plugin-routes` is at least `read-only`: at `off`, `/_routes/...`
//! falls through to the ordinary handlers (and finds no resource, since none
//! can be created there), a routes host gets nothing special, and a drive's
//! host serves the drive.
//!
//! A matched route runs the installation's handler: see
//! [`crate::plugins::route_exec`].
use actix_web::{guard, http::header, web, HttpRequest, HttpResponse};

use crate::appstate::AppState;
use crate::plugins::manifest_http::{Cors, Mount};
use crate::plugins::route_exec::{self, RouteCors};
use crate::plugins::route_registry::{
    host_name, Answer, Dispatch, Request, RouteRegistry, State, PAUSED_RETRY_AFTER_SECS,
};

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

/// The drive `Tree::DriveMapping` maps `host` to. A synchronous key lookup,
/// so a guard can use it.
fn drive_of_host(state: &AppState, host: &str) -> Option<String> {
    let bytes = state
        .store
        .kv
        .get(
            atomic_lib::db::trees::Tree::DriveMapping,
            host_name(host).as_bytes(),
        )
        .ok()??;
    String::from_utf8(bytes).ok()
}

fn dispatch(
    registry: &RouteRegistry,
    state: &AppState,
    head: &actix_web::dev::RequestHead,
) -> Option<Dispatch> {
    let host = request_host(head);
    let drive = drive_of_host(state, host);
    registry.dispatch(&Request {
        host,
        drive: drive.as_deref(),
        method: head.method.as_str(),
        path: head.uri.path(),
        query: head.uri.query().unwrap_or(""),
        now: atomic_lib::utils::now(),
    })
}

/// A path an installation registered on a host it shares with the server:
/// a `drive-host` route or a `/.well-known/` claim. Everything else on that
/// host is the server's.
fn on_shared_host(ctx: &guard::GuardContext<'_>) -> bool {
    registry(ctx).is_some_and(|state| {
        state.route_registry.serves_shared_hosts()
            && dispatch(&state.route_registry, &state, ctx.head()).is_some()
    })
}

/// Register before every other route: on a routes host, nothing of the
/// server's is served, and on a shared host a path an installation
/// registered comes before the server's own handlers.
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
    )
    .service(
        web::resource("/{tail:.*}")
            .guard(guard::fn_guard(on_shared_host))
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
    let dispatched = dispatch(&state.route_registry, &state, req.head())
        .unwrap_or(Dispatch::Answer(Answer::NotFound));
    let mut response = match dispatched {
        Dispatch::Run(target) => route_exec::execute(&state, &req, payload, &target).await,
        Dispatch::HostMeta { json } => host_meta(&req, json),
        Dispatch::MissingResource => problem_response(
            actix_web::HttpResponse::BadRequest(),
            problem(
                400,
                "webfinger-resource-missing",
                "No resource to look up",
                "A WebFinger request needs a `resource` query parameter.",
            ),
        ),
        Dispatch::Answer(answer) => respond(answer),
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
        // A drive's hosts are the operator's and the owner's DNS; the route
        // is at the same path on each of them.
        Some(Mount::DriveHost) => Some(String::new()),
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
    // The delivery queue (#1719): per route, and for the installation.
    let deliveries = crate::plugins::route_delivery::status(
        store,
        &query.installation,
        state.route_delivery.per_day(),
        atomic_lib::utils::now(),
    );
    if let Some(routes) = body["routes"].as_array_mut() {
        for route in routes {
            let queue = route["id"]
                .as_str()
                .and_then(|id| deliveries["routes"].get(id));
            route["queueDepth"] = queue.map(|q| q["queueDepth"].clone()).unwrap_or(0.into());
            route["oldestQueueFailure"] = queue
                .map(|q| q["oldestQueueFailure"].clone())
                .unwrap_or_default();
        }
    }
    let mut deliveries = deliveries;
    if let Some(summary) = deliveries.as_object_mut() {
        summary.remove("routes");
    }
    body["deliveries"] = deliveries;
    Ok(HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .json(body))
}

fn problem_response(
    mut builder: actix_web::HttpResponseBuilder,
    body: serde_json::Value,
) -> HttpResponse {
    builder
        .content_type("application/problem+json")
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .body(body.to_string())
}

/// `/.well-known/host-meta` (RFC 6415), generated from the host's
/// `webfinger` claims: one `lrdd` template pointing at this host's
/// WebFinger. `host-meta.json` is the JRD form. Readable from any origin, as
/// WebFinger is (RFC 7033, section 5).
fn host_meta(req: &HttpRequest, json: bool) -> HttpResponse {
    let host = request_host(req.head());
    // Only a well-formed host goes into the document.
    let safe = !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-.:[]".contains(&b));
    if !safe {
        return HttpResponse::NotFound().finish();
    }
    let scheme = req.connection_info().scheme().to_string();
    let scheme = if scheme == "https" { "https" } else { "http" };
    let template = format!("{scheme}://{host}/.well-known/webfinger?resource={{uri}}");
    let (content_type, body) = if json {
        (
            "application/jrd+json",
            serde_json::json!({
                "links": [{"rel": "lrdd", "type": "application/jrd+json", "template": template}]
            })
            .to_string(),
        )
    } else {
        (
            "application/xrd+xml; charset=utf-8",
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<XRD xmlns=\"http://docs.oasis-open.org/ns/xri/xrd-1.0\">\n  <Link rel=\"lrdd\" type=\"application/jrd+json\" template=\"{template}\"/>\n</XRD>\n"
            ),
        )
    };
    let mut response = HttpResponse::Ok()
        .content_type(content_type)
        .insert_header((header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .body(if req.method() == actix_web::http::Method::HEAD {
            String::new()
        } else {
            body
        });
    response
        .extensions_mut()
        .insert(RouteCors::declared(Cors::AnyOriginNoCredentials));
    response
}

pub fn respond(answer: Answer) -> HttpResponse {
    let json = problem_response;
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
        fixture_with_args, hello_route_release, install_release, js_release,
        js_release_with_source, well_known_release, Fixture,
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

    // -- well-known claims and the drive-host mount (#1716) -------------------

    /// The identifying part of a subject, whichever scheme it is written in.
    fn id(subject: &str) -> &str {
        subject.rsplit(':').next().unwrap()
    }

    /// A vanity host bound to the fixture's drive.
    const ALICE: &str = "alice.example";

    fn bind(f: &Fixture, host: &str) {
        f.appstate
            .store
            .add_drive_mapping(host, &Value::AtomicUrl(f.drive.as_str().into()))
            .unwrap();
    }

    /// A `GET` of `uri` on `host`.
    macro_rules! on {
        ($host:expr, $uri:expr) => {
            test::TestRequest::get()
                .uri($uri)
                .insert_header((header::HOST, AsRef::<str>::as_ref(&$host)))
                .insert_header((header::ACCEPT, "application/json"))
                .to_request()
        };
    }

    #[actix_rt::test]
    async fn claimed_well_known_paths_run_on_the_drives_hosts() {
        let f = fixture_with_args("wk_drive_host", &ROUTES).await;
        let installation = install_release(&f, &well_known_release()).await.unwrap();
        bind(&f, ALICE);
        let app = app!(f.appstate);

        let resp = test::call_service(&app, on!(ALICE, "/.well-known/nodeinfo")).await;
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        // The route's declared CORS, which the CORS middleware applies.
        let cors = resp.response().extensions().get::<RouteCors>().cloned();
        assert!(
            cors.is_some_and(|c| c.0.iter().any(|(name, value)| {
                name == header::ACCESS_CONTROL_ALLOW_ORIGIN && value == "*"
            })),
            "no declared CORS"
        );
        let body: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(body["links"][0]["href"], "/nodeinfo/2.1");

        // The route the links point at, on its own path: no claim.
        let resp = test::call_service(&app, on!(&format!("{ALICE}:443"), "/nodeinfo/2.1")).await;
        assert_eq!(resp.status(), 200);
        let body: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(body["version"], "2.1");
        assert_eq!(body["metadata"]["wellKnown"], serde_json::Value::Null);

        let resp = test::call_service(
            &app,
            on!(
                ALICE,
                "/.well-known/webfinger?resource=acct%3Aalice%40alice.example"
            ),
        )
        .await;
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/jrd+json"
        );
        let body: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(body["subject"], "acct:alice@alice.example");

        for (uri, status) in [
            ("/.well-known/webfinger", 400),
            (
                "/.well-known/webfinger?resource=https%3A%2F%2Felsewhere",
                404,
            ),
        ] {
            let resp = test::call_service(&app, on!(ALICE, uri)).await;
            assert_eq!(resp.status(), status, "{uri}");
        }

        let resp = test::call_service(&app, on!(ALICE, "/.well-known/host-meta")).await;
        assert_eq!(resp.status(), 200);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/xrd+xml; charset=utf-8"
        );
        let body = String::from_utf8(test::read_body(resp).await.to_vec()).unwrap();
        assert!(
            body.contains(
                r#"template="http://alice.example/.well-known/webfinger?resource={uri}""#
            ),
            "{body}"
        );
        let resp = test::call_service(&app, on!(ALICE, "/.well-known/host-meta.json")).await;
        let body: serde_json::Value = test::read_body_json(resp).await;
        assert_eq!(body["links"][0]["rel"], "lrdd");

        // The rest of the drive's host is the drive's: an unclaimed name, a
        // path no route registered, the drive itself.
        for uri in ["/.well-known/ocm", "/nothing-here"] {
            let resp = test::call_service(&app, on!(ALICE, uri)).await;
            assert_eq!(resp.status(), 404, "{uri}");
            assert!(
                resp.response().extensions().get::<RouteCors>().is_none(),
                "{uri}"
            );
        }
        // The drive itself (not public here, so `401` from the server).
        let resp = test::call_service(&app, on!(ALICE, "/")).await;
        assert_eq!(resp.status(), 401);
        assert!(resp.response().extensions().get::<RouteCors>().is_none());

        // Not on the API origin, although it maps to the same drive.
        let resp = test::call_service(&app, on!("localhost:9883", "/.well-known/nodeinfo")).await;
        assert_eq!(resp.status(), 404);

        // Pausing takes the claims off the host.
        set_status(&f.appstate.store, &installation, "paused").await;
        let resp = test::call_service(&app, on!(ALICE, "/.well-known/nodeinfo")).await;
        assert_eq!(resp.status(), 404);
    }

    /// Echoes which plugin answered and the resource it was asked about.
    const ECHO: &str = r#"
        export function handle(ctx, request) {
          return { status: 200, body: ctx.trigger.route + ' ' + request.query.resource };
        }"#;

    async fn install_webfinger(f: &Fixture, name: &str, prefix: &str) -> Result<String, String> {
        let release = js_release_with_source(
            ECHO,
            json!({
                "schemaVersion": 3,
                "name": name,
                "namespace": "acme",
                "capabilities": [{"name": "storage", "reason": "keeps a cursor"}],
                "http": {
                    "mount": "drive-host",
                    "routes": [{"id": name, "path": format!("/{name}/webfinger"), "methods": ["GET"]}],
                    "wellKnown": [{"name": "webfinger", "kind": "shared",
                        "match": {"resourcePrefix": prefix}, "route": name}],
                },
            }),
        );
        install_release(f, &release).await
    }

    #[actix_rt::test]
    async fn two_installations_share_webfinger_without_seeing_each_others_queries() {
        let f = fixture_with_args("wk_shared", &ROUTES).await;
        let alice = install_webfinger(&f, "alice", "acct:alice@").await.unwrap();
        let bob = install_webfinger(&f, "bob", "acct:bob@").await.unwrap();
        bind(&f, ALICE);
        let app = app!(f.appstate);
        for (resource, answer) in [
            ("acct:alice@alice.example", "alice acct:alice@alice.example"),
            ("acct:bob@alice.example", "bob acct:bob@alice.example"),
        ] {
            let resp = test::call_service(
                &app,
                on!(
                    ALICE,
                    &format!("/.well-known/webfinger?resource={resource}")
                ),
            )
            .await;
            assert_eq!(resp.status(), 200);
            assert_eq!(test::read_body(resp).await, answer);
        }
        let resp = test::call_service(
            &app,
            on!(
                ALICE,
                "/.well-known/webfinger?resource=acct:carol@alice.example"
            ),
        )
        .await;
        assert_eq!(resp.status(), 404);
        // Each ran exactly once: for its own query, never for the other's or
        // for the unmatched one.
        let now = atomic_lib::utils::now();
        for (installation, route) in [(&alice, "alice"), (&bob, "bob")] {
            let status = f.appstate.route_exec.status(
                installation,
                &[(route.to_string(), String::new())],
                now,
            );
            assert_eq!(status["routes"][0]["requests24h"], 1, "{route}: {status}");
        }

        // A prefix that overlaps one already claimed is refused, naming the
        // installation it overlaps (`acct:` overlaps both).
        let err = install_webfinger(&f, "all", "acct:").await.unwrap_err();
        assert!(
            err.contains("webfinger") && (err.contains(id(&alice)) || err.contains(id(&bob))),
            "{err}"
        );
        let err = install_webfinger(&f, "alices", "acct:alice")
            .await
            .unwrap_err();
        assert!(err.contains(id(&alice)), "{err}");
    }

    #[actix_rt::test]
    async fn a_second_exclusive_claim_and_unlisted_names_are_refused_at_install() {
        let f = fixture_with_args("wk_exclusive", &ROUTES).await;
        let first = install_release(&f, &well_known_release()).await.unwrap();
        let second = try_install(
            &f,
            "second",
            json!({
                "mount": "drive-host",
                "routes": [{"id": "links", "path": "/second/nodeinfo", "methods": ["GET"]}],
                "wellKnown": [{"name": "nodeinfo", "kind": "exclusive", "route": "links"}],
            }),
        )
        .await
        .unwrap_err();
        assert!(
            second.contains("/.well-known/nodeinfo") && second.contains(id(&first)),
            "{second}"
        );
        // Refused before the installation hook: nothing materialized.
        assert!(f
            .appstate
            .store
            .get_plugin_meta(&PluginMetaKey::new(&f.drive, "acme", "second"))
            .unwrap()
            .is_none());

        for name in ["change-password", "acme-challenge", "host-meta"] {
            let err = try_install(
                &f,
                "unlisted",
                json!({
                    "mount": "drive-host",
                    "routes": [{"id": "x", "path": "/unlisted/x", "methods": ["GET"]}],
                    "wellKnown": [{"name": name, "kind": "exclusive", "route": "x"}],
                }),
            )
            .await
            .unwrap_err();
            assert!(
                err.contains(name) && err.contains("not claimable"),
                "{name}: {err}"
            );
        }
    }

    /// The drive owner approves an exclusive claim on the drive's hosts, and
    /// a route may not take a path of the drive's own resources.
    #[actix_rt::test]
    async fn drive_host_activations_check_the_owner_and_the_drives_paths() {
        use crate::plugins::manifest_http::Http;
        use crate::plugins::route_registry::{check_drive_host, Refusal};
        let f = fixture_with_args("wk_owner", &ROUTES).await;
        let store = &f.appstate.store;
        let http = |routes: serde_json::Value, well_known: serde_json::Value| -> Http {
            serde_json::from_value(
                json!({"mount": "drive-host", "routes": routes, "wellKnown": well_known}),
            )
            .unwrap()
        };
        let claim = http(
            json!([{"id": "links", "path": "/owner/nodeinfo", "methods": ["GET"]}]),
            json!([{"name": "nodeinfo", "kind": "exclusive", "route": "links"}]),
        );
        let owner = store.get_default_agent().unwrap().subject.to_string();
        check_drive_host(store, &f.drive, &claim, &owner)
            .await
            .unwrap();
        let stranger = atomic_lib::agents::Agent::new(None)
            .unwrap()
            .subject
            .to_string();
        let refusal = check_drive_host(store, &f.drive, &claim, &stranger)
            .await
            .unwrap_err();
        assert_eq!(
            refusal,
            Refusal::WellKnownApprovalRequired {
                name: "nodeinfo".into(),
                drive: f.drive.clone(),
            }
        );
        assert_eq!(refusal.to_json()["type"], "well-known-approval-required");
        // Shared claims need no approval: they only see their own queries.
        let shared = http(
            json!([{"id": "wf", "path": "/owner/webfinger", "methods": ["GET"]}]),
            json!([{"name": "webfinger", "kind": "shared", "match": {"resourcePrefix": "acct:"}, "route": "wf"}]),
        );
        check_drive_host(store, &f.drive, &shared, &stranger)
            .await
            .unwrap();

        // The fixture's drive has an ontology with shortname `plugins`.
        for path in ["/plugins", "/plugins/{name}"] {
            let taken = http(
                json!([{"id": "x", "path": path, "methods": ["GET"]}]),
                json!([]),
            );
            let refusal = check_drive_host(store, &f.drive, &taken, &owner)
                .await
                .unwrap_err();
            assert!(
                matches!(&refusal, Refusal::Reserved { reason, .. } if reason.contains("`/plugins`")),
                "{path}: {refusal:?}"
            );
        }
    }
}
