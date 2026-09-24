//! Host crypto for plugin routes through the app (#1718): signed requests,
//! the installation key, tokens, the consent flow, and that no key material
//! reaches a plugin. The inbox fixture (`testdata/plugin-routes/inbox/`) at
//! `--plugin-routes read-write`.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use actix_web::{http::header, test as actix_test, web, App};
use atomic_lib::{db::app_agent::AppAgentKey, urls, Storelike, Value};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value as Json};

use crate::plugins::{
    http_signatures::{self, Algorithm, Outbound, PublicKey, Signer},
    route_auth::KeyFetch,
    route_exec::RouteExecutor,
    route_keys,
    route_registry::slug,
    route_tokens,
    test_fixture::{fixture_with_args, genesis, inbox_release, install_release_with, Fixture},
};

macro_rules! app {
    ($appstate:expr) => {
        actix_test::init_service(
            App::new()
                .app_data(web::Data::new($appstate.clone()))
                .configure(crate::routes::config_routes),
        )
        .await
    };
}

/// Key documents from memory; counts fetches.
#[derive(Default)]
struct Documents {
    docs: Mutex<HashMap<String, Vec<u8>>>,
    fetches: AtomicUsize,
}

#[async_trait::async_trait]
impl KeyFetch for Documents {
    async fn fetch(&self, url: &url::Url) -> Result<Vec<u8>, String> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        self.docs
            .lock()
            .unwrap()
            .get(url.as_str())
            .cloned()
            .ok_or_else(|| "404".to_string())
    }
}

struct Inbox {
    f: Fixture,
    inbox: String,
    installation: String,
    prefix: String,
    documents: Arc<Documents>,
}

async fn setup(name: &str) -> Inbox {
    let mut f = fixture_with_args(name, &["--plugin-routes", "read-write"]).await;
    let documents = Arc::new(Documents::default());
    f.appstate.route_exec = Arc::new(RouteExecutor::default().with_key_fetch(documents.clone()));
    let store = &f.appstate.store;
    let inbox = genesis(
        store,
        vec![
            (urls::PARENT, Value::AtomicUrl(f.drive.as_str().into())),
            (urls::NAME, Value::String("Inbox".into())),
        ],
    )
    .await;
    let installation = install_release_with(
        &f,
        &inbox_release(),
        Some(inbox_release().manifest["http"]["writeTargets"].clone()),
        Some(json!({ "inbox": inbox })),
    )
    .await
    .unwrap();
    let agent = store
        .get_app_agent_info(&AppAgentKey::new(&f.drive, &installation))
        .unwrap()
        .unwrap()
        .agent;
    let mut resource = store.get_resource(&inbox.as_str().into()).await.unwrap();
    resource
        .set_unsafe(
            urls::WRITE.into(),
            Value::ResourceArray(vec![agent.as_str().into()]),
        )
        .unwrap();
    resource.save(store).await.unwrap();
    let prefix = format!("/_routes/{}", slug(&installation));
    Inbox {
        f,
        inbox,
        installation,
        prefix,
        documents,
    }
}

/// Every request goes to `localhost`, so the URLs a plugin builds from
/// `request.base` are the ones a signer signs.
fn get(uri: &str) -> actix_test::TestRequest {
    actix_test::TestRequest::get()
        .uri(uri)
        .insert_header((header::HOST, "localhost"))
}

fn post(uri: &str, body: &str, headers: &[(String, String)]) -> actix_test::TestRequest {
    let mut request = actix_test::TestRequest::post()
        .uri(uri)
        .insert_header((header::HOST, "localhost"))
        .insert_header((header::CONTENT_TYPE, "application/activity+json"))
        .set_payload(body.to_string());
    for (name, value) in headers {
        if name != "host" {
            request = request.insert_header((name.as_str(), value.as_str()));
        }
    }
    request
}

