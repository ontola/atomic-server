use std::fmt::Display;
use std::fmt::Formatter;

use crate::{appstate::AppState, errors::AtomicServerResult};
use actix_web::HttpResponse;

/// Returns the atomic-data-browser single page application
#[tracing::instrument(skip(appstate))]
pub async fn single_page(
    appstate: actix_web::web::Data<AppState>,
    path: actix_web::web::Path<String>,
    req: actix_web::HttpRequest,
    context: crate::context::RequestContext,
) -> AtomicServerResult<HttpResponse> {
    let origin = context.origin.clone();
    let store = appstate.store.clone_with_url(origin.clone());
    let template = include_str!("../../assets_tmp/index.html");
    let csp_nonce = generate_nonce().map_err(|_e| "Failed to generate nonce")?;
    let subject = format!("{}/{}", origin, path);
    let meta_tags: MetaTags = if let Ok(resource_response) = store
        .get_resource_extended(&subject.clone().into(), true, &ForAgent::Public)
        .await
    {
        MetaTags::from_resource_response(resource_response, &origin)
    } else {
        MetaTags::default()
    };

    let script = format!(
        "<script nonce=\"{}\">{}{}</script>",
        csp_nonce,
        home_drive_script(appstate.config.opts.home_drive.as_deref(), &origin),
        appstate.config.opts.script
    );

    let body = template
        .replace("ATOMICSERVER_NONCE", &csp_nonce)
        .replace("<!-- { inject_html_head } -->", &meta_tags.to_string())
        .replace("<!-- { inject_script } -->", &script);

    let resp = HttpResponse::Ok()
        .content_type("text/html")
        // This prevents the browser from displaying the JSON response upon re-opening a closed tab
        // https://github.com/atomicdata-dev/atomic-server/issues/137
        .insert_header((
            "Cache-Control",
            "no-store, no-cache, must-revalidate, private",
        ))
        .insert_header((
            "Content-Security-Policy",
            spa_content_security_policy(&csp_nonce),
        ))
        .body(body);

    Ok(resp)
}

use atomic_lib::agents::ForAgent;
use atomic_lib::storelike::ResourceResponse;
use atomic_lib::urls;
use atomic_lib::Resource;
use atomic_lib::Storelike;

const DEFAULT_SOCIAL_PREVIEW: &str = "/default_social_preview.jpg";

/// CSP for the data-browser HTML shell.
///
/// `script-src` is nonce-locked so an injected inline script does not run.
/// That is not enough on its own: the production bundle is a relative
/// `<script src="/assets/…">` carrying the same nonce, and a `<base href>`
/// earlier in `<head>` retargets that URL to an attacker origin — a nonce
/// then *authorizes* the foreign script. `base-uri 'self'` closes that.
/// `object-src 'none'` is cheap hardening. A full `default-src 'none'` is
/// not applied here: the SPA loads styles, images, fonts, WASM and API
/// calls from several origins and would need an explicit inventory first.
fn spa_content_security_policy(nonce: &str) -> String {
    format!(
        "script-src 'nonce-{nonce}' 'wasm-unsafe-eval'; worker-src 'self'; base-uri 'self'; object-src 'none'"
    )
}

/* HTML tags for social media and link previews. Also includes JSON-AD body of the requested resource, if publicly available. */
struct MetaTags {
    description: String,
    title: String,
    image: String,
    json: Option<String>,
}

impl MetaTags {
    pub fn from_resource_response(rr: ResourceResponse, origin: &str) -> Self {
        match rr {
            ResourceResponse::Resource(r) => Self::from_resource(r, origin),
            ResourceResponse::ResourceWithReferenced(ref resource, _) => {
                let mut tags: MetaTags = Self::from_resource(resource.clone(), origin);

                // Turns the resource into JSON-AD and base64 encodes it.
                // TODO: also fetch the parents for extra fast first renders!
                let json = rr.to_json_ad(Some(origin)).ok();

                tags.json = json;

                tags
            }
            ResourceResponse::Redirect(target) => MetaTags {
                description: format!("Redirecting to {}", target),
                title: "Redirecting...".into(),
                image: "".into(),
                json: None,
            },
        }
    }
}

