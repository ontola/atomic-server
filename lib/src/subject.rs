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
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Subject {
    /// Internal representation for local data.
    /// Format: `internal:/path` (root) or `internal:sub:/path` (tenant).
    Internal(Url),
    /// External resource identifier (usually over HTTP).
    External(Url),
    /// Decentralized Identifier (typically did:ad:{genesis}).
    /// Contains an optional drive identifier (short hash or alias) for routing.
    Did {
        url: Url,
        drive_hint: Option<String>,
    },
}

impl Subject {
    pub fn as_str(&self) -> &str {
        match self {
            Subject::Internal(u) => u.as_str(),
            Subject::External(u) => u.as_str(),
            Subject::Did { url, .. } => url.as_str(),
        }
    }

    /// Returns the drive routing hint (hash or alias) if this is a DID subject.
    pub fn drive_hint(&self) -> Option<&str> {
        match self {
            Subject::Did { drive_hint, .. } => drive_hint.as_deref(),
            _ => None,
        }
    }

    /// Creates a new Internal subject.
    /// subdomain: None for root, Some("sub") for tenant.
    pub fn new_local(path: &str, subdomain: Option<&str>) -> Self {
        let path = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{}", path)
        };
        let uri = match subdomain {
            Some(s) => format!("internal:{}:{}", s, path),
            None => format!("internal:{}", path),
        };
        Subject::Internal(Url::parse(&uri).expect("Failed to parse internal URI"))
    }

    /// Returns the path part of an Internal subject.
    /// For external subjects, it returns the URL's path.
    pub fn path(&self) -> String {
        match self {
            Subject::Internal(u) => {
                let opaque = u.path();
                if opaque.starts_with('/') {
                    opaque.to_string()
                } else if let Some(slash_pos) = opaque.find('/') {
                    opaque[slash_pos..].to_string()
                } else {
                    "/".to_string()
                }
            }
            Subject::External(u) => u.path().to_string(),
            Subject::Did { .. } => "/".to_string(),
        }
    }

    /// Returns the subdomain part of an Internal subject, if any.
    pub fn subdomain(&self) -> Option<String> {
        match self {
            Subject::Internal(u) => {
                let opaque = u.path();
                if opaque.starts_with('/') {
                    None
                } else if let Some(slash_pos) = opaque.find('/') {
                    Some(opaque[..slash_pos].to_string())
                } else {
                    Some(opaque.to_string())
                }
            }
            _ => None,
        }
    }

    /// Returns true if this subject is local to the server (Internal or Did).
    /// External subjects are not considered local.
    pub fn is_local(&self) -> bool {
        matches!(self, Subject::Internal(_) | Subject::Did { .. })
    }

    /// Resolves the Subject to an absolute URL string based on the provided origin.
    /// If it's an `Internal` subject, it swaps the `internal:` scheme for the `origin`.
    pub fn resolve(&self, origin: &str) -> String {
        match self {
            Subject::Internal(_u) => {
                let path = self.path();
                let subdomain = self.subdomain();
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

                if let Some(q) = _u.query() {
                    resolved.push('?');
                    resolved.push_str(q);
                }
                if let Some(f) = _u.fragment() {
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

        if s.starts_with("internal:") {
            if let Ok(u) = Url::parse(s) {
                return Subject::Internal(u);
            }
        }

        if s.starts_with("did:") {
            if let Ok(u) = Url::parse(s) {
                let drive_hint = u.query_pairs().find(|(k, _)| k == "drive").map(|(_, v)| v.into_owned());
                return Subject::Did { url: u, drive_hint };
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

                if authority == trimmed_base {
                    return Subject::new_local(u.path(), None);
                }
                if authority.ends_with(&format!(".{}", trimmed_base)) {
                    let subdomain = &authority[..authority.len() - trimmed_base.len() - 1];
                    return Subject::new_local(u.path(), Some(subdomain));
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
            Subject::Internal(u) => {
                let mut u = u.clone();
                u.set_query(None);
                u.set_fragment(None);
                Subject::Internal(u)
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
                Subject::Did { url: u, drive_hint: None }
            }
        }
    }

    /// Returns the core identifier as a String, stripping any query parameters or fragments.
    /// This is used for database keys and cryptographic signatures.
    pub fn pure_id(&self) -> String {
        self.without_params().to_string()
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
}
