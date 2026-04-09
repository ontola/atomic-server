use serde::{Deserialize, Deserializer, Serialize, Serializer};
use url::Url;

/// The prefix for Agent DIDs: `did:ad:agent:`
pub const DID_AD_AGENT_PREFIX: &str = "did:ad:agent:";

/// The prefix for Commit DIDs: `did:ad:commit:`
pub const DID_AD_COMMIT_PREFIX: &str = "did:ad:commit:";

/// The Subject of a Resource.
///
/// In Atomic Data, every subject is a URI.
/// They are differentiated by their scheme:
/// - `internal:` for resources hosted on this server.
/// - `http:` or `https:` for resources on other servers.
/// - `did:` for Decentralized Identifiers (specifically commit signatures).
#[derive(Clone, Debug)]
pub enum Subject {
    /// Internal representation for local data.
    /// Format: `internal:/path` (root) or `internal:sub:/path` (tenant).
    Internal {
        url: Url,
        /// Drive shortname (used for subdomain routing).
        subdomain: Option<String>,
    },
    /// External resource identifier (usually over HTTP).
    External(Url),
    /// Decentralized Identifier (typically did:ad:{genesis}).
    /// Contains an optional drive identifier (DID or alias) for routing.
    Did {
        url: Url,
        drive_hint: Option<String>,
    },
}

/// Equality is based on the URL string only — `drive_hint` and `subdomain` are routing
/// metadata and do not affect identity.
impl PartialEq for Subject {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}

impl Eq for Subject {}

impl std::hash::Hash for Subject {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.as_str().hash(state);
    }
}

impl Subject {
    pub fn as_str(&self) -> &str {
        match self {
            Subject::Internal { url, .. } => url.as_str(),
            Subject::External(u) => u.as_str(),
            Subject::Did { url, .. } => url.as_str(),
        }
    }

    /// Returns the drive routing hint (DID or alias) if this is a DID subject.
    pub fn drive_hint(&self) -> Option<&str> {
        match self {
            Subject::Did { drive_hint, .. } => drive_hint.as_deref(),
            _ => None,
        }
    }

    /// Creates a new Internal subject.
    /// subdomain: None for root, Some("sub") for tenant.
    pub fn new_local(path: &str, subdomain: Option<&str>) -> Self {
        let mut path = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{}", path)
        };
        if path.len() > 1 && path.ends_with('/') {
            path.pop();
        }
        // The Url::parse might result in internal:path instead of internal:/path
        // if path doesn't start with //, but we want internal:/path
        let mut url = if let Some(s) = subdomain {
            Url::parse(&format!("internal:{}:{}", s, path)).unwrap()
        } else {
            Url::parse(&format!("internal:/{}", &path[1..])).unwrap()
        };

        // Some URL parsers might strip the slash for 'internal:' scheme.
        // We MUST have it for consistent internal subjects.
        if !url.as_str().starts_with("internal:/") && url.scheme() == "internal" {
            let mut s = url.as_str().to_string();
            if let Some(colon_pos) = s.find(':') {
                s.insert(colon_pos + 1, '/');
                url = Url::parse(&s).expect("Failed to re-parse internal URI with slash");
            }
        }

