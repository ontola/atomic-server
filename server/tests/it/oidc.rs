//! Integration test: optional OIDC sign-in against an in-process mock provider.
//!
//! The mock speaks just enough OIDC (discovery, authorize, token with PKCE
//! and client authentication, JWKS) and signs RS256 ID tokens. The test plays
//! the browser: it follows redirects by hand and carries the binding cookie.
//!
//! Run: cargo test -p atomic-server --test it oidc

use std::{
    collections::HashMap,
    net::TcpListener,
    sync::{Arc, Mutex},
};

use actix_web::{web, App, HttpRequest, HttpResponse, HttpServer};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ring::{
    digest,
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair, RsaKeyPair, RSA_PKCS1_SHA256},
};
use serde_json::{json, Value};

use crate::common::{start_server_with_args, wait_for_server};

const CLIENT_ID: &str = "atomic-test";
const CLIENT_SECRET: &str = "s3cret";
const RSA_PKCS8_B64: &str = include_str!("../fixtures/oidc_test_rsa_pkcs8.b64");

#[derive(Default)]
struct MockState {
    /// code -> (nonce, challenge, redirect_uri, sub, email)
    codes: HashMap<String, (String, String, String, String, String)>,
    /// What the next ID token gets wrong, if anything.
    flaw: Option<&'static str>,
    next_sub: String,
    next_email: String,
    token_calls: usize,
}

type Shared = Arc<Mutex<MockState>>;

fn rsa() -> RsaKeyPair {
    RsaKeyPair::from_pkcs8(&STANDARD.decode(RSA_PKCS8_B64.trim()).unwrap()).unwrap()
}

fn sign(claims: &Value) -> String {
    let key = rsa();
    let header = json!({"alg":"RS256","kid":"mock-1","typ":"JWT"});
    let input = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let mut sig = vec![0u8; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        input.as_bytes(),
        &mut sig,
    )
    .unwrap();

    format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

struct Mock {
    base: String,
    state: Shared,
}

impl Mock {
    fn start() -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state: Shared = Default::default();
        let (st, b) = (state.clone(), base.clone());

        std::thread::spawn(move || {
            actix_web::rt::System::new().block_on(async move {
                HttpServer::new(move || {
                    App::new()
                        .app_data(web::Data::new((st.clone(), b.clone())))
                        .route(
                            "/.well-known/openid-configuration",
                            web::get().to(discovery),
                        )
                        .route("/jwks", web::get().to(jwks))
                        .route("/authorize", web::get().to(authorize))
                        .route("/token", web::post().to(token))
                })
                .workers(1)
                .listen(listener)
                .unwrap()
                .run()
                .await
                .unwrap();
            });
        });

        Mock { base, state }
    }

    fn set_user(&self, sub: &str, email: &str) {
        let mut s = self.state.lock().unwrap();
        s.next_sub = sub.into();
        s.next_email = email.into();
    }

    fn set_flaw(&self, flaw: Option<&'static str>) {
        self.state.lock().unwrap().flaw = flaw;
    }
}

type Ctx = web::Data<(Shared, String)>;

async fn discovery(ctx: Ctx) -> HttpResponse {
    let b = &ctx.1;
    HttpResponse::Ok().json(json!({
        "issuer": b,
        "authorization_endpoint": format!("{b}/authorize"),
        "token_endpoint": format!("{b}/token"),
        "jwks_uri": format!("{b}/jwks"),
        "token_endpoint_auth_methods_supported": ["client_secret_basic", "client_secret_post"],
    }))
}

async fn jwks() -> HttpResponse {
    let key = rsa();
    let comps: ring::rsa::PublicKeyComponents<Vec<u8>> = key.public().into();

    HttpResponse::Ok().json(json!({"keys":[{
        "kty":"RSA","kid":"mock-1","alg":"RS256","use":"sig",
        "n": URL_SAFE_NO_PAD.encode(&comps.n), "e": URL_SAFE_NO_PAD.encode(&comps.e),
    }]}))
}

