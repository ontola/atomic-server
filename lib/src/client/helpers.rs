//! Functions for interacting with an Atomic Server
use crate::{
    agents::Agent,
    commit::sign_message,
    errors::AtomicResult,
    parse::{parse_json_ad_string, ParseOpts},
    storelike::ResourceResponse,
    Resource, Storelike,
};

// ---------------------------------------------------------------------------
// SSRF guard for outbound fetches of caller-supplied URLs.
//
// `fetch_body` fetches URLs that can originate from an unauthenticated caller
// (the `/bookmark` and `/import` endpoints pass a `url` parameter straight
// through, and endpoint dispatch returns before the `check_read` auth gate).
// It previously only checked `url.starts_with("http")`, so an attacker could
// make the server GET internal-only hosts — loopback services, RFC1918/CGNAT
// hosts, and the link-local cloud-metadata endpoint (169.254.169.254) — and,
// via bookmark, read the response back (full-response SSRF).
//
// ureq calls the configured `Resolver` for every connection — the initial one
// AND each redirect hop, for both domain and IP-literal hosts — so a resolver
// that filters out non-public addresses closes the SSRF, DNS-rebinding, and
// redirect-to-internal vectors in one place. A scheme check additionally
// rejects non-http(s) URLs (e.g. `file://`).
//
// Escape hatch: `ATOMIC_ALLOW_PRIVATE_FETCH=1` disables the guard for
// deployments that intentionally fetch internal hosts (e.g. LAN federation,
// which also flows through `fetch_body`). Secure by default.
mod ssrf_guard {
    use crate::errors::AtomicResult;
    use std::io;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};

    pub fn allow_private_fetch() -> bool {
        static ALLOW: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *ALLOW.get_or_init(|| {
            matches!(
                std::env::var("ATOMIC_ALLOW_PRIVATE_FETCH").as_deref(),
                Ok("1") | Ok("true") | Ok("TRUE")
            )
        })
    }

    fn ipv4_is_blocked(v4: Ipv4Addr) -> bool {
        let o = v4.octets();
        v4.is_loopback()        // 127.0.0.0/8
            || v4.is_private()    // 10/8, 172.16/12, 192.168/16
            || v4.is_link_local() // 169.254.0.0/16 — cloud metadata
            || v4.is_broadcast()  // 255.255.255.255
            || v4.is_unspecified()// 0.0.0.0
            || o[0] == 0          // 0.0.0.0/8 "this network"
            || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 CGNAT
    }

    /// True for any address a caller-supplied fetch must never reach.
    pub fn ip_is_blocked(ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(v4) => ipv4_is_blocked(v4),
            IpAddr::V6(v6) => {
                // ::ffff:127.0.0.1 reaches the same host as its v4 form.
                if let Some(mapped) = v6.to_ipv4_mapped() {
                    return ipv4_is_blocked(mapped);
                }
                let seg0 = v6.segments()[0];
                v6.is_loopback()               // ::1
                    || v6.is_unspecified()      // ::
                    || v6.is_multicast()        // ff00::/8
                    || (seg0 & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                    || (seg0 & 0xffc0) == 0xfe80 // fe80::/10 link-local
            }
        }
    }

    /// Reject non-http(s) schemes and URLs whose host is a literal internal IP.
    /// Domains pass here and are screened by [`guarded_resolve`] at connect
    /// time. Runs even with the escape hatch on — `file://` is never wanted.
    pub fn preflight(url: &str, allow_private: bool) -> AtomicResult<()> {
        let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL '{url}': {e}"))?;
        match parsed.scheme() {
            "http" | "https" => {}
            other => return Err(format!(
                "Refusing to fetch '{url}': unsupported scheme '{other}' (only http/https allowed)"
            )
            .into()),
        }
        if allow_private {
            return Ok(());
        }
        // Typed host so IPv6 literals (`[::1]`) are recognised.
        let literal_ip = match parsed.host() {
            Some(url::Host::Ipv4(v4)) => Some(IpAddr::V4(v4)),
            Some(url::Host::Ipv6(v6)) => Some(IpAddr::V6(v6)),
            _ => None,
        };
        if let Some(ip) = literal_ip {
            if ip_is_blocked(ip) {
                return Err(format!(
                    "Refusing to fetch '{url}': {ip} is a non-public (internal) address (SSRF guard). \
                     Set ATOMIC_ALLOW_PRIVATE_FETCH=1 to override."
                )
                .into());
            }
        }
        Ok(())
    }

    /// ureq [`Resolver`](ureq::Resolver): resolve `netloc` (host:port), then
    /// drop any non-public address before ureq can connect to it. Errors if a
    /// host resolves *solely* to internal addresses. Applied to every hop.
    pub fn guarded_resolve(netloc: &str) -> io::Result<Vec<SocketAddr>> {
        let all: Vec<SocketAddr> = netloc.to_socket_addrs()?.collect();
        let safe: Vec<SocketAddr> = all
            .into_iter()
            .filter(|sa| !ip_is_blocked(sa.ip()))
            .collect();
        if safe.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "SSRF guard: refusing to connect to '{netloc}' — resolves only to internal \
                     (loopback/private/link-local) addresses"
                ),
            ));
        }
        Ok(safe)
    }
}

