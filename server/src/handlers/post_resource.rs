use crate::{
    appstate::AppState,
    content_types::get_accept,
    content_types::ContentType,
    errors::AtomicServerResult,
    helpers::{get_client_agent, try_extension},
};
use actix_web::{web, HttpResponse};
use atomic_lib::{Resource, Storelike};
use simple_server_timing_header::Timer;

/// Respond to a single resource POST request.
#[tracing::instrument(skip(appstate, req))]
pub async fn handle_post_resource(
    path: Option<web::Path<String>>,
    appstate: web::Data<AppState>,
    req: actix_web::HttpRequest,
    context: crate::context::RequestContext,
    body: web::Bytes,
) -> AtomicServerResult<HttpResponse> {
    let mut timer = Timer::new();

    let headers = req.headers();
    let mut content_type = get_accept(headers);
    let origin = context.origin.clone();

    let subject_string = if let Some(subj_end) = path {
        let mut subj_end_string = subj_end.as_str();
        if subj_end_string.is_empty() {
            "/".to_string()
        } else {
            if content_type == ContentType::Html {
                if let Some((ext, path)) = try_extension(subj_end_string) {
                    content_type = ext;
                    subj_end_string = path;
                }
            }
            let querystring = if req.query_string().is_empty() {
                "".to_string()
            } else {
                format!("?{}", req.query_string())
            };
            format!("/{}{}", subj_end_string, querystring)
        }
    } else {
        req.path().to_string()
    };

    let full_subject = atomic_lib::Subject::from_raw(&subject_string, None).resolve(&origin);

    let store = &appstate.store;
    timer.add("parse_headers");

    let for_agent = get_client_agent(headers, &appstate, &full_subject).await?;
    timer.add("get_agent");

    let mut builder = HttpResponse::Ok();

    tracing::debug!(
        "post_resource: {} as {}",
        full_subject,
        content_type.to_mime()
    );
    builder.append_header(("Content-Type", content_type.to_mime()));
    // This prevents the browser from displaying the JSON response upon re-opening a closed tab
    // https://github.com/atomicdata-dev/atomic-server/issues/137
    builder.append_header((
        "Cache-Control",
        "no-store, no-cache, must-revalidate, private",
    ));

    let resource: Resource = store
        .post_resource(&full_subject, body.into(), &for_agent)
        .await?;
    timer.add("post_resource");

    let response_body = match content_type {
        ContentType::Json => resource.to_json(store, Some(&origin)).await?,
        ContentType::JsonLd => resource.to_json_ld(store, Some(&origin)).await?,
        ContentType::JsonAd => resource.to_json_ad(Some(&origin))?,
        ContentType::Html => resource.to_json_ad(Some(&origin))?,
        ContentType::Turtle | ContentType::NTriples => {
            let atoms = resource.to_atoms();
            atomic_lib::serialize::atoms_to_ntriples(atoms, store).await?
        }
    };
    timer.add("serialize");
    builder.append_header(("Server-Timing", timer.header_value()));
    Ok(builder.body(response_body))
}