fn query(req: &HttpRequest) -> HashMap<String, String> {
    url::form_urlencoded::parse(req.query_string().as_bytes())
        .into_owned()
        .collect()
}

/// The user approves instantly: remember the request, redirect back with a code.
async fn authorize(ctx: Ctx, req: HttpRequest) -> HttpResponse {
    let q = query(&req);
    let mut s = ctx.0.lock().unwrap();
    let code = format!("code-{}", s.codes.len() + 1);
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["client_id"], CLIENT_ID);
    assert!(q["scope"].contains("openid"));
    let sub = s.next_sub.clone();
    let email = s.next_email.clone();
    s.codes.insert(
        code.clone(),
        (
            q["nonce"].clone(),
            q["code_challenge"].clone(),
            q["redirect_uri"].clone(),
            sub,
            email,
        ),
    );

    HttpResponse::Found()
        .insert_header((
            "Location",
            format!(
                "{}?code={code}&state={}",
                q["redirect_uri"],
                urlencoding::encode(&q["state"])
            ),
        ))
        .finish()
}

async fn token(ctx: Ctx, req: HttpRequest, body: web::Bytes) -> HttpResponse {
    let form: HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
    let mut s = ctx.0.lock().unwrap();
    s.token_calls += 1;

    // Client authentication: basic header or post body, secret must match.
    let basic = req
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Basic "))
        .and_then(|b| STANDARD.decode(b).ok())
        .and_then(|b| String::from_utf8(b).ok());
    let ok_client = match basic {
        Some(b) => b == format!("{CLIENT_ID}:{CLIENT_SECRET}"),
        None => {
            form.get("client_id").map(String::as_str) == Some(CLIENT_ID)
                && form.get("client_secret").map(String::as_str) == Some(CLIENT_SECRET)
        }
    };

    if !ok_client {
        return HttpResponse::Unauthorized().json(json!({"error":"invalid_client"}));
    }

    let Some((nonce, challenge, redirect_uri, sub, email)) = s
        .codes
        .remove(form.get("code").map(String::as_str).unwrap_or(""))
    else {
        return HttpResponse::BadRequest().json(json!({"error":"invalid_grant"}));
    };

    let verifier = form.get("code_verifier").cloned().unwrap_or_default();
    let computed = URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, verifier.as_bytes()));

    if computed != challenge || form.get("redirect_uri") != Some(&redirect_uri) {
        return HttpResponse::BadRequest().json(json!({"error":"invalid_grant"}));
    }

    let mut claims = json!({
        "iss": ctx.1, "aud": CLIENT_ID, "sub": sub, "email": email,
        "email_verified": true, "iat": now(), "exp": now() + 300, "nonce": nonce,
    });

    match s.flaw {
        Some("nonce") => claims["nonce"] = json!("not-the-nonce"),
        Some("aud") => claims["aud"] = json!("someone-else"),
        Some("iss") => claims["iss"] = json!("https://evil.example"),
        Some("expired") => claims["exp"] = json!(now() - 3600),
        _ => {}
    }

    let mut id_token = sign(&claims);

    if s.flaw == Some("signature") {
        // A well-formed token whose signature belongs to other bytes.
        let mut parts: Vec<&str> = id_token.split('.').collect();
        let forged = URL_SAFE_NO_PAD.encode(json!({"sub":"admin"}).to_string());
        parts[1] = &forged;
        id_token = parts.join(".");
    }

    HttpResponse::Ok().json(json!({
        "access_token": "never-used", "token_type": "Bearer", "id_token": id_token,
    }))
}

struct Browser {
    http: reqwest::Client,
    base: String,
}

struct Landed {
    status: u16,
    location: String,
    cookie: Option<String>,
}

impl Browser {
    fn new(port: u16) -> Browser {
        Browser {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            base: format!("http://localhost:{port}"),
        }
    }