impl MetaTags {
    pub fn from_resource(r: Resource, origin: &str) -> Self {
        let description = if let Ok(d) = r.get(urls::DESCRIPTION) {
            d.to_string()
        } else {
            "Open this resource in your browser to view its contents.".to_string()
        };
        let title = if let Ok(d) = r.get(urls::NAME) {
            d.to_string()
        } else {
            "Atomic Server".to_string()
        };
        let image = if let Ok(d) = r.get(urls::DOWNLOAD_URL) {
            // `download-url` is a user-writable string, not recomputed on
            // read. Only http(s) and same-origin paths are used as a preview
            // image; anything else falls back so a crafted value cannot
            // break out of the `<meta>` attribute even if escaping is later
            // removed.
            sanitize_preview_image(&d.to_string())
        } else {
            DEFAULT_SOCIAL_PREVIEW.to_string()
        };
        // TODO: also fetch the parents for extra fast first renders!
        let json = r.to_json_ad(Some(origin)).ok();
        Self {
            description,
            title,
            image,
            json,
        }
    }
}

impl Default for MetaTags {
    fn default() -> Self {
        Self {
            description: "Sign in to view this resource".to_string(),
            title: "Atomic Server".to_string(),
            image: DEFAULT_SOCIAL_PREVIEW.to_string(),
            json: None,
        }
    }
}

impl Display for MetaTags {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        let description = escape_html(&self.description);
        // Escape `image` the same way as title/description. The previous
        // raw interpolation let a `download-url` containing `"` close the
        // attribute and inject markup (`<base>`, `<meta http-equiv>`) into
        // every visitor's `<head>`.
        let image = escape_html(&self.image);
        let title = escape_html(&self.title);

        write!(
            f,
            "<meta name=\"description\" content=\"{description}\">
<meta property=\"og:title\" content=\"{title}\">
<meta property=\"og:description\" content=\"{description}\">
<meta property=\"og:image\" content=\"{image}\">
<meta property=\"twitter:card\" content=\"summary_large_image\">
<meta property=\"twitter:title\" content=\"{title}\">
<meta property=\"twitter:description\" content=\"{description}\">
<meta property=\"twitter:image\" content=\"{image}\">"
        )?;
        if let Some(json_unsafe) = &self.json {
            use base64::Engine;
            let json_base64 = base64::engine::general_purpose::STANDARD.encode(json_unsafe);
            write!(
                f,
                "\n<meta property=\"json-ad-initial\" content=\"{}\">",
                json_base64
            )?;
        };
        Ok(())
    }
}

fn escape_html(s: &str) -> String {
    // `&` first so the entities we insert next are not re-escaped.
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\'', "&#x27;")
        .replace('"', "&quot;")
        .replace('/', "&#x2F;")
}

/// Values safe to put in `og:image` / `twitter:image` after HTML escaping.
///
/// Allows `http(s):` and same-origin relative paths (`/…`). Rejects
/// protocol-relative URLs (`//evil`), `javascript:` / `data:` / etc., and
/// anything with whitespace, controls, or HTML-significant characters.
fn sanitize_preview_image(value: &str) -> String {
    if is_safe_preview_image_url(value) {
        value.to_string()
    } else {
        DEFAULT_SOCIAL_PREVIEW.to_string()
    }
}

fn is_safe_preview_image_url(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    if value
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\'' | '`'))
    {
        return false;
    }
    // Same-origin relative path, not protocol-relative `//host`.
    if value.starts_with('/') && !value.starts_with("//") {
        return true;
    }
    match url::Url::parse(value) {
        Ok(parsed) => matches!(parsed.scheme(), "http" | "https"),
        Err(_) => false,
    }
}