/// Signed as the store's default agent, who owns the drive and the
/// Installation.
fn signed(
    appstate: &crate::appstate::AppState,
    method: &str,
    path: &str,
) -> actix_test::TestRequest {
    let origin = appstate.config.get_origin();
    let headers = atomic_lib::client::get_authentication_headers(
        &format!("{origin}{path}"),
        &appstate.store.get_default_agent().unwrap(),
    )
    .unwrap();
    let mut request = match method {
        "POST" => actix_test::TestRequest::post(),
        _ => actix_test::TestRequest::get(),
    }
    .uri(path);
    let authority = url::Url::parse(&origin).unwrap();
    let authority = match authority.port() {
        Some(port) => format!("{}:{port}", authority.host_str().unwrap()),
        None => authority.host_str().unwrap().to_string(),
    };
    request = request.insert_header((header::HOST, authority));
    for (key, value) in headers {
        request = request.insert_header((key, value));
    }
    request
}

async fn json_of<B: actix_web::body::MessageBody>(
    resp: actix_web::dev::ServiceResponse<B>,
) -> Json {
    actix_test::read_body_json(resp).await
}

struct Ed(ed25519_dalek::SigningKey);
impl Signer for Ed {
    fn algorithm(&self) -> Algorithm {
        Algorithm::Ed25519
    }
    fn sign(&self, data: &[u8]) -> Vec<u8> {
        use ed25519_dalek::Signer as _;
        self.0.sign(data).to_bytes().to_vec()
    }
}

const BOB: &str = "https://remote.example/users/bob";
const BOB_KEY: &str = "https://remote.example/users/bob#main-key";

fn bob_document(key: &ed25519_dalek::SigningKey) -> Vec<u8> {
    json!({
        "id": BOB,
        "type": "Person",
        "publicKey": {
            "id": BOB_KEY,
            "owner": BOB,
            "publicKeyPem": PublicKey::Ed25519(key.verifying_key()).to_pem(),
        }
    })
    .to_string()
    .into_bytes()
}

fn sign_as(
    key: &ed25519_dalek::SigningKey,
    rfc: bool,
    path: &str,
    body: &str,
    at: std::time::SystemTime,
) -> Vec<(String, String)> {
    let url = url::Url::parse(&format!("http://localhost{path}")).unwrap();
    let outbound = Outbound {
        method: "POST",
        url: &url,
        body: Some(body.as_bytes()),
    };
    if rfc {
        http_signatures::sign_rfc9421(&Ed(key.clone()), BOB_KEY, &outbound, at)
    } else {
        http_signatures::sign_cavage(&Ed(key.clone()), BOB_KEY, &outbound, at)
    }
}

async fn children(i: &Inbox) -> Vec<atomic_lib::Resource> {
    let store = &i.f.appstate.store;
    let mut out = Vec::new();
    for child in store
        .get_resource(&i.inbox.as_str().into())
        .await
        .unwrap()
        .get_children(store)
        .await
        .unwrap()
    {
        out.push(store.get_resource(child.get_subject()).await.unwrap());
    }
    out
}