    async fn get(&self, url: &str, cookie: Option<&str>) -> Landed {
        let mut req = self.http.get(url);

        if let Some(c) = cookie {
            req = req.header("Cookie", c);
        }

        let r = req.send().await.unwrap();

        Landed {
            status: r.status().as_u16(),
            location: r
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string(),
            cookie: r
                .headers()
                .get("set-cookie")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
        }
    }

    /// Runs the whole redirect dance and returns the final Location on our server.
    async fn sign_in(&self, return_to: &str) -> (Landed, String) {
        let start = self
            .get(
                &format!(
                    "{}/oidc/start?return={}",
                    self.base,
                    urlencoding::encode(return_to)
                ),
                None,
            )
            .await;
        assert_eq!(start.status, 302, "start must redirect to the provider");
        let cookie = start.cookie.clone().expect("binding cookie");
        assert!(
            cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"),
            "{cookie}"
        );
        let binding = cookie.split(';').next().unwrap().to_string();

        let back = self.get(&start.location, None).await;
        assert_eq!(back.status, 302, "provider redirects back with a code");
        (self.get(&back.location, Some(&binding)).await, binding)
    }
}

fn ticket_of(location: &str) -> String {
    location
        .split_once("#oidc_ticket=")
        .unwrap_or_else(|| panic!("no ticket in {location}"))
        .1
        .to_string()
}

fn agent() -> (Ed25519KeyPair, String) {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let kp = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
    let did = format!(
        "did:ad:agent:{}",
        URL_SAFE_NO_PAD.encode(kp.public_key().as_ref())
    );

    (kp, did)
}

async fn post(b: &Browser, path: &str, body: Value) -> (u16, Value) {
    let r = b
        .http
        .post(format!("{}{path}", b.base))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = r.status().as_u16();

    (status, r.json().await.unwrap_or(Value::Null))
}

fn link_body(ticket: &str, kp: &Ed25519KeyPair, did: &str, recovery: &str, replace: bool) -> Value {
    let msg = format!("atomic-oidc-link:v1:{ticket}:{did}");

    json!({
        "ticket": ticket, "agent": did, "recovery": recovery, "replace": replace,
        "signature": URL_SAFE_NO_PAD.encode(kp.sign(msg.as_bytes()).as_ref()),
    })
}

fn oidc_server(name: &str, mock: &Mock, extra: &[&str]) -> u16 {
    let mut args = vec![
        "--anonymous-write-rate-limit",
        "0",
        "--oidc-issuer",
        &mock.base,
        "--oidc-client-id",
        CLIENT_ID,
        "--oidc-client-secret",
        CLIENT_SECRET,
        "--oidc-name",
        "Mock IdP",
    ];
    args.extend_from_slice(extra);

    start_server_with_args(name, &args)
}

#[tokio::test]
async fn oidc_is_off_unless_configured() {
    let port = start_server_with_args("oidc_off", &["--anonymous-write-rate-limit", "0"]);
    wait_for_server(port).await;
    let b = Browser::new(port);

    for path in ["/oidc/start", "/oidc/callback?state=x"] {
        let r = b.get(&format!("{}{path}", b.base), None).await;
        assert_eq!(r.status, 404, "{path}");
    }

    let (status, _) = post(&b, "/oidc/session", json!({"ticket":"x"})).await;
    assert_eq!(status, 404);

    let server = b
        .http
        .get(format!("{}/server", b.base))
        .header("Accept", "application/ad+json")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!server.contains("oidcProviderName"), "{server}");
}