/// Declares the configured home Drive to the app, inside the HTML we are
/// already serving.
///
/// The browser must know this before its first render, and it cannot be asked
/// for asynchronously: the Agent lives in IndexedDB, which has no synchronous
/// API, so "is anyone signed in?" is only answerable after an await. A home
/// Drive is shown to everyone regardless of sign-in state, which is exactly
/// what lets the decision be made here — no request, nothing to wait for.
///
/// Empty when unset, which is the default: `/` then keeps sending visitors
/// without an Agent to the welcome flow.
///
/// The subject goes through `serde_json` rather than string interpolation. That
/// alone is not enough: JSON escaping leaves `<` untouched, so a value
/// containing `</script>` would close the tag and everything after it would be
/// markup. Every `<` is therefore rewritten to its unicode escape, which the
/// JS parser reads back as `<` inside the string literal while the HTML parser
/// never sees a tag-closing sequence at all. The value is
/// operator-supplied rather than user-supplied, but it lands inside a script
/// tag either way.
///
/// The subject is resolved against this server's origin before being injected.
///
/// The natural thing to configure for a Drive at the server root is what the
/// store actually holds — `internal:/`. But the browser cannot fetch a bare
/// `internal:` subject: it has no host to send the request to, so it issues no
/// request at all and the page waits forever on "Still loading…", with nothing
/// in the console. Resolving here turns `internal:/` into
/// `https://example.com/`, which the client can fetch, while a `did:ad:`
/// subject resolves to itself and is unaffected.
fn home_drive_script(home_drive: Option<&str>, origin: &str) -> String {
    match home_drive.map(str::trim) {
        Some(drive) if !drive.is_empty() => {
            let resolved = atomic_lib::Subject::from_raw(drive, Some(origin)).resolve(origin);
            match serde_json::to_string(&resolved) {
                Ok(encoded) => {
                    let safe = encoded.replace('<', "\\u003C");
                    format!("window.__ATOMIC_HOME_DRIVE__={safe};")
                }
                Err(_) => String::new(),
            }
        }
        _ => String::new(),
    }
}

fn generate_nonce() -> Result<String, ring::error::Unspecified> {
    use base64::{engine::general_purpose, Engine as _};
    use ring::rand::{SecureRandom, SystemRandom};

    let mut nonce_bytes = [0u8; 32];
    let rng = SystemRandom::new();
    rng.fill(&mut nonce_bytes)?;

    Ok(general_purpose::URL_SAFE_NO_PAD.encode(nonce_bytes))
}

#[cfg(test)]
mod test {
    use super::{
        home_drive_script, sanitize_preview_image, spa_content_security_policy, MetaTags,
        DEFAULT_SOCIAL_PREVIEW,
    };

    const ORIGIN: &str = "https://example.com";

    #[test]
    fn no_home_drive_by_default() {
        // Every install starts without one; `/` keeps the welcome flow.
        assert_eq!(home_drive_script(None, ORIGIN), "");
        assert_eq!(home_drive_script(Some(""), ORIGIN), "");
        assert_eq!(home_drive_script(Some("   "), ORIGIN), "");
    }

    /// A browser cannot fetch a bare `internal:` subject — it has no host to
    /// send the request to, so it silently issues none and the page hangs on
    /// "Still loading…". `internal:/` is the natural thing to configure for a
    /// Drive at the server root, so resolve it to something fetchable.
    #[test]
    fn root_drive_is_resolved_to_a_fetchable_url() {
        assert_eq!(
            home_drive_script(Some("internal:/"), ORIGIN),
            r#"window.__ATOMIC_HOME_DRIVE__="https://example.com/";"#
        );
        assert!(!home_drive_script(Some("internal:/"), ORIGIN).contains("internal:"));
    }

    #[test]
    fn did_subjects_are_left_alone() {
        // A DID resolves to itself: it is already globally addressable.
        assert_eq!(
            home_drive_script(Some("did:ad:drive:abc"), ORIGIN),
            r#"window.__ATOMIC_HOME_DRIVE__="did:ad:drive:abc";"#
        );
    }

    #[test]
    fn declares_the_configured_drive() {
        assert_eq!(
            home_drive_script(Some("did:ad:drive:abc"), ORIGIN),
            r#"window.__ATOMIC_HOME_DRIVE__="did:ad:drive:abc";"#
        );
        // Whitespace is trimmed before resolution.
        assert_eq!(
            home_drive_script(Some("  internal:/  "), ORIGIN),
            r#"window.__ATOMIC_HOME_DRIVE__="https://example.com/";"#
        );
    }