        Subject::Internal {
            url,
            subdomain: subdomain.map(|s| s.to_string()),
        }
    }

    /// Returns the path part of an Internal subject.
    /// For external subjects, it returns the URL's path.
    pub fn path(&self) -> String {
        match self {
            Subject::Internal { url, .. } => {
                let opaque = url.path();
                if opaque.starts_with('/') {
                    opaque.to_string()
                } else if let Some(slash_pos) = opaque.find('/') {
                    opaque[slash_pos..].to_string()
                } else {
                    "/".to_string()
                }
            }
            Subject::External(u) => u.path().to_string(),
            Subject::Did { .. } => self.as_str().to_string(),
        }
    }

    /// Returns the subdomain part of an Internal subject, if any.
    pub fn subdomain(&self) -> Option<String> {
        match self {
            Subject::Internal { subdomain, .. } => subdomain.clone(),
            _ => None,
        }
    }

    /// Returns a new Subject with the drive_hint set.
    /// Only has an effect on DID subjects.
    pub fn set_drive_hint(&self, drive_hint: String) -> Self {
        match self {
            Subject::Did { url, .. } => {
                let mut u = url.clone();
                // Manually reconstruct query to avoid '+' -> ' ' decoding
                let mut new_query = format!("drive={}", drive_hint);

                if let Some(existing_query) = url.query() {
                    for pair in existing_query.split('&') {
                        if let Some((k, v)) = pair.split_once('=') {
                            if k != "drive" {
                                new_query.push('&');
                                new_query.push_str(k);
                                new_query.push('=');
                                new_query.push_str(v);
                            }
                        } else if !pair.is_empty() {
                            new_query.push('&');
                            new_query.push_str(pair);
                        }
                    }
                }

                u.set_query(Some(&new_query));

                Subject::Did {
                    url: u,
                    drive_hint: Some(drive_hint),
                }
            }
            _ => self.clone(),
        }
    }

    /// Returns true if this is a DID subject.
    pub fn is_did(&self) -> bool {
        matches!(self, Subject::Did { .. })
    }

    /// Returns true if this is a DID Agent subject (did:ad:agent:).
    pub fn is_agent_did(&self) -> bool {
        match self {
            Subject::Did { url, .. } => url.as_str().starts_with(DID_AD_AGENT_PREFIX),
            _ => false,
        }
    }

    /// Returns true if this is a DID Commit subject (did:ad:commit:).
    pub fn is_commit_did(&self) -> bool {
        match self {
            Subject::Did { url, .. } => url.as_str().starts_with(DID_AD_COMMIT_PREFIX),
            _ => false,
        }
    }

    /// Returns true if this is an internal subject (mapped to the server's base domain).
    pub fn is_internal(&self) -> bool {
        matches!(self, Subject::Internal { .. })
    }

    /// Returns true if this is an external subject (not mapped to the server's base domain).
    pub fn is_external(&self) -> bool {
        matches!(self, Subject::External(_))
    }

    /// Returns true if this subject is local to the server (Internal or Did).
    /// External subjects are not considered local.
    pub fn is_local(&self) -> bool {
        matches!(self, Subject::Internal { .. } | Subject::Did { .. })
    }

    /// Resolves the Subject to an absolute URL string based on the provided origin.
    /// If it's an `Internal` subject, it swaps the `internal:` scheme for the `origin`.
    pub fn resolve(&self, origin: &str) -> String {
        match self {
            Subject::Internal { url, subdomain } => {
                let path = self.path();
                let trimmed_origin = origin.trim_end_matches('/');

                let mut resolved = if let Some(s) = subdomain {
                    if let Some(pos) = trimmed_origin.find("://") {
                        let (proto, rest) = trimmed_origin.split_at(pos + 3);
                        format!("{}{}.{}{}", proto, s, rest, path)
                    } else {
                        format!("{}.{}{}", s, trimmed_origin, path)
                    }
                } else {
                    format!("{}{}", trimmed_origin, path)
                };

                if let Some(q) = url.query() {
                    resolved.push('?');
                    resolved.push_str(q);
                }
                if let Some(f) = url.fragment() {
                    resolved.push('#');
                    resolved.push_str(f);
                }
                resolved
            }
            Subject::External(u) => u.to_string(),
            Subject::Did { url, .. } => url.to_string(),
        }
    }

    /// Normalizes a subject string based on a base domain.
    /// If the URL matches the base domain or its subdomains, it becomes an Internal subject.
    pub fn from_raw(s: &str, base_domain: Option<&str>) -> Self {
        if s.starts_with("/did:") {
            return Subject::from_raw(&s[1..], base_domain);
        }

        let s = if s.len() > 1 && s.ends_with('/') {
            if s.starts_with("internal:") {
                // If it's internal:/, don't strip. internal:/path/ -> internal:/path
                if s.len() > 10 {
                    &s[..s.len() - 1]
                } else {
                    s
                }
            } else {
                &s[..s.len() - 1]
            }
        } else {
            s
        };

        if s.starts_with("did:") {
            if let Ok(u) = Url::parse(s) {
                let mut drive_hint = None;
                if let Some(query) = u.query() {
                    for pair in query.split('&') {
                        if let Some((k, v)) = pair.split_once('=') {
                            if k == "drive" {
                                drive_hint = Some(v.to_string());
                                break;
                            }
                        }
                    }
                }
                return Subject::Did { url: u, drive_hint };
            }
        }

        if s.starts_with("internal:") {
            if let Ok(u) = Url::parse(s) {
                let opaque = u.path();
                let subdomain = if opaque.starts_with('/') {
                    None
                } else if let Some(slash_pos) = opaque.find('/') {
                    Some(opaque[..slash_pos].to_string())
                } else {
                    Some(opaque.to_string())
                };

                return Subject::Internal { url: u, subdomain };
            }
        }

        if s.starts_with('/') {
            return Subject::new_local(s, None);
        }

        if let Ok(u) = Url::parse(s) {
            if let Some(base) = base_domain {
                let trimmed_base = base
                    .trim_start_matches("http://")
                    .trim_start_matches("https://")
                    .trim_end_matches('/');

                let host = u.host_str().unwrap_or("");
                let authority = if let Some(port) = u.port() {
                    format!("{}:{}", host, port)
                } else {
                    host.to_string()
                };

                let path_and_query = if let Some(q) = u.query() {
                    format!("{}?{}", u.path(), q)
                } else {
                    u.path().to_string()
                };

                if authority == trimmed_base {
                    return Subject::new_local(&path_and_query, None);
                }
                if authority.ends_with(&format!(".{}", trimmed_base)) {
                    let subdomain = &authority[..authority.len() - trimmed_base.len() - 1];
                    return Subject::new_local(&path_and_query, Some(subdomain));
                }
            }
            return Subject::External(u);
        }

        // Fallback: treat as local path
        Subject::new_local(s, None)
    }

    /// Returns a new Subject without query parameters or fragments.
    pub fn without_params(&self) -> Self {
        match self {
            Subject::Internal { url, subdomain } => {
                let mut u = url.clone();
                u.set_query(None);
                u.set_fragment(None);
                Subject::Internal {
                    url: u,
                    subdomain: subdomain.clone(),
                }
            }
            Subject::External(u) => {
                let mut u = u.clone();
                u.set_query(None);
                u.set_fragment(None);
                Subject::External(u)
            }
            Subject::Did { url, .. } => {
                let mut u = url.clone();
                u.set_query(None);
                u.set_fragment(None);
                Subject::Did {
                    url: u,
                    drive_hint: None,
                }
            }
        }
    }

    /// Returns the core identifier as a String, stripping any query parameters or fragments.
    /// This is used for database keys and cryptographic signatures.
    pub fn pure_id(&self) -> String {
        match self {
            Subject::Internal { url, .. } => {
                let mut u = url.clone();
                u.set_query(None);
                u.set_fragment(None);
                let mut s = u.to_string();
                if s.len() > 10 && s.ends_with('/') {
                    s.pop();
                }
                s
            }
            Subject::External(url) => {
                let mut u = url.clone();
                u.set_query(None);
                u.set_fragment(None);
                u.to_string()
            }
            Subject::Did { url, .. } => {
                let mut u = url.clone();
                u.set_query(None);
                u.set_fragment(None);
                let mut s = u.to_string();
                if s.ends_with('/') {
                    s.pop();
                }
                s
            }
        }
    }
}