#[tokio::test]
async fn full_sign_in_link_and_recover_across_devices() {
    let mock = Mock::start();
    mock.set_user("user-1", "alice@example.org");
    let port = oidc_server("oidc_flow", &mock, &[]);
    wait_for_server(port).await;
    let b = Browser::new(port);

    // The server advertises the provider's display name, nothing else.
    let server = b
        .http
        .get(format!("{}/server", b.base))
        .header("Accept", "application/ad+json")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        server.contains("oidcProviderName") && server.contains("Mock IdP"),
        "{server}"
    );
    assert!(
        !server.contains(CLIENT_SECRET) && !server.contains(CLIENT_ID),
        "{server}"
    );

    // First sign-in: a ticket in the URL fragment, back on the requested path.
    let (landed, _) = b.sign_in("/app/my-drive?x=1").await;
    assert_eq!(landed.status, 302);
    assert!(
        landed
            .location
            .starts_with("/app/my-drive?x=1#oidc_ticket="),
        "{}",
        landed.location
    );
    assert!(
        landed.cookie.unwrap().contains("Max-Age=0"),
        "cookie is cleared"
    );
    let ticket = ticket_of(&landed.location);

    let (status, body) = post(&b, "/oidc/session", json!({"ticket": ticket})).await;
    assert_eq!((status, &body["linked"]), (200, &json!(false)), "{body}");
    assert_eq!(body["name"], "Mock IdP");

    // Linking needs possession of the key: someone else's signature fails.
    let (kp, did) = agent();
    let (other_kp, _) = agent();
    let (status, body) = post(
        &b,
        "/oidc/link",
        link_body(&ticket, &other_kp, &did, "BLOB1", false),
    )
    .await;
    assert_eq!(status, 400, "{body}");

    let (status, body) = post(
        &b,
        "/oidc/link",
        link_body(&ticket, &kp, &did, "BLOB1", false),
    )
    .await;
    assert_eq!((status, &body["linked"]), (200, &json!(true)), "{body}");

    // The ticket was consumed by the link.
    let (status, _) = post(&b, "/oidc/session", json!({"ticket": ticket})).await;
    assert_eq!(status, 400);

    // A second device: same identity at the provider, fresh ticket, gets the blob.
    let (landed, _) = b.sign_in("/").await;
    let ticket2 = ticket_of(&landed.location);
    let (status, body) = post(&b, "/oidc/session", json!({"ticket": ticket2})).await;
    assert_eq!(status, 200);
    assert_eq!(body["linked"], true);
    assert_eq!(body["agent"], did);
    assert_eq!(body["recovery"], "BLOB1");

    // No silent overwrite; explicit replace works.
    let (kp2, did2) = agent();
    let (status, body) = post(
        &b,
        "/oidc/link",
        link_body(&ticket2, &kp2, &did2, "BLOB2", false),
    )
    .await;
    assert_eq!(
        (status, &body["error"]),
        (409, &json!("already-linked")),
        "{body}"
    );
    let (status, _) = post(
        &b,
        "/oidc/link",
        link_body(&ticket2, &kp2, &did2, "BLOB2", true),
    )
    .await;
    assert_eq!(status, 200);

    // A different person at the provider is a different identity, even with
    // the same email address: the link follows `sub`, never the email.
    mock.set_user("user-2", "alice@example.org");
    let (landed, _) = b.sign_in("/").await;
    let (_, body) = post(
        &b,
        "/oidc/session",
        json!({"ticket": ticket_of(&landed.location)}),
    )
    .await;
    assert_eq!(body["linked"], false, "{body}");

    // And the original identity changing email still finds its link.
    mock.set_user("user-1", "alice@new-address.example");
    let (landed, _) = b.sign_in("/").await;
    let t3 = ticket_of(&landed.location);
    let (_, body) = post(&b, "/oidc/session", json!({"ticket": t3})).await;
    assert_eq!(body["agent"], did2);

    // Unlinking needs a fresh proof and removes the blob.
    let (status, body) = post(&b, "/oidc/unlink", json!({"ticket": t3})).await;
    assert_eq!((status, &body["removed"]), (200, &json!(true)));
    let (landed, _) = b.sign_in("/").await;
    let (_, body) = post(
        &b,
        "/oidc/session",
        json!({"ticket": ticket_of(&landed.location)}),
    )
    .await;
    assert_eq!(body["linked"], false);
}