/// Fetches a resource, makes sure its subject matches.
/// Checks the datatypes for the Values.
/// Ignores all atoms where the subject is different.
/// WARNING: Calls store methods, and is called by store methods, might get stuck in a loop!
#[tracing::instrument(skip(store), level = "info")]
pub async fn fetch_resource(
    subject: &str,
    store: &impl Storelike,
    client_agent: Option<&Agent>,
) -> AtomicResult<ResourceResponse> {
    let body = fetch_body(subject, crate::parse::JSON_AD_MIME, client_agent)?;
    let resources = Box::pin(parse_json_ad_string(&body, store, &ParseOpts::default()))
        .await
        .map_err(|e| format!("Error parsing body of {}. {}", subject, e))?;

    if resources.len() == 1 {
        Ok(ResourceResponse::Resource(resources[0].clone()))
    } else {
        let mut main_resource: Option<Resource> = None;
        let mut referenced: Vec<Resource> = Vec::new();

        for r in resources {
            if r.get_subject() == subject {
                main_resource = Some(r);
            } else {
                referenced.push(r);
            }
        }

        let Some(main_resource) = main_resource else {
            return Err(format!(
                "Requested subject not found in returned resources: {}",
                subject
            )
            .into());
        };

        Ok(ResourceResponse::ResourceWithReferenced(
            main_resource,
            referenced,
        ))
    }
}

/// Returns the various x-atomic authentication headers, includign agent signature
pub fn get_authentication_headers(url: &str, agent: &Agent) -> AtomicResult<Vec<(String, String)>> {
    let mut headers = Vec::new();
    let now = crate::utils::now().to_string();
    let message = format!("{} {}", url, now);
    let signature = sign_message(
        &message,
        agent
            .private_key
            .as_ref()
            .ok_or("No private key in agent")?,
        &agent.public_key,
    )?;
    headers.push(("x-atomic-public-key".into(), agent.public_key.to_string()));
    headers.push(("x-atomic-signature".into(), signature));
    headers.push(("x-atomic-timestamp".into(), now));
    headers.push(("x-atomic-agent".into(), agent.subject.to_string()));
    Ok(headers)
}

/// Fetches a URL, returns its body.
/// Uses the store's Agent agent (if set) to sign the request.
#[tracing::instrument(level = "info")]
pub fn fetch_body(
    url: &str,
    content_type: &str,
    client_agent: Option<&Agent>,
) -> AtomicResult<String> {
    // Scheme + SSRF guard. See the `ssrf_guard` module above.
    let allow_private = ssrf_guard::allow_private_fetch();
    ssrf_guard::preflight(url, allow_private)?;

    let mut builder = ureq::builder().timeout(std::time::Duration::from_secs(2));
    if !allow_private {
        builder = builder.redirects(10).resolver(ssrf_guard::guarded_resolve);
    }
    let client = builder.build();

    let mut req = client.get(url);
    if let Some(agent) = client_agent {
        let headers = get_authentication_headers(url, agent)?;
        for (key, value) in headers {
            req = req.set(key.as_str(), value.as_str());
        }
    }

    let resp = match req.set("Accept", content_type).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, response)) => {
            let body = response
                .into_string()
                .unwrap_or_else(|_| "<failed to read response body>".to_string());
            return Err(format!(
                "Error when fetching {}: Status: {}. Body: {}",
                url, status, body
            )
            .into());
        }
        Err(e) => return Err(format!("Error when fetching {}: {}", url, e).into()),
    };
    let status = resp.status();
    let body = resp
        .into_string()
        .map_err(|e| format!("Could not parse HTTP response for {}: {}", url, e))?;
    if status != 200 {
        return Err(format!(
            "Could not fetch url '{}'. Status: {}. Body: {}",
            url, status, body
        )
        .into());
    };
    Ok(body)
}

/// Posts a Commit to the endpoint of the Subject from the Commit
pub async fn post_commit(commit: &crate::Commit, store: &impl Storelike) -> AtomicResult<()> {
    let server_url = crate::utils::server_url(commit.get_subject())?;
    // Default Commit endpoint is `https://example.com/commit`
    let endpoint = format!("{}commit", server_url);
    post_commit_custom_endpoint(&endpoint, commit, store).await
}

