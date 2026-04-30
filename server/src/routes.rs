//! Contains routing logic, sends the client to the correct handler.
//! We should try to minimize what happens in here, since most logic should be defined in Atomic Data - not in the server itself.

use crate::{content_types, handlers};
use actix_web::{guard, http::Method, web};
use actix_web_static_files::ResourceFiles;

/// Should match all routes
const ANY: &str = "{tail:.*}";

// Includes the js assets from the `browser` folder,
// used for hosting the front-end JS bundles, service workers,
// css, icons and other static files.
// See build.rs for more info.
include!(concat!(env!("OUT_DIR"), "/generated.rs"));

async fn iroh_node_id_handler() -> actix_web::HttpResponse {
    if let Some(node_id) = crate::iroh_transport::get_node_id() {
        return actix_web::HttpResponse::Ok()
            .content_type("application/json")
            .body(format!(r#"{{"nodeId":"iroh:{node_id}"}}"#));
    }

    actix_web::HttpResponse::Ok()
        .content_type("application/json")
        .body(r#"{"nodeId":null}"#)
}

/// POST /iroh-sync { "nodeId": "...", "drive": "..." }
/// Triggers an Iroh peer sync from the server to the given NodeID.
async fn iroh_sync_handler(
    body: web::Json<serde_json::Value>,
    appstate: web::Data<crate::appstate::AppState>,
) -> actix_web::HttpResponse {
    let node_id = match body.get("nodeId").and_then(|v| v.as_str()) {
        Some(id) => id
                .strip_prefix("did:ad:node:")
                .or_else(|| id.strip_prefix("iroh:"))
                .unwrap_or(id),
        None => {
            return actix_web::HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "Missing nodeId"}));
        }
    };
    let drive = match body.get("drive").and_then(|v| v.as_str()) {
        Some(d) => d,
        None => {
            return actix_web::HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "Missing drive"}));
        }
    };

    match atomic_lib::sync::peer::sync_drive_with_peer(node_id, drive, &appstate.store).await {
        Ok(count) => actix_web::HttpResponse::Ok()
            .json(serde_json::json!({"count": count, "status": "ok"})),
        Err(e) => actix_web::HttpResponse::InternalServerError()
            .json(serde_json::json!({"error": e.to_string()})),
    }
}

/// Set up the Actix server routes. This defines which paths are used.
// Keep in mind that the order of these matters. An early, greedy route will take
// precedence over a later route.
pub fn config_routes(app: &mut actix_web::web::ServiceConfig) {
    app.service(
        web::resource("/upload")
            .guard(guard::Method(Method::POST))
            .to(handlers::upload::upload_handler),
    )
    .service(
        web::resource("/commit")
            .guard(guard::Method(Method::POST))
            .to(handlers::commit::post_commit),
    )
    .service(web::resource("/download/{path:[^{}]+}").to(handlers::download::handle_download))
    .service(
        web::resource("/setup")
            .guard(guard::Method(Method::POST))
            .to(handlers::post_resource::handle_post_resource),
    )
    .service(web::resource("/ws").to(handlers::web_sockets::web_socket_handler))
    .service(web::resource("/iroh-node-id").to(iroh_node_id_handler))
    .service(web::resource("/iroh-sync").to(iroh_sync_handler))
    .service(web::resource("/export").to(handlers::export::handle_export))
    .service(web::resource("/plugin-ui").to(handlers::plugin_ui::handle_plugin_ui))
    .service(web::resource("/plugin-list").to(handlers::plugin_ui::handle_plugin_list))
    // This `generate` imports the static files from the `app_assets` folder
    .service(
        ResourceFiles::new("/", generate())
            .skip_handler_when_not_found()
            .do_not_resolve_defaults(),
    )
    // Catch all (non-download) HTML requests and send them to the single page app
    .service(
        web::resource(ANY)
            .guard(guard::Method(Method::GET))
            .guard(guard::fn_guard(|guard_ctx| {
                content_types::get_accept(guard_ctx.head().headers())
                    == content_types::ContentType::Html
            }))
            .to(handlers::single_page_app::single_page),
    )
    .service(
        web::resource("/search")
            .guard(guard::Method(Method::GET))
            .to(handlers::search::search_query),
    )
    .service(
        web::resource(ANY)
            .guard(guard::Method(Method::POST))
            .to(handlers::post_resource::handle_post_resource),
    )
    .service(
        web::resource(ANY)
            .guard(guard::Method(Method::GET))
            .to(handlers::get_resource::handle_get_resource),
    )
    // Also allow the home resource (not matched by the previous one)
    .service(web::resource("/").to(handlers::get_resource::handle_get_resource));
}