#[tokio::test]
async fn rejects_forged_replayed_and_foreign_logins() {
    let mock = Mock::start();
    mock.set_user("user-1", "alice@example.org");
    let port = oidc_server("oidc_attacks", &mock, &[]);
    wait_for_server(port).await;
    let b = Browser::new(port);

    // Open redirect: a hostile return URL falls back to a local path.
    for evil in [
        "https://evil.example/x",
        "//evil.example",
        "/\\evil.example",
    ] {
        let (landed, _) = b.sign_in(evil).await;
        assert!(
            landed.location.starts_with("/#oidc_ticket="),
            "{evil} -> {}",
            landed.location
        );
    }

    // Login CSRF: the callback is only honoured in the browser that started it.
    let start = b.get(&format!("{}/oidc/start", b.base), None).await;
    let back = b.get(&start.location, None).await;
    let no_cookie = b.get(&back.location, None).await;
    assert_eq!(no_cookie.status, 400);
    assert!(!no_cookie.location.contains("oidc_ticket"));
    let wrong = b.get(&back.location, Some("atomic_oidc=nope")).await;
    assert_eq!(wrong.status, 400);

    // The state is single use: even the right cookie cannot replay it after a failed try.
    let binding = start.cookie.unwrap().split(';').next().unwrap().to_string();
    let replay = b.get(&back.location, Some(&binding)).await;
    assert_eq!(replay.status, 400, "state was spent by the foreign attempt");

    // Unknown state.
    assert_eq!(
        b.get(
            &format!("{}/oidc/callback?state=made-up&code=x", b.base),
            Some(&binding)
        )
        .await
        .status,
        400
    );

    // Provider-side denial surfaces as a fixed code, never provider text.
    let start = b
        .get(&format!("{}/oidc/start?return=/x", b.base), None)
        .await;
    let binding = start
        .cookie
        .clone()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let state = url::Url::parse(&start.location)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .to_string();
    let denied = b
        .get(
            &format!(
                "{}/oidc/callback?error=access_denied&error_description=<script>&state={state}",
                b.base
            ),
            Some(&binding),
        )
        .await;
    assert_eq!(denied.location, "/x#oidc_error=denied");

    // Every way an ID token can be wrong ends in the same fixed error.
    for flaw in ["nonce", "aud", "iss", "expired", "signature"] {
        mock.set_flaw(Some(flaw));
        let (landed, _) = b.sign_in("/").await;
        assert_eq!(landed.location, "/#oidc_error=provider", "{flaw}");
    }
    mock.set_flaw(None);

    // PKCE and the auth code are single use at the provider as well: nothing
    // we hold lets a second token request succeed.
    let (landed, _) = b.sign_in("/").await;
    assert!(landed.location.contains("oidc_ticket="));
}

#[tokio::test]
async fn email_domain_and_unreachable_provider_policy() {
    let mock = Mock::start();
    mock.set_user("user-1", "mallory@evil.example");
    let port = oidc_server(
        "oidc_policy",
        &mock,
        &["--oidc-allowed-email-domains", "example.org,corp.example"],
    );
    wait_for_server(port).await;
    let b = Browser::new(port);

    let (landed, _) = b.sign_in("/").await;
    assert_eq!(landed.location, "/#oidc_error=policy");

    mock.set_user("user-1", "alice@corp.example");
    let (landed, _) = b.sign_in("/").await;
    assert!(
        landed.location.contains("oidc_ticket="),
        "{}",
        landed.location
    );

    // A server whose provider cannot be reached degrades to an error code on
    // the sign-in page, not a crash.
    let dead = Mock {
        base: "http://127.0.0.1:1".into(),
        state: Default::default(),
    };
    let port = oidc_server("oidc_dead", &dead, &[]);
    wait_for_server(port).await;
    let b2 = Browser::new(port);
    let start = b2
        .get(&format!("{}/oidc/start?return=/y", b2.base), None)
        .await;
    assert_eq!(start.location, "/y#oidc_error=provider");
}
