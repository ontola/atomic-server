//! `--trusted-proxies` (#1903): the direct peers whose `X-Forwarded-Host`
//! and `X-Forwarded-Proto` headers are believed.
//!
//! Any client can send forwarding headers. A reverse proxy in front of the
//! server sets them to say which host and scheme the client addressed. So
//! they only mean something when the TCP peer is that proxy. Plugin routes
//! (their `request.url`, `request.base` and `request.host`) and the URL an
//! `auth: atomic` or `auth: dpop` signature is bound to read them only from a
//! peer listed here; from anyone else they are ignored, and the dispatched
//! `Host` counts. Unset, no peer is trusted.
//!
//! The rest of the server keeps its current handling of forwarding headers
//! for now: self-hosters behind a proxy depend on it (#1318).

use std::net::IpAddr;

/// Parsed `--trusted-proxies`: IP addresses and CIDR ranges.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrustedProxies(Vec<(IpAddr, u8)>);

impl TrustedProxies {
    /// Comma-separated IPs or CIDRs (`10.0.0.0/8`, `::1`, `fd00::/8`).
    /// Unset or empty trusts nobody.
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        let mut ranges = Vec::new();
        for entry in raw.unwrap_or("").split(',').map(str::trim) {
            if entry.is_empty() {
                continue;
            }
            let (address, prefix) = match entry.split_once('/') {
                Some((address, prefix)) => (address, Some(prefix)),
                None => (entry, None),
            };
            let address: IpAddr = address.parse().map_err(|_| {
                format!("--trusted-proxies (ATOMIC_TRUSTED_PROXIES): `{entry}` is not an IP address or CIDR range")
            })?;
            let address = canonical(address);
            let max = if address.is_ipv4() { 32 } else { 128 };
            let prefix = match prefix {
                None => max,
                Some(p) => p.parse::<u8>().ok().filter(|p| *p <= max).ok_or_else(|| {
                    format!("--trusted-proxies (ATOMIC_TRUSTED_PROXIES): `{entry}` has a prefix length that is not 0 to {max}")
                })?,
            };
            ranges.push((address, prefix));
        }
        Ok(Self(ranges))
    }

    /// Whether a direct peer at `ip` is a trusted proxy.
    pub fn trusts(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        self.0
            .iter()
            .any(|(range, prefix)| in_range(ip, *range, *prefix))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// For the startup log: `10.0.0.0/8, ::1/128`, or `none`.
    pub fn describe(&self) -> String {
        if self.0.is_empty() {
            return "none".into();
        }
        self.0
            .iter()
            .map(|(ip, prefix)| format!("{ip}/{prefix}"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// An IPv4-mapped IPv6 address (`::ffff:10.0.0.1`, what a dual-stack socket
/// reports) as the IPv4 address it is.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

fn in_range(ip: IpAddr, range: IpAddr, prefix: u8) -> bool {
    match (ip, range) {
        (IpAddr::V4(ip), IpAddr::V4(range)) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
            u32::from(ip) & mask == u32::from(range) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(range)) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
            u128::from(ip) & mask == u128::from(range) & mask
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn unset_or_empty_trusts_nobody() {
        for raw in [None, Some(""), Some(" , ")] {
            let trusted = TrustedProxies::parse(raw).unwrap();
            assert!(trusted.is_empty());
            assert!(!trusted.trusts(ip("127.0.0.1")));
            assert_eq!(trusted.describe(), "none");
        }
    }

    #[test]
    fn addresses_and_cidr_ranges_match_the_direct_peer() {
        let trusted =
            TrustedProxies::parse(Some("10.0.0.0/8, 192.168.1.7, fd00::/8, ::1")).unwrap();
        assert_eq!(
            trusted.describe(),
            "10.0.0.0/8, 192.168.1.7/32, fd00::/8, ::1/128"
        );
        for yes in [
            "10.0.0.1",
            "10.255.255.255",
            "192.168.1.7",
            "fd12::3",
            "::1",
        ] {
            assert!(trusted.trusts(ip(yes)), "{yes}");
        }
        for no in ["11.0.0.1", "192.168.1.8", "fe80::1", "127.0.0.1", "::2"] {
            assert!(!trusted.trusts(ip(no)), "{no}");
        }
        // What a dual-stack socket reports for an IPv4 peer.
        assert!(trusted.trusts(ip("::ffff:10.1.2.3")));
        assert!(!trusted.trusts(ip("::ffff:11.1.2.3")));
        // A range written with host bits set still means the range.
        assert!(TrustedProxies::parse(Some("10.1.2.3/16"))
            .unwrap()
            .trusts(ip("10.1.200.1")));
        // Everything, if an operator really means it.
        assert!(TrustedProxies::parse(Some("0.0.0.0/0"))
            .unwrap()
            .trusts(ip("8.8.8.8")));
    }

    #[test]
    fn malformed_entries_stop_the_server() {
        for bad in [
            "proxy.example",
            "10.0.0.0/33",
            "::1/129",
            "10.0.0.0/x",
            "10.0.0/8",
        ] {
            let err = TrustedProxies::parse(Some(bad)).unwrap_err();
            assert!(err.contains("--trusted-proxies"), "{bad}: {err}");
        }
    }
}
