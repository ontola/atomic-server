//! What a plugin is allowed to connect to.
//!
//! Plugins used to get [`inherit_network`], which is
//! `socket_addr_check(|_, _| true)` — the host's entire network, including
//! loopback, the private ranges, and whatever instance-metadata endpoint the
//! host happens to be able to reach. A plugin that computes a URL from data
//! nobody audited could therefore read the machine it runs on.
//!
//! The check runs on the *resolved* address, which is the only place it can
//! work: a hostname that resolves to `169.254.169.254` is the whole attack, and
//! no amount of inspecting the hostname catches it.
//!
//! [`inherit_network`]: wasmtime_wasi::p2::WasiCtxBuilder::inherit_network

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// A plugin's fetch is a background job's worth of patience, not a user's.
pub const FETCH_TIMEOUT_SECS: u64 = 30;
/// Enough for an API page, far short of letting a plugin stream a disk image
/// into the host's memory.
pub const FETCH_MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Why an address was refused. The plugin sees only that it was; this is for
/// the host's log, where "which range" is the question worth answering.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Loopback,
    Private,
    LinkLocal,
    Unspecified,
    Multicast,
    /// IPv6 unique-local (`fc00::/7`) — the v6 equivalent of a private range.
    UniqueLocal,
    /// An IPv4 address wearing an IPv6 costume; judged on what it maps to.
    MappedV4(&'static str),
}

/// Whether a plugin may connect to this address.
///
/// Deliberately a denylist of ranges rather than an allowlist of hosts: the
/// hostname is not available here, so exact-origin allowlisting belongs at the
/// `http-request` boundary, where it is. This closes the range that gets a
/// server owned; that one stops a plugin talking to the wrong public API.
pub fn refuse_address(addr: IpAddr) -> Option<Refusal> {
    match addr {
        IpAddr::V4(v4) => refuse_v4(v4),
        IpAddr::V6(v6) => refuse_v6(v6),
    }
}

fn refuse_v4(addr: Ipv4Addr) -> Option<Refusal> {
    if addr.is_loopback() {
        return Some(Refusal::Loopback);
    }

    if addr.is_unspecified() {
        return Some(Refusal::Unspecified);
    }

    // 169.254.0.0/16 — cloud instance metadata lives at 169.254.169.254, which
    // is the single address most worth keeping a plugin away from.
    if addr.is_link_local() {
        return Some(Refusal::LinkLocal);
    }

    if addr.is_private() {
        return Some(Refusal::Private);
    }

    if addr.is_multicast() || addr.is_broadcast() {
        return Some(Refusal::Multicast);
    }

    // 100.64.0.0/10, carrier-grade NAT. Not `is_private()`, but just as much
    // someone else's internal network.
    if addr.octets()[0] == 100 && (64..=127).contains(&addr.octets()[1]) {
        return Some(Refusal::Private);
    }

    None
}

fn refuse_v6(addr: Ipv6Addr) -> Option<Refusal> {
    // `::ffff:169.254.169.254` reaches the same metadata endpoint as the v4
    // form, so it is judged as what it maps to rather than as a v6 address.
    if let Some(mapped) = addr.to_ipv4_mapped() {
        return refuse_v4(mapped).map(|refusal| {
            Refusal::MappedV4(match refusal {
                Refusal::Loopback => "loopback",
                Refusal::Private => "private",
                Refusal::LinkLocal => "link-local",
                Refusal::Unspecified => "unspecified",
                Refusal::Multicast => "multicast",
                _ => "blocked",
            })
        });
    }

    if addr.is_loopback() {
        return Some(Refusal::Loopback);
    }

    if addr.is_unspecified() {
        return Some(Refusal::Unspecified);
    }

    if addr.is_multicast() {
        return Some(Refusal::Multicast);
    }

    let segments = addr.segments();

    // fe80::/10
    if segments[0] & 0xffc0 == 0xfe80 {
        return Some(Refusal::LinkLocal);
    }

    // fc00::/7
    if segments[0] & 0xfe00 == 0xfc00 {
        return Some(Refusal::UniqueLocal);
    }

    None
}