impl std::fmt::Display for Subject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl From<String> for Subject {
    fn from(s: String) -> Self {
        Subject::from_raw(&s, None)
    }
}

impl From<&str> for Subject {
    fn from(s: &str) -> Self {
        Subject::from_raw(s, None)
    }
}

impl From<Subject> for String {
    fn from(s: Subject) -> Self {
        s.to_string()
    }
}

impl PartialEq<&str> for Subject {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl PartialEq<Subject> for &str {
    fn eq(&self, other: &Subject) -> bool {
        *self == other.as_str()
    }
}

impl PartialEq<String> for Subject {
    fn eq(&self, other: &String) -> bool {
        self.as_str() == other.as_str()
    }
}

impl PartialEq<Subject> for String {
    fn eq(&self, other: &Subject) -> bool {
        self.as_str() == other.as_str()
    }
}

impl Serialize for Subject {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Subject {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(Subject::from(s))
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_did_parsing_and_resolution() {
        let origin = "http://localhost:9883";
        let did = "did:ad:C1PsEdNI7K1D4N2dMVaaHwxwevsl/6pL8rSdejvD+ori3rZb6eafyTgeEVKCHPG0Po3SBQyT7Ea/7pB/Fl8PCg==";
        let with_slash = format!("/{}", did);

        let subject_from_did = Subject::from_raw(did, None);
        assert!(matches!(subject_from_did, Subject::Did { .. }));
        assert_eq!(subject_from_did.as_str(), did);
        assert_eq!(subject_from_did.resolve(origin), did);

        let subject_from_slash = Subject::from_raw(&with_slash, None);
        assert!(matches!(subject_from_slash, Subject::Did { .. }));
        assert_eq!(subject_from_slash.as_str(), did);
        assert_eq!(subject_from_slash.resolve(origin), did);
    }