#[actix_rt::test]
async fn a_signed_post_is_verified_and_fills_the_caller() {
    let i = setup("route_crypto_signed").await;
    let app = app!(i.f.appstate);
    let bob = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
    i.documents
        .docs
        .lock()
        .unwrap()
        .insert(BOB.into(), bob_document(&bob));
    let path = format!("{}/signed-inbox", i.prefix);
    let body = r#"{"name":"followed","type":"Follow"}"#;
    let now = std::time::SystemTime::now();

    // Signed the fediverse way: verified, and the handler sees the caller.
    let resp = actix_test::call_service(
        &app,
        post(&path, body, &sign_as(&bob, false, &path, body, now)).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 202);
    let answer = json_of(resp).await;
    let caller = &answer["caller"];
    assert_eq!(caller["keyId"], BOB_KEY);
    assert_eq!(caller["owner"], BOB);
    assert_eq!(caller["scheme"], "draft-cavage-12");
    assert_eq!(caller["alg"], "ed25519");
    // The verified caller is the stored item's provenance (AS-07).
    let items = children(&i).await;
    assert_eq!(items.len(), 1);
    let provenance = match items[0].get(urls::ROUTE_PROVENANCE).unwrap() {
        Value::Json(json) => json.clone(),
        other => serde_json::from_str(&other.to_string()).unwrap(),
    };
    assert_eq!(&provenance["caller"], caller);
    assert_eq!(provenance["route"], "signed-inbox");
    // And RFC 9421 the same way.
    let resp = actix_test::call_service(
        &app,
        post(&path, body, &sign_as(&bob, true, &path, body, now)).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 202);
    assert_eq!(json_of(resp).await["caller"]["scheme"], "rfc9421");
    // The key was fetched once, then cached.
    assert_eq!(i.documents.fetches.load(Ordering::SeqCst), 1);

    // Refused: a signature by another key, a body that is not the signed
    // one, a stale date, no signature at all.
    let mallory = ed25519_dalek::SigningKey::generate(&mut rand::rngs::OsRng);
    let stale = now - std::time::Duration::from_secs(600);
    type Case<'a> = (&'a str, Vec<(String, String)>, &'a str, &'a str);
    let cases: Vec<Case> = vec![
        (
            "another key",
            sign_as(&mallory, false, &path, body, now),
            body,
            "does not verify",
        ),
        (
            "another body",
            sign_as(&bob, false, &path, body, now),
            r#"{"name":"swapped"}"#,
            "Digest",
        ),
        (
            "a stale date",
            sign_as(&bob, true, &path, body, stale),
            body,
            "seconds",
        ),
        ("no signature", vec![], body, "not signed"),
    ];
    for (name, headers, sent, reason) in cases {
        let resp = actix_test::call_service(&app, post(&path, sent, &headers).to_request()).await;
        assert_eq!(resp.status(), 401, "{name}");
        assert!(resp
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("Signature realm="));
        let problem = json_of(resp).await;
        assert_eq!(problem["type"], "route-unauthorized", "{name}");
        assert!(
            problem["detail"].as_str().unwrap().contains(reason),
            "{name}: {problem}"
        );
    }
    // Nothing more was stored, no refusal cost a fetch, and none started the
    // sandbox: their run-log entries have no fuel.
    assert_eq!(children(&i).await.len(), 2);
    assert_eq!(i.documents.fetches.load(Ordering::SeqCst), 1);
    let status = i.f.appstate.route_exec.status(
        &i.installation,
        &[("signed-inbox".into(), String::new())],
        atomic_lib::utils::now(),
    );
    let refused: Vec<&Json> = status["runs"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["status"] == 401)
        .collect();
    assert_eq!(refused.len(), 4);
    assert!(refused.iter().all(|r| r.get("fuel").is_none()), "{status}");
}