/// Whether a plugin may fetch this URL, resolving the host first.
///
/// The WASI socket check covers anything the guest dials itself, but the host
/// also fetches on a plugin's behalf when it asks for a subject on another
/// server. That path uses the host's HTTP client, never touches a guest socket,
/// and would otherwise stay wide open behind the same permission.
///
/// Every resolved address must pass, not just one: a name that answers with a
/// public address and a private one should not be usable by picking the
/// convenient answer.
///
/// This resolves and then hands the URL to a client that resolves again, so it
/// narrows the window rather than closing it. Pinning the checked address into
/// the connection is the real fix and belongs with the `http-request` boundary,
/// where the client is ours to configure.
pub async fn refuse_url(url: &str) -> Option<String> {
    let parsed = match url::Url::parse(url) {
        Ok(parsed) => parsed,
        Err(e) => return Some(format!("not a URL: {e}")),
    };

    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Some(format!("scheme {scheme} is not fetchable")),
    }

    let Some(host) = parsed.host_str() else {
        return Some("URL has no host".to_string());
    };

    // Default ports only matter for resolution; the check is on the address.
    let port = parsed.port_or_known_default().unwrap_or(443);

    if let Ok(literal) = host.parse::<IpAddr>() {
        return refuse_address(literal).map(|refusal| format!("{host} is {refusal:?}"));
    }

    let resolved = match tokio::net::lookup_host((host, port)).await {
        Ok(addresses) => addresses,
        Err(e) => return Some(format!("could not resolve {host}: {e}")),
    };

    let mut any = false;

    for address in resolved {
        any = true;

        if let Some(refusal) = refuse_address(address.ip()) {
            return Some(format!("{host} resolves to {} ({refusal:?})", address.ip()));
        }
    }

    if !any {
        return Some(format!("{host} resolved to no addresses"));
    }

    None
}

/// Resolve once and return only checked destinations for the host HTTP client.
pub async fn checked_addresses(url: &url::Url) -> Result<Vec<std::net::SocketAddr>, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only HTTP and HTTPS are fetchable".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials belong in host-owned secrets, not URLs".into());
    }
    let host = url.host_str().ok_or("URL has no host")?;
    let port = url.port_or_known_default().ok_or("URL has no port")?;
    let addresses: Vec<_> = tokio::net::lookup_host((host.trim_matches(['[', ']']), port))
        .await
        .map_err(|e| format!("could not resolve {host}: {e}"))?
        .collect();
    if addresses.is_empty() {
        return Err("host resolved to no addresses".into());
    }
    for address in &addresses {
        if let Some(refusal) = refuse_address(address.ip()) {
            return Err(format!(
                "{host} resolves to a refused address ({refusal:?})"
            ));
        }
    }
    Ok(addresses)
}

/// The integration proxy this node is configured with (ontola/atomic-plugins#54,
/// decisions 8 and 12).
///
/// It is the one destination that may be on loopback: a proxy on the same
/// machine, even one embedded in the same executable, is reached over HTTP so
/// every check the proxy runs still runs. The exception is for exactly this
/// origin, scheme and port included, and the host connects to the loopback
/// address itself rather than resolving the name, so DNS cannot redirect it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyOrigin {
    origin: String,
    /// For a proxy on this machine, the addresses to connect to. `None` for a
    /// proxy elsewhere, which gets the ordinary checks like any other host.
    loopback: Option<Vec<std::net::SocketAddr>>,
}

impl ProxyOrigin {
    /// An origin: `http` or `https`, a host, an optional port, and nothing
    /// else. A path, query or credentials would suggest the proxy is only part
    /// of that origin, and the exception must never cover more than the proxy.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let url = url::Url::parse(raw.trim())
            .map_err(|e| format!("integration proxy URL {raw:?} is not a URL: {e}"))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!(
                "integration proxy URL {raw:?} must be http or https"
            ));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(format!(
                "integration proxy URL {raw:?} must not carry credentials"
            ));
        }
        if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
            return Err(format!(
                "integration proxy URL {raw:?} must be an origin, with no path, query or fragment"
            ));
        }
        let origin = origin_of(&url)?;
        let port = url
            .port_or_known_default()
            .ok_or("integration proxy URL has no port")?;
        let at = |ip: IpAddr| std::net::SocketAddr::new(ip, port);
        let loopback = match url.host() {
            Some(url::Host::Ipv4(ip)) if ip.is_loopback() => Some(vec![at(ip.into())]),
            Some(url::Host::Ipv6(ip)) if ip.is_loopback() => Some(vec![at(ip.into())]),
            Some(url::Host::Domain(name)) if name.eq_ignore_ascii_case("localhost") => Some(vec![
                at(Ipv4Addr::LOCALHOST.into()),
                at(Ipv6Addr::LOCALHOST.into()),
            ]),
            _ => None,
        };
        Ok(Self { origin, loopback })
    }

    /// `scheme://host[:port]`, as [origin_of] writes it.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Whether `url` goes to exactly this origin.
    pub fn is_target_of(&self, url: &url::Url) -> bool {
        origin_of(url).is_ok_and(|origin| origin == self.origin)
    }
}

