use crate::{
    appstate::AppState,
    content_types::get_accept,
    content_types::ContentType,
    errors::AtomicServerResult,
    helpers::{get_client_agent, try_extension},
};
use actix_web::{web, HttpResponse};
use atomic_lib::db::ResolveSubjectResult;
use simple_server_timing_header::Timer;

/// Respond to a single resource.
/// The URL should match the Subject of the resource.
#[tracing::instrument(skip(appstate, req))]
pub async fn handle_get_resource(
    path: Option<web::Path<String>>,
    appstate: web::Data<AppState>,
    req: actix_web::HttpRequest,
    context: crate::context::RequestContext,
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
        "/".to_string()
    };

    let subject = atomic_lib::Subject::from_raw(&subject_string, None);

    timer.add("parse_headers");

    // Extract host for drive mapping, stripping port if present
    let host = headers
        .get("Host")
        .and_then(|h| h.to_str().ok())
        .map(|h| h.split(':').next().unwrap_or(h))
        .unwrap_or("localhost");

    let for_agent =
        get_client_agent(headers, &appstate, &format!("{}{}", origin, subject_string)).await?;
    timer.add("get_agent");

    let res = appstate
        .store
        .resolve_subject(&subject, host, &subject_string, &origin, &for_agent)
        .await?;

    let mut builder = HttpResponse::Ok();

    let (mut resource, redirect_subject) = match res {
        ResolveSubjectResult::Uninitialized {
            full_subject,
            host,
        } => {
            tracing::info!("Server is uninitialized for host: {}", host);
            builder.append_header(("Content-Type", ContentType::JsonAd.to_mime()));
            return Ok(builder.body(
                serde_json::json!({
                    "@id": full_subject,
                    "https://atomicdata.dev/properties/isA": ["https://atomicdata.dev/classes/Server"],
                    "https://atomicdata.dev/properties/isUninitialized": true,
                    "https://atomicdata.dev/properties/name": format!("Uninitialized Atomic Server ({})", host),
                })
                .to_string(),
            ));
        }
        ResolveSubjectResult::Resource {
            resource,
            redirect_subject,
        } => {
            if let atomic_lib::Subject::Did { .. } = resource.get_subject() {
                builder.append_header((
                    "Link",
                    format!("<{}>; rel=\"canonical\"", resource.get_subject().as_str()),
                ));
            }
            (resource.to_single().clone(), redirect_subject)
        }
    };

    if let Some(redirect) = redirect_subject {
        let old_subject: &str = resource.get_subject().as_str();
        tracing::debug!("Aliasing resource {} to requested subject {}", old_subject, redirect);
        resource.set_subject(redirect);
        builder.append_header((
            "Warning",
            "299 - \"Resource resolved via alias. Identity is the canonical DID.\"",
        ));
    }

    builder.append_header(("Content-Type", content_type.to_mime()));
    // This prevents the browser from displaying the JSON response upon re-opening a closed tab
    // https://github.com/atomicdata-dev/atomic-server/issues/137
    builder.append_header((
        "Cache-Control",
        "no-store, no-cache, must-revalidate, private",
    ));

    let store = appstate.store.clone_with_url(origin.clone());

    crate::metrics::resource_fetched_http();

    let response_body = match content_type {
        ContentType::Json => resource.to_json(&store, Some(&origin)).await?,
        ContentType::JsonLd => resource.to_json_ld(&store, Some(&origin)).await?,
        ContentType::JsonAd => resource.to_json_ad(Some(&origin))?,
        ContentType::Html => resource.to_json_ad(Some(&origin))?,
        ContentType::Turtle | ContentType::NTriples => {
            let atoms = resource.to_atoms();
            atomic_lib::serialize::atoms_to_ntriples(atoms, &store).await?
        }
    };

    timer.add("serialize");
    Ok(builder.body(response_body))
}