#[actix_rt::test]
async fn the_host_signs_with_the_installation_key_and_verifies_its_own() {
    let i = setup("route_crypto_own_key").await;
    let app = app!(i.f.appstate);
    // The actor publishes the key's public half.
    let resp =
        actix_test::call_service(&app, get(&format!("{}/actor", i.prefix)).to_request()).await;
    assert_eq!(resp.status(), 200);
    let actor = json_of(resp).await;
    let actor_id = format!("http://localhost{}/actor", i.prefix);
    assert_eq!(actor["id"], actor_id);
    assert_eq!(actor["publicKey"]["id"], format!("{actor_id}#main-key"));
    let pem = actor["publicKey"]["publicKeyPem"].as_str().unwrap();
    let PublicKey::Rsa(public) = PublicKey::from_pem(pem).unwrap() else {
        panic!("rsa-sha256 publishes an RSA key")
    };

    // The host signs a delivery on the plugin's behalf.
    let inbox = format!("http://localhost{}/signed-inbox", i.prefix);
    let activity = r#"{"type":"Create","name":"from myself"}"#;
    let resp = actix_test::call_service(
        &app,
        post(
            &format!("{}/outbox", i.prefix),
            &json!({"to": inbox, "activity": activity}).to_string(),
            &[],
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let signed = json_of(resp).await;
    assert_eq!(signed["format"], "draft-cavage-12");
    assert_eq!(signed["alg"], "rsa-v1_5-sha256");
    let headers: Vec<(String, String)> = signed["headers"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
        .collect();
    let header = |name: &str| {
        headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.clone())
            .unwrap()
    };

    // Verified independently: the RSA crate alone, the published PEM, and
    // the signing string rebuilt from the headers.
    let signature = header("signature");
    let value = signature
        .split("signature=\"")
        .nth(1)
        .unwrap()
        .trim_end_matches('"');
    let string = format!(
        "(request-target): post {}/signed-inbox\nhost: localhost\ndate: {}\ndigest: {}",
        i.prefix,
        header("date"),
        header("digest")
    );
    use rsa::signature::Verifier;
    rsa::pkcs1v15::VerifyingKey::<sha2::Sha256>::new(public)
        .verify(
            string.as_bytes(),
            &rsa::pkcs1v15::Signature::try_from(&B64.decode(value).unwrap()[..]).unwrap(),
        )
        .expect("the published key verifies the host's signature");

    // Delivered to this node's own signed inbox, it verifies without a
    // fetch: the keyId is in the installation's own route space.
    let path = format!("{}/signed-inbox", i.prefix);
    let resp = actix_test::call_service(&app, post(&path, activity, &headers).to_request()).await;
    assert_eq!(resp.status(), 202);
    let caller = &json_of(resp).await["caller"];
    assert_eq!(caller["keyId"], format!("{actor_id}#main-key"));
    assert_eq!(caller["owner"], actor_id);
    assert_eq!(caller["alg"], "rsa-v1_5-sha256");
    assert_eq!(i.documents.fetches.load(Ordering::SeqCst), 0);
    // The signature is in the run log with its operation id.
    let status = i.f.appstate.route_exec.status(
        &i.installation,
        &[("outbox".into(), String::new())],
        atomic_lib::utils::now(),
    );
    assert!(
        status.to_string().contains("for operation `deliver`"),
        "{status}"
    );
    // A keyId on another host is not bound, even under `/_routes/<slug>/`.
    let resp =
        actix_test::call_service(&app, get(&format!("{}/dump", i.prefix)).to_request()).await;
    assert_eq!(resp.status(), 200);
    let store = &i.f.appstate.store;
    assert!(route_keys::local_key(store, "https://elsewhere.example/k").is_none());
    assert!(route_keys::local_key(store, &format!("{actor_id}#main-key")).is_some());
}

#[actix_rt::test]
async fn bearer_tokens_are_issued_verified_listed_and_revoked() {
    let i = setup("route_crypto_tokens").await;
    let app = app!(i.f.appstate);
    let tokens = format!("{}/tokens", i.prefix);
    let resp = actix_test::call_service(
        &app,
        post(
            &tokens,
            &json!({"op": "issue", "scopes": ["notes:r"], "client": "https://app.example", "expiresIn": 3600}).to_string(),
            &[],
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    let issued = json_of(resp).await;
    let token = issued["token"].as_str().unwrap().to_string();
    let id = issued["id"].as_str().unwrap().to_string();
    assert!(token.starts_with(route_tokens::TOKEN_TEXT_PREFIX));

    let storage = format!("{}/storage/notes/a", i.prefix);
    let with = |t: &str| {
        get(&storage)
            .insert_header((header::AUTHORIZATION, format!("Bearer {t}")))
            .to_request()
    };
    let resp = actix_test::call_service(&app, with(&token)).await;
    assert_eq!(resp.status(), 200);
    let answer = json_of(resp).await;
    assert_eq!(answer["caller"]["token"]["id"], id);
    assert_eq!(answer["caller"]["token"]["scopes"], json!(["notes:r"]));
    assert_eq!(answer["caller"]["token"]["client"], "https://app.example");
    assert_eq!(answer["path"], "notes/a");
    // The handler never sees the Authorization header itself.
    for (name, request) in [
        ("no token", get(&storage).to_request()),
        ("another token", with("atr_not-a-token")),
    ] {
        let resp = actix_test::call_service(&app, request).await;
        assert_eq!(resp.status(), 401, "{name}");
        assert!(resp
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("Bearer realm="));
    }
    // verify, from a handler.
    let resp = actix_test::call_service(
        &app,
        post(
            &tokens,
            &json!({"op": "verify", "token": token}).to_string(),
            &[],
        )
        .to_request(),
    )
    .await;
    assert_eq!(json_of(resp).await["token"]["id"], id);

    // People list and revoke through the host, never seeing a token.
    let list_path = format!(
        "/plugin-route-tokens?installation={}",
        urlencoding(&i.installation)
    );
    let resp =
        actix_test::call_service(&app, signed(&i.f.appstate, "GET", &list_path).to_request()).await;
    assert_eq!(resp.status(), 200);
    let listed = json_of(resp).await;
    assert_eq!(listed["tokens"][0]["id"], id);
    assert!(!listed.to_string().contains(&token[4..]));
    // Unsigned: refused.
    let resp = actix_test::call_service(&app, get(&list_path).to_request()).await;
    assert_eq!(resp.status(), 401);
    let revoke_path = format!("{list_path}&revoke={id}");
    let resp = actix_test::call_service(
        &app,
        signed(&i.f.appstate, "POST", &revoke_path).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(json_of(resp).await["revoked"], true);
    let resp = actix_test::call_service(&app, with(&token)).await;
    assert_eq!(resp.status(), 401);

    // A handler revokes too.
    let resp = actix_test::call_service(
        &app,
        post(
            &tokens,
            &json!({"op": "issue", "name": "storage"}).to_string(),
            &[],
        )
        .to_request(),
    )
    .await;
    let second = json_of(resp).await;
    let resp = actix_test::call_service(
        &app,
        post(
            &tokens,
            &json!({"op": "revoke", "id": second["id"]}).to_string(),
            &[],
        )
        .to_request(),
    )
    .await;
    assert_eq!(json_of(resp).await["revoked"], true);
    let resp = actix_test::call_service(&app, with(second["token"].as_str().unwrap())).await;
    assert_eq!(resp.status(), 401);
}

fn urlencoding(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn query_of(url: &str) -> HashMap<String, String> {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

#[actix_rt::test]
async fn the_consent_flow_gives_a_token_for_exactly_what_was_approved() {
    let i = setup("route_crypto_consent").await;
    let app = app!(i.f.appstate);
    let origin = i.f.appstate.config.get_origin();
    let start = |state: &str| {
        get(&format!(
            "{}/oauth?scope=notes:rw&client_id={}&state={state}",
            i.prefix,
            urlencoding("https://app.example")
        ))
        .to_request()
    };

    // The route redirects to the host's page on the API origin.
    let resp = actix_test::call_service(&app, start("xyz")).await;
    assert_eq!(resp.status(), 302);
    let location = resp
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        location.starts_with(&format!("{origin}/app/route-consent?request=")),
        "{location}"
    );
    let request = query_of(&location)["request"].clone();

    // The page shows what is asked, to someone who may manage the plugin.
    let consent = format!("/plugin-route-consent?request={request}");
    let resp = actix_test::call_service(&app, get(&consent).to_request()).await;
    assert_eq!(resp.status(), 401);
    let resp =
        actix_test::call_service(&app, signed(&i.f.appstate, "GET", &consent).to_request()).await;
    assert_eq!(resp.status(), 200);
    let shown = json_of(resp).await;
    assert_eq!(shown["scopes"], json!(["notes:rw"]));
    assert_eq!(shown["client"], "https://app.example");
    assert_eq!(shown["token"]["name"], "storage");
    assert!(shown["token"]["reason"]
        .as_str()
        .unwrap()
        .contains("Bearer tokens"));
    assert_eq!(shown["redirectOrigin"], "http://localhost");

    // Approving needs Atomic headers over this exact answer.
    let approve = format!("{consent}&decision=approve");
    let resp = actix_test::call_service(
        &app,
        actix_test::TestRequest::post()
            .uri(&approve)
            .insert_header((header::COOKIE, "atomic_session=whatever"))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 401);
    let resp =
        actix_test::call_service(&app, signed(&i.f.appstate, "POST", &approve).to_request()).await;
    assert_eq!(resp.status(), 200);
    let redirect = json_of(resp).await["redirect"]
        .as_str()
        .unwrap()
        .to_string();
    let callback = format!("http://localhost{}/oauth/callback?", i.prefix);
    assert!(redirect.starts_with(&callback), "{redirect}");
    let q = query_of(&redirect);
    assert_eq!(q["state"], "xyz");
    // Answered once.
    let resp =
        actix_test::call_service(&app, signed(&i.f.appstate, "POST", &approve).to_request()).await;
    assert_eq!(resp.status(), 404);

    // The route redeems the code for a token with the approved scopes.
    let back = redirect.trim_start_matches("http://localhost").to_string();
    let resp = actix_test::call_service(&app, get(&back).to_request()).await;
    assert_eq!(resp.status(), 200);
    let issued = json_of(resp).await;
    assert_eq!(issued["scopes"], json!(["notes:rw"]));
    assert_eq!(issued["client"], "https://app.example");
    assert_eq!(issued["state"], "xyz");
    assert_eq!(
        issued["approvedBy"],
        i.f.appstate
            .store
            .get_default_agent()
            .unwrap()
            .subject
            .to_string()
    );
    let token = issued["token"].as_str().unwrap();
    let resp = actix_test::call_service(
        &app,
        get(&format!("{}/storage/x", i.prefix))
            .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
            .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    // A code is good once.
    let resp = actix_test::call_service(&app, get(&back).to_request()).await;
    assert_eq!(resp.status(), 502);

    // Denied: the route hears `access_denied`, and there is no code.
    let resp = actix_test::call_service(&app, start("abc")).await;
    let request = query_of(
        resp.headers()
            .get(header::LOCATION)
            .unwrap()
            .to_str()
            .unwrap(),
    )["request"]
        .clone();
    let deny = format!("/plugin-route-consent?request={request}&decision=deny");
    let resp =
        actix_test::call_service(&app, signed(&i.f.appstate, "POST", &deny).to_request()).await;
    let redirect = json_of(resp).await["redirect"]
        .as_str()
        .unwrap()
        .to_string();
    let q = query_of(&redirect);
    assert_eq!(q["error"], "access_denied");
    assert!(!q.contains_key("code"));
    let resp = actix_test::call_service(
        &app,
        get(redirect.trim_start_matches("http://localhost")).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 403);
}

#[actix_rt::test]
async fn no_key_material_reaches_the_plugin_its_answers_or_the_run_log() {
    let i = setup("route_crypto_no_leak").await;
    let app = app!(i.f.appstate);
    let store = &i.f.appstate.store;
    // Generated on activation, before any route ran.
    let private = route_keys::tests::private_base64(store, &i.installation, "actor-key");
    let der = B64.decode(&private).unwrap();
    use rsa::pkcs8::DecodePrivateKey;
    use rsa::traits::PrivateKeyParts;
    let key = rsa::RsaPrivateKey::from_pkcs8_der(&der).unwrap();
    let d = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key.d().to_bytes_be());
    let d_std = B64.encode(key.d().to_bytes_be());
    let needles = [
        private[..40].to_string(),
        private[private.len() / 2..private.len() / 2 + 40].to_string(),
        d[..40].to_string(),
        d_std[..40].to_string(),
    ];
    let clean = |what: &str, text: &str| {
        for needle in &needles {
            assert!(
                !text.contains(needle.as_str()),
                "{what} carries key material"
            );
        }
    };

    // Everything a handler can see, and every answer the key calls give.
    let resp =
        actix_test::call_service(&app, get(&format!("{}/dump", i.prefix)).to_request()).await;
    assert_eq!(resp.status(), 200);
    let dump = json_of(resp).await;
    clean("the plugin's view", &dump.to_string());
    assert!(dump["publicKey"]["publicKeyPem"]
        .as_str()
        .unwrap()
        .starts_with("-----BEGIN PUBLIC KEY-----"));
    assert!(dump["signed"]["headers"]["signature"].is_string());
    assert!(dump["undeclared"]["error"]
        .as_str()
        .unwrap()
        .contains("declares no key"));
    assert!(dump["exported"].as_str().unwrap().contains("no host call"));
    assert!(dump["request"]["headers"].get("authorization").is_none());

    // The actor, a signing answer, refusals, and the route status.
    let resp =
        actix_test::call_service(&app, get(&format!("{}/actor", i.prefix)).to_request()).await;
    clean("the actor", &json_of(resp).await.to_string());
    let resp = actix_test::call_service(
        &app,
        post(
            &format!("{}/outbox", i.prefix),
            &json!({"to": "https://b.example/inbox", "activity": "{}"}).to_string(),
            &[],
        )
        .to_request(),
    )
    .await;
    clean("a signing answer", &json_of(resp).await.to_string());
    let resp = actix_test::call_service(
        &app,
        post(&format!("{}/signed-inbox", i.prefix), "{}", &[]).to_request(),
    )
    .await;
    assert_eq!(resp.status(), 401);
    clean("a refusal", &json_of(resp).await.to_string());
    let status = i.f.appstate.route_exec.status(
        &i.installation,
        &[
            ("dump".into(), String::new()),
            ("outbox".into(), String::new()),
        ],
        atomic_lib::utils::now(),
    );
    clean("the route status", &status.to_string());
}

#[actix_rt::test]
async fn keys_and_tokens_are_made_on_activation_and_erased_on_revocation() {
    let i = setup("route_crypto_lifecycle").await;
    let app = app!(i.f.appstate);
    let store = &i.f.appstate.store;
    assert!(!route_keys::tests::private_base64(store, &i.installation, "actor-key").is_empty());
    let resp = actix_test::call_service(
        &app,
        post(
            &format!("{}/tokens", i.prefix),
            &json!({"op": "issue"}).to_string(),
            &[],
        )
        .to_request(),
    )
    .await;
    assert_eq!(resp.status(), 200);
    assert_eq!(route_tokens::list(store, &i.installation).len(), 1);
    // Bind the actor's keyId.
    actix_test::call_service(&app, get(&format!("{}/actor", i.prefix)).to_request()).await;
    let key_id = format!("http://localhost{}/actor#main-key", i.prefix);
    assert!(route_keys::local_key(store, &key_id).is_some());

    let mut installation = store
        .get_resource(&i.installation.as_str().into())
        .await
        .unwrap();
    installation
        .set_unsafe(
            urls::INSTALLATION_STATUS.into(),
            Value::String("revoked".into()),
        )
        .unwrap();
    installation.save(store).await.unwrap();

    assert!(route_tokens::list(store, &i.installation).is_empty());
    assert!(route_keys::local_key(store, &key_id).is_none());
    assert_eq!(
        route_keys::erase(store, &i.installation),
        0,
        "already erased"
    );
}