/// [checked_addresses], except for exactly the configured proxy on this
/// machine, which gets its loopback addresses without a lookup.
pub async fn destination_addresses(
    url: &url::Url,
    proxy: Option<&ProxyOrigin>,
) -> Result<Vec<std::net::SocketAddr>, String> {
    if let Some(ProxyOrigin {
        loopback: Some(addresses),
        ..
    }) = proxy.filter(|proxy| proxy.is_target_of(url))
    {
        if !url.username().is_empty() || url.password().is_some() {
            return Err("credentials belong in host-owned secrets, not URLs".into());
        }
        return Ok(addresses.clone());
    }
    checked_addresses(url).await
}

/// The `scheme://host[:port]` of a URL, which is what an origin allowlist and a
/// secret's scope are both expressed in.
pub fn origin_of(url: &url::Url) -> Result<String, String> {
    let host = url.host_str().ok_or("URL has no host")?;

    Ok(match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    })
}

/// Refuses a secret handle anywhere it must not be substituted.
///
/// A credential in a URL is written to access logs, proxy logs and `Referer`
/// headers as a matter of course, so quietly sending one there would be worse
/// than refusing. The same goes for a body, which the plugin can log itself.
pub fn refuse_misplaced_handles(url: &str, body: Option<&str>) -> Option<String> {
    use atomic_lib::db::plugin_secret::mentions_handle;

    if mentions_handle(url) {
        return Some(
            "a secret handle in the URL is refused: credentials in a URL end up in logs. Put it in a header.".to_string(),
        );
    }

    if body.is_some_and(mentions_handle) {
        return Some(
            "a secret handle in the body is refused; substitution happens only in header values."
                .to_string(),
        );
    }

    None
}

