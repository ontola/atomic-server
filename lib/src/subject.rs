use serde::{Deserialize, Serialize};

/// The Subject of a Resource.
///
/// Can be a full URL, a local path (relative to the server), or a Decentralized Identifier (DID).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Subject {
    /// A full HTTP(S) URL.
    /// Resource from an external instance.
    Url(String),
    /// A Subject relative to the server's base URL, should be stored on this instance.
    /// Internal representation: "local:path/poo" or just "path/poo"
    Local(String),
    /// A Decentralized Identifier (did:ad:<signature_of_creation_commit>)
    Did(String),
}

impl Subject {
    pub fn as_str(&self) -> &str {
        match self {
            Subject::Url(s) => s,
            Subject::Local(s) => s,
            Subject::Did(s) => s,
        }
    }

    /// Returns the string representation of the Subject.
    /// Note: For `Local` subjects, this returns the internal string which might not be a valid URL without the server base.
    pub fn to_string(&self) -> String {
        self.as_str().to_string()
    }

    /// Resolves the Subject to a full URL string.
    /// If it's a `Local` subject, it uses the provided `base_url`.
    pub fn resolve(&self, base_url: &str) -> String {
        match self {
            Subject::Url(s) => s.clone(),
            Subject::Local(s) => {
                let trimmed_base = base_url.trim_end_matches('/');
                let mut path = s.as_str();
                if path.starts_with('/') {
                    path = &path[1..];
                }
                format!("{}/{}", trimmed_base, path)
            }
            Subject::Did(s) => s.clone(),
        }
    }
}

impl std::fmt::Display for Subject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_string())
    }
}

impl From<String> for Subject {
    fn from(s: String) -> Self {
        if s.starts_with("http") {
            Subject::Url(s)
        } else if s.starts_with("did:ad:") {
            Subject::Did(s)
        } else {
            Subject::Local(s)
        }
    }
}

impl From<&str> for Subject {
    fn from(s: &str) -> Self {
        Subject::from(s.to_string())
    }
}

impl From<Subject> for String {
    fn from(s: Subject) -> Self {
        s.to_string()
    }
}
