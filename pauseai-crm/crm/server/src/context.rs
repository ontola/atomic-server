use crate::appstate::AppState;
use crate::errors::AtomicServerError;
use actix_web::{dev::Payload, FromRequest, HttpRequest};
use futures::future::{ready, Ready};

#[derive(Clone, Debug)]
pub struct RequestContext {
    /// The full origin, e.g. "https://atomicdata.dev" or "http://localhost:9883"
    pub origin: String,
}

impl RequestContext {
    pub fn new(req: &HttpRequest, appstate: &AppState) -> Self {
        let headers = req.headers();

        let host = headers
            .get("x-forwarded-host")
            .or_else(|| headers.get("host"))
            .and_then(|v| v.to_str().ok());

        let proto = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok());

        let origin = if let Some(h) = host {
            let p = proto.unwrap_or(if appstate.config.opts.https {
                "https"
            } else {
                "http"
            });
            format!("{}://{}", p, h)
        } else {
            // Fallback to configured origin if no Host header is present
            appstate.config.get_origin()
        };

        Self { origin }
    }
}

impl FromRequest for RequestContext {
    type Error = AtomicServerError;
    type Future = Ready<Result<Self, Self::Error>>;

    fn from_request(req: &HttpRequest, _payload: &mut Payload) -> Self::Future {
        let appstate = match req.app_data::<actix_web::web::Data<AppState>>() {
            Some(data) => data,
            None => return ready(Err(AtomicServerError::from("AppState not found"))),
        };

        ready(Ok(RequestContext::new(req, appstate)))
    }
}
