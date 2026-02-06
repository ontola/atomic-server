use crate::{
    appstate::AppState,
    content_types::get_accept,
    content_types::ContentType,
    errors::AtomicServerResult,
    helpers::{get_client_agent, try_extension},
};
use actix_web::{web, HttpResponse};
use atomic_lib::Storelike;
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

    let full_subject = format!("{}{}", origin, subject_string);
    let for_agent = get_client_agent(headers, &appstate, full_subject).await?;
    timer.add("get_agent");

    let mut builder = HttpResponse::Ok();

    tracing::debug!("get_resource: {} as {}", subject, content_type.to_mime());
    builder.append_header(("Content-Type", content_type.to_mime()));
    // This prevents the browser from displaying the JSON response upon re-opening a closed tab
    // https://github.com/atomicdata-dev/atomic-server/issues/137
    builder.append_header((
        "Cache-Control",
        "no-store, no-cache, must-revalidate, private",
    ));

    let store = appstate.store.clone_with_url(origin.clone());
    let resource = store
        .get_resource_extended(&subject.clone().into(), false, &for_agent)
        .await?;
    timer.add("get_resource");

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