/// Posts a Commit to an endpoint
/// Default commit endpoint is `https://example.com/commit`
async fn post_commit_custom_endpoint(
    endpoint: &str,
    commit: &crate::Commit,
    store: &impl Storelike,
) -> AtomicResult<()> {
    let json = commit.into_resource(store).await?.to_json_ad()?;

    let agent = ureq::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build();

    let resp = agent
        .post(endpoint)
        .set("Content-Type", "application/json")
        .send_string(&json)
        .map_err(|e| format!("Error when posting commit to {} : {}", endpoint, e))?;

    if resp.status() != 200 {
        Err(format!(
            "Failed applying commit to {}. Status: {} Body: {}",
            endpoint,
            resp.status(),
            resp.into_string()?
        )
        .into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn fetch_resource_basic() {
        let store = crate::Store::init().await.unwrap();
        let resource = fetch_resource(crate::urls::SHORTNAME, &store, None)
            .await
            .unwrap()
            .to_single();

        let shortname = resource.get(crate::urls::SHORTNAME).unwrap();
        assert!(shortname.to_string() == "shortname");
    }

    #[tokio::test]
    #[ignore]
    async fn post_commit_basic() {
        // let store = Store::init().unwrap();
        // // TODO actually make this work
        // let commit = crate::commit::CommitBuilder::new("subject".into())
        //     .sign(&agent)
        //     .unwrap();
        // post_commit(&commit).unwrap();
    }
}

#[cfg(test)]
mod ssrf_guard_tests {
    use super::ssrf_guard::{guarded_resolve, ip_is_blocked, preflight};
    use std::net::IpAddr;

    #[test]
    fn blocks_internal_ips() {
        for s in [
            "127.0.0.1",
            "169.254.169.254", // cloud metadata
            "10.0.0.5",
            "172.16.9.9",
            "192.168.1.1",
            "100.64.0.1", // CGNAT
            "0.0.0.0",
            "::1",
            "fc00::1",          // ULA
            "fe80::1",          // link-local
            "::ffff:127.0.0.1", // v4-mapped loopback
        ] {
            let ip: IpAddr = s.parse().unwrap();
            assert!(ip_is_blocked(ip), "{s} must be blocked");
        }
    }

    #[test]
    fn allows_public_ips() {
        for s in [
            "1.1.1.1",
            "8.8.8.8",
            "93.184.216.34",
            "2606:4700:4700::1111",
        ] {
            let ip: IpAddr = s.parse().unwrap();
            assert!(!ip_is_blocked(ip), "{s} must be allowed");
        }
    }

    #[test]
    fn preflight_rejects_bad_scheme_and_literal_internal() {
        assert!(preflight("http://127.0.0.1/", false).is_err());
        assert!(preflight("http://169.254.169.254/latest/meta-data/", false).is_err());
        assert!(preflight("http://[::1]/", false).is_err());
        assert!(preflight("http://192.168.0.1/admin", false).is_err());
        assert!(preflight("file:///etc/passwd", false).is_err());
        assert!(preflight("ftp://example.com/", false).is_err());
        assert!(preflight("not a url", false).is_err());
    }

    #[test]
    fn preflight_allows_public_literal_and_domains() {
        // Domains pass preflight and are screened at connect time by the resolver.
        assert!(preflight("http://example.com/page", false).is_ok());
        assert!(preflight("https://1.1.1.1/", false).is_ok());
    }

    #[test]
    fn preflight_escape_hatch_allows_internal_but_still_rejects_bad_scheme() {
        // With the escape hatch, internal literals are allowed...
        assert!(preflight("http://127.0.0.1/", true).is_ok());
        // ...but non-http(s) schemes are still refused.
        assert!(preflight("file:///etc/passwd", true).is_err());
    }

    #[test]
    fn resolver_rejects_loopback_domain() {
        // `localhost` resolves only to loopback → the resolver refuses it,
        // before any socket is opened.
        assert!(guarded_resolve("localhost:80").is_err());
    }

    #[test]
    fn resolver_filters_but_keeps_public() {
        // A literal public IP passes the resolver unchanged.
        let addrs = guarded_resolve("1.1.1.1:443").unwrap();
        assert!(!addrs.is_empty());
        assert!(addrs.iter().all(|sa| !ip_is_blocked(sa.ip())));
    }

    /// End-to-end wiring: fetching a loopback-resolving domain must be refused.
    #[test]
    fn fetch_body_blocks_localhost_domain() {
        let result = super::fetch_body("http://localhost:1/", "text/html", None);
        assert!(
            result.is_err(),
            "fetch of loopback-resolving domain must fail"
        );
    }
}