    #[test]
    fn test_agent_did_parsing() {
        let agent_did = "did:ad:agent:sLKUH+UJiTMm+dxzbAFf1h3gDonWQaOgU++2HD1bueQ=";
        let subject = Subject::from_raw(agent_did, None);
        assert!(
            matches!(subject, Subject::Did { .. }),
            "Expected Subject::Did, got {:?}",
            subject
        );
        assert_eq!(
            subject.as_str(),
            agent_did,
            "as_str() must preserve + and = without percent-encoding"
        );
        assert!(subject.is_agent_did());
    }

    #[test]
    fn test_did_drive_hint_parsing() {
        let did_with_drive = "did:ad:123?drive=abc";
        let subject = Subject::from_raw(did_with_drive, None);

        assert!(matches!(subject, Subject::Did { .. }));
        assert_eq!(subject.drive_hint(), Some("abc"));
        assert_eq!(subject.pure_id(), "did:ad:123");
    }

    #[test]
    fn test_internal_resolution() {
        let origin = "http://localhost:9883";
        let path = "/test";
        let subject = Subject::new_local(path, None);
        assert_eq!(subject.resolve(origin), format!("{}{}", origin, path));
    }

    #[test]
    fn test_resolution_with_query() {
        let origin = "http://localhost:9883";
        let raw = "/test?query=value";
        let subject = Subject::from_raw(raw, None);
        // If this fails, we know resolve() is losing query params
        assert_eq!(subject.resolve(origin), format!("{}{}", origin, raw));
    }

    #[test]
    fn test_from_raw_http_url_preserves_query_params() {
        // Regression test: full HTTP URL with query params must be preserved
        // when converted to an Internal subject (e.g. WS GET for /query endpoint).
        let origin = "http://localhost:9883";
        let raw =
            "http://localhost:9883/query?page_size=30&property=https%3A%2F%2Fexample.com%2Fprop";
        let subject = Subject::from_raw(raw, Some("localhost:9883"));
        assert!(
            matches!(subject, Subject::Internal { .. }),
            "Expected Internal subject"
        );
        assert_eq!(subject.resolve(origin), raw);
    }
}
