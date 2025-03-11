use serde::{Deserialize, Deserializer, Serialize, Serializer};
use url::Url;

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
    /// Decentralized Identifier (typically did:ad:{signature}).
    Did(Url),
}

impl Subject {
    pub fn as_str(&self) -> &str {
        match self {
            Subject::Internal(u) => u.as_str(),
            Subject::External(u) => u.as_str(),
            Subject::Did(u) => u.as_str(),
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
            Subject::Did(_) => "/".to_string(),
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

    /// Resolves the Subject to an absolute URL string based on the provided origin.
    /// If it's an `Internal` subject, it swaps the `internal:` scheme for the `origin`.
    pub fn resolve(&self, origin: &str) -> String {
        match self {
            Subject::Internal(_u) => {
                let path = self.path();
                let subdomain = self.subdomain();
                let trimmed_origin = origin.trim_end_matches('/');

                if let Some(s) = subdomain {
                    if let Some(pos) = trimmed_origin.find("://") {
                        let (proto, rest) = trimmed_origin.split_at(pos + 3);
                        format!("{}{}.{}{}", proto, s, rest, path)
                    } else {
                        format!("{}.{}{}", s, trimmed_origin, path)
                    }
                } else {
                    format!("{}{}", trimmed_origin, path)
                }
            }
            Subject::External(u) => u.to_string(),
            Subject::Did(u) => u.to_string(),
        }
    }

    /// Normalizes a subject string based on a base domain.
    /// If the URL matches the base domain or its subdomains, it becomes an Internal subject.
    pub fn from_raw(s: &str, base_domain: Option<&str>) -> Self {
        if s.starts_with("internal:") {
            if let Ok(u) = Url::parse(s) {
                return Subject::Internal(u);
            }
        }

        if s.starts_with("did:") {
            if let Ok(u) = Url::parse(s) {
                return Subject::Did(u);
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
        let mut u = match self {
            Subject::Internal(u) => u.clone(),
            Subject::External(u) => u.clone(),
            Subject::Did(u) => u.clone(),
        };
        u.set_query(None);
        u.set_fragment(None);
        match self {
            Subject::Internal(_) => Subject::Internal(u),
            Subject::External(_) => Subject::External(u),
            Subject::Did(_) => Subject::Did(u),
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