    #[test]
    fn cannot_break_out_of_the_script_tag() {
        // Operator-supplied, but it still lands inside a <script>. JSON escaping
        // alone leaves `<` intact, so `</script>` would end the element early.
        let out = home_drive_script(Some(r#"a"</script><script>alert(1)</script>"#), ORIGIN);
        assert!(
            !out.contains("</script>"),
            "closed the script tag early: {out}"
        );
        assert!(
            !out.contains('<'),
            "left a raw `<` in the script body: {out}"
        );
        assert!(
            out.starts_with("window.__ATOMIC_HOME_DRIVE__=\""),
            "should still be a plain string assignment: {out}"
        );
    }

    #[test]
    fn evil_meta_tags() {
        // Description, title, and image all land in quoted attributes. A
        // `"` plus markup used to close `og:image` / `twitter:image` and
        // inject a `<base>` or `<meta http-equiv=refresh>` into `<head>`.
        let html = MetaTags {
            description: "\"<script>alert('evil')</script>\"".to_string(),
            title: r#""><script>alert(1)</script>"#.to_string(),
            image: r#""><base href="https://evil.example/">"#.to_string(),
            ..Default::default()
        }
        .to_string();
        assert!(!html.contains("<script>"), "injected a script tag: {html}");
        assert!(!html.contains("<base"), "injected a base tag: {html}");
        assert!(
            !html.contains("http-equiv"),
            "injected a refresh meta: {html}"
        );
        assert!(
            !html.contains(r#"content=""><"#),
            "broke out of a content attribute: {html}"
        );
        assert!(
            html.contains("&quot;") && html.contains("&lt;base"),
            "image payload should be HTML-escaped, got: {html}"
        );
    }

    #[test]
    fn image_refresh_payload_is_escaped() {
        let html = MetaTags {
            image: r#""><meta http-equiv="refresh" content="0;url=https://evil.example/phish">"#
                .to_string(),
            ..Default::default()
        }
        .to_string();
        assert!(
            !html.contains("<meta http-equiv"),
            "injected a raw refresh tag: {html}"
        );
        assert!(
            !html.contains(r#"content=""><"#),
            "broke out of a content attribute: {html}"
        );
        assert!(
            html.contains("&lt;meta"),
            "refresh payload should be HTML-escaped, got: {html}"
        );
    }

    #[test]
    fn escape_html_encodes_ampersand_once() {
        let html = MetaTags {
            title: "A & B < C".to_string(),
            ..Default::default()
        }
        .to_string();
        assert!(
            html.contains("A &amp; B &lt; C"),
            "ampersand must be escaped once, and < must stay a single entity: {html}"
        );
        assert!(
            !html.contains("&amp;amp;") && !html.contains("&amp;lt;"),
            "entities were double-escaped: {html}"
        );
    }

    #[test]
    fn preview_image_url_allowlist() {
        assert_eq!(
            sanitize_preview_image("https://cdn.example.com/cover.jpg"),
            "https://cdn.example.com/cover.jpg"
        );
        assert_eq!(
            sanitize_preview_image("http://cdn.example.com/cover.jpg"),
            "http://cdn.example.com/cover.jpg"
        );
        assert_eq!(
            sanitize_preview_image("/download/files/abc"),
            "/download/files/abc"
        );
        assert_eq!(
            sanitize_preview_image(DEFAULT_SOCIAL_PREVIEW),
            DEFAULT_SOCIAL_PREVIEW
        );

        // Attribute-breakout and non-http(s) schemes fall back.
        assert_eq!(
            sanitize_preview_image(r#""><base href="https://evil.example/">"#),
            DEFAULT_SOCIAL_PREVIEW
        );
        assert_eq!(
            sanitize_preview_image("//evil.example/x"),
            DEFAULT_SOCIAL_PREVIEW
        );
        assert_eq!(
            sanitize_preview_image("javascript:alert(1)"),
            DEFAULT_SOCIAL_PREVIEW
        );
        assert_eq!(
            sanitize_preview_image("data:text/html,<h1>x</h1>"),
            DEFAULT_SOCIAL_PREVIEW
        );
        assert_eq!(
            sanitize_preview_image("file:///etc/passwd"),
            DEFAULT_SOCIAL_PREVIEW
        );
        assert_eq!(sanitize_preview_image(""), DEFAULT_SOCIAL_PREVIEW);
        assert_eq!(
            sanitize_preview_image("https://example.com/a b.jpg"),
            DEFAULT_SOCIAL_PREVIEW
        );
    }

    #[test]
    fn spa_csp_pins_base_uri() {
        let csp = spa_content_security_policy("test-nonce");
        assert!(
            csp.contains("base-uri 'self'"),
            "CSP must pin base-uri so an injected <base> cannot retarget the bundle: {csp}"
        );
        assert!(
            csp.contains("object-src 'none'"),
            "CSP should disable plugins: {csp}"
        );
        assert!(
            csp.contains("script-src 'nonce-test-nonce'"),
            "CSP must keep the per-request script nonce: {csp}"
        );
        assert!(
            !csp.contains("default-src"),
            "default-src is deliberately unset until the SPA origins are inventoried: {csp}"
        );
    }
}