/// Substitutes `secret:<name>` in header values.
///
/// `resolve` is given the secret's name and returns its value if the plugin has
/// one of that name scoped to this origin. A handle that does not resolve is an
/// error rather than a request sent without credentials — a 401 from the far
/// end is a much worse way to learn a secret is missing.
pub fn substitute_headers<F>(
    headers: Vec<(String, String)>,
    mut resolve: F,
) -> Result<Vec<(String, String)>, String>
where
    F: FnMut(&str) -> Option<String>,
{
    use atomic_lib::db::plugin_secret::{mentions_handle, SECRET_HANDLE_PREFIX};

    let mut out = Vec::with_capacity(headers.len());

    for (name, value) in headers {
        // A handle is the whole value, or follows a scheme like `Bearer `.
        let substituted = match value.rsplit_once(SECRET_HANDLE_PREFIX) {
            None => value,
            Some((prefix, secret_name)) => {
                let Some(secret) = resolve(secret_name) else {
                    return Err(format!(
                        "no secret `{secret_name}` is available to this plugin for this origin",
                    ));
                };

                format!("{prefix}{secret}")
            }
        };

        // Belt and braces: a value that still mentions a handle after
        // substitution means one was missed, and sending it would leak the
        // shape of the plugin's secrets to the far end.
        if mentions_handle(&substituted) {
            return Err(format!("header `{name}` still contains a secret handle"));
        }

        out.push((name, substituted));
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(addr: &str) -> Option<Refusal> {
        refuse_address(addr.parse().expect("test address parses"))
    }

    #[test]
    fn allows_ordinary_public_addresses() {
        // The example plugin posts to a Discord webhook; that has to keep working.
        assert_eq!(refused("1.1.1.1"), None);
        assert_eq!(refused("162.159.128.233"), None);
        assert_eq!(refused("2606:4700::6810:85e5"), None);
    }

    #[test]
    fn refuses_cloud_instance_metadata() {
        assert_eq!(refused("169.254.169.254"), Some(Refusal::LinkLocal));
        assert_eq!(
            refused("::ffff:169.254.169.254"),
            Some(Refusal::MappedV4("link-local")),
        );
    }

    #[test]
    fn refuses_the_machine_it_runs_on() {
        assert_eq!(refused("127.0.0.1"), Some(Refusal::Loopback));
        assert_eq!(refused("127.5.5.5"), Some(Refusal::Loopback));
        assert_eq!(refused("::1"), Some(Refusal::Loopback));
        assert_eq!(
            refused("::ffff:127.0.0.1"),
            Some(Refusal::MappedV4("loopback")),
        );
    }

    #[test]
    fn refuses_private_networks() {
        assert_eq!(refused("10.0.0.5"), Some(Refusal::Private));
        assert_eq!(refused("172.16.0.5"), Some(Refusal::Private));
        assert_eq!(refused("172.31.255.255"), Some(Refusal::Private));
        assert_eq!(refused("192.168.1.1"), Some(Refusal::Private));
        assert_eq!(refused("fd00::1"), Some(Refusal::UniqueLocal));
    }

    #[test]
    fn refuses_carrier_grade_nat() {
        assert_eq!(refused("100.64.0.1"), Some(Refusal::Private));
        assert_eq!(refused("100.127.255.255"), Some(Refusal::Private));
        // 100.128.0.0 is outside the range and ordinary public space.
        assert_eq!(refused("100.128.0.1"), None);
    }

    #[test]
    fn refuses_unspecified_and_multicast() {
        assert_eq!(refused("0.0.0.0"), Some(Refusal::Unspecified));
        assert_eq!(refused("::"), Some(Refusal::Unspecified));
        assert_eq!(refused("224.0.0.1"), Some(Refusal::Multicast));
        assert_eq!(refused("255.255.255.255"), Some(Refusal::Multicast));
        assert_eq!(refused("ff02::1"), Some(Refusal::Multicast));
    }

    #[test]
    fn an_origin_is_scheme_host_and_port() {
        let parse = |u: &str| origin_of(&url::Url::parse(u).unwrap()).unwrap();

        assert_eq!(
            parse("https://api.notion.com/v1/x?y=1"),
            "https://api.notion.com"
        );
        assert_eq!(parse("http://localhost:9883/x"), "http://localhost:9883");
        // A default port normalizes away, so a secret scoped to
        // `https://api.notion.com` is still spent on `https://api.notion.com:443`.
        // The handler's `normalize_origin` uses the same rule, so what is stored
        // and what is compared cannot drift.
        assert_eq!(parse("https://x.test:443/"), "https://x.test");
        assert_eq!(parse("http://x.test:80/"), "http://x.test");
    }

    #[test]
    fn a_handle_in_a_url_or_body_is_refused() {
        assert!(refuse_misplaced_handles("https://x.test/?t=secret:notion", None).is_some());
        assert!(
            refuse_misplaced_handles("https://x.test/", Some("{\"t\":\"secret:notion\"}"))
                .is_some()
        );
        assert!(refuse_misplaced_handles("https://x.test/", Some("{}")).is_none());
    }

    #[test]
    fn a_handle_in_a_header_is_substituted() {
        let headers = vec![
            (
                "Authorization".to_string(),
                "Bearer secret:notion".to_string(),
            ),
            ("X-Key".to_string(), "secret:notion".to_string()),
            ("Accept".to_string(), "application/json".to_string()),
        ];

        let out = substitute_headers(headers, |name| {
            (name == "notion").then(|| "tok-abc".to_string())
        })
        .expect("substituted");

        assert_eq!(out[0].1, "Bearer tok-abc");
        assert_eq!(out[1].1, "tok-abc");
        assert_eq!(out[2].1, "application/json");
    }

    #[test]
    fn a_handle_that_does_not_resolve_fails_the_request() {
        let headers = vec![(
            "Authorization".to_string(),
            "Bearer secret:missing".to_string(),
        )];

        // Not "send it without credentials" — a 401 from the far end is a far
        // worse way to learn the secret was not there.
        let err = substitute_headers(headers, |_| None).expect_err("refused");
        assert!(err.contains("missing"));
    }

    #[tokio::test]
    async fn refuses_a_url_pointing_at_the_host_itself() {
        assert!(refuse_url("http://127.0.0.1:9883/some/resource")
            .await
            .is_some());
        assert!(refuse_url("http://[::1]/x").await.is_some());
        assert!(refuse_url("http://169.254.169.254/latest/meta-data/")
            .await
            .is_some());
    }

    #[tokio::test]
    async fn refuses_a_hostname_that_resolves_to_loopback() {
        // The point of resolving before checking: the name says nothing.
        assert!(refuse_url("http://localhost:9883/x").await.is_some());
    }

    #[tokio::test]
    async fn refuses_what_is_not_fetchable() {
        assert!(refuse_url("file:///etc/passwd").await.is_some());
        assert!(refuse_url("not a url").await.is_some());
        assert!(refuse_url("https://").await.is_some());
    }

    #[test]
    fn refuses_link_local_v6() {
        assert_eq!(refused("fe80::1"), Some(Refusal::LinkLocal));
    }

    #[test]
    fn does_not_refuse_addresses_that_merely_look_private() {
        // 172.32.x is outside 172.16.0.0/12, and 192.169.x outside 192.168/16.
        assert_eq!(refused("172.32.0.1"), None);
        assert_eq!(refused("192.169.1.1"), None);
        assert_eq!(refused("11.0.0.1"), None);
    }

    fn url(raw: &str) -> url::Url {
        url::Url::parse(raw).unwrap()
    }

    #[test]
    fn a_proxy_origin_is_an_origin_and_nothing_more() {
        for ok in [
            "http://localhost:8080",
            "http://127.0.0.1:8080/",
            "http://[::1]:8080",
            "https://localthought.io",
        ] {
            assert!(ProxyOrigin::parse(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://localhost:8080/proxy",
            "http://localhost:8080/?a=b",
            "http://localhost:8080/#x",
            "http://user:pw@localhost:8080",
            "ftp://localhost:8080",
            "file:///tmp/proxy",
            "localhost:8080",
        ] {
            assert!(ProxyOrigin::parse(bad).is_err(), "{bad}");
        }
        assert_eq!(
            ProxyOrigin::parse("HTTPS://LocalThought.io:443/")
                .unwrap()
                .origin(),
            "https://localthought.io"
        );
    }

    #[tokio::test]
    async fn the_configured_loopback_proxy_is_reached_at_loopback_without_a_lookup() {
        let proxy = ProxyOrigin::parse("http://localhost:7070").unwrap();
        let addresses = destination_addresses(
            &url("http://localhost:7070/proxy/c/github/x?y=1"),
            Some(&proxy),
        )
        .await
        .unwrap();
        assert!(!addresses.is_empty());
        assert!(addresses
            .iter()
            .all(|a| a.ip().is_loopback() && a.port() == 7070));

        let literal = ProxyOrigin::parse("http://127.0.0.1:7070").unwrap();
        assert_eq!(
            destination_addresses(&url("http://127.0.0.1:7070/runtimes"), Some(&literal))
                .await
                .unwrap(),
            vec!["127.0.0.1:7070".parse().unwrap()]
        );
    }

    #[tokio::test]
    async fn every_other_loopback_target_is_still_refused() {
        let proxy = ProxyOrigin::parse("http://127.0.0.1:7070").unwrap();
        for other in [
            // Another port on the same address.
            "http://127.0.0.1:7071/",
            // The same port, the other scheme.
            "https://127.0.0.1:7070/",
            // Another loopback address.
            "http://127.0.0.2:7070/",
            // The same machine by another name: exact origin, not "same host".
            "http://localhost:7070/",
            "http://[::1]:7070/",
            // Credentials in the URL, even to the proxy itself.
            "http://u:p@127.0.0.1:7070/",
        ] {
            let result = destination_addresses(&url(other), Some(&proxy)).await;
            assert!(result.is_err(), "{other} was let through: {result:?}");
        }
        // With no proxy configured, nothing on loopback is reachable.
        assert!(destination_addresses(&url("http://127.0.0.1:7070/"), None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_proxy_elsewhere_gets_no_exception() {
        // A public proxy passes the ordinary checks on its own; configuring
        // one must not turn a name that resolves to loopback into an exception.
        let proxy = ProxyOrigin::parse("http://proxy.invalid:7070").unwrap();
        assert!(
            destination_addresses(&url("http://proxy.invalid:7070/x"), Some(&proxy))
                .await
                .is_err()
        );
    }
}
