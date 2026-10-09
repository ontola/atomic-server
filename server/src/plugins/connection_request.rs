//! A run that needs a provider connection its installation lacks.
//!
//! Nobody is present to redirect when a scheduled run finds out that its
//! installation has no (or a revoked) delegation at the integration proxy
//! (ontola/atomic-plugins#54, flow b). Failing silently, or failing again on
//! every tick, are the two outcomes this exists to avoid.
//!
//! Instead the run ends with a *needs a connection* outcome, which is not a
//! retryable failure, and the node records a `ConnectionRequest` as a child of
//! the installation. That is an ordinary commit, so it syncs to every copy of
//! the drive, and the data browser shows it the next time the drive is opened.
//! Nothing in it is secret: the platform, why, who asked and since when.
//!
//! The node stops starting that installation's runs while a request exists.
//! Whoever connects the platform destroys the request; the node sees the
//! destroy through sync and resumes. Destroying rather than flagging means no
//! second state to keep in step, and a node that was offline when it was
//! cleared catches up like it does for any other commit.
//!
//! **Signer.** The request is signed by the installation's own app agent when
//! this node holds its key (it already has write rights on the installation
//! and everything under it), and by the server's agent otherwise. It is a
//! child resource rather than a property on the installation because the app
//! agent may write below its installation but should not rewrite the
//! installation itself, and because several platforms can be requested at once
//! without two nodes racing on one property.

use std::collections::HashMap;

use atomic_lib::{agents::ForAgent, urls, Db, Storelike};
use serde_json::{json, Value as Json};

use crate::plugins::{
    apply::{ApplyHost, CreateRequest},
    store_host::StoreApplyHost,
};

/// Carried inside an error string so a run that fails deep in the host can be
/// told apart from one that merely failed. The text after it is for people.
const MARKER: &str = "needs-connection:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    NeverConnected,
    Revoked,
    Expired,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::NeverConnected => "never-connected",
            Reason::Revoked => "revoked",
            Reason::Expired => "expired",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "never-connected" => Some(Reason::NeverConnected),
            "revoked" => Some(Reason::Revoked),
            "expired" => Some(Reason::Expired),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectionNeed {
    pub platform: String,
    pub reason: Reason,
}

impl ConnectionNeed {
    /// The error a run ends with. `find` reads it back.
    pub fn to_error(&self) -> String {
        format!(
            "{MARKER}{}:{} (this installation has no usable {} connection; connect it, then the \
             schedule resumes)",
            self.platform,
            self.reason.as_str(),
            self.platform,
        )
    }

    /// The need an error carries, wherever in its text it sits: the plugin's
    /// runtime wraps what the host threw.
    pub fn find(error: &str) -> Option<Self> {
        let rest = &error[error.find(MARKER)? + MARKER.len()..];
        let token = rest.split(|c: char| c.is_whitespace() || c == '(').next()?;
        let (platform, reason) = token.split_once(':')?;

        is_platform_id(platform).then_some(())?;

        Some(Self {
            platform: platform.to_string(),
            reason: Reason::parse(reason.trim_end_matches(['.', ',', ';', '"', '\'']))?,
        })
    }
}

fn is_platform_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Reads the integration proxy's answer for a delegation that is missing,
/// revoked or expired.
///
/// The shape is the proxy's `{error, message}` (ontola/atomic-plugins#54): a
/// 4xx whose `error` names the delegation. Kept in this one function so that
/// when the proxy's codes are settled, this is the only place to change. The
/// platform is the proxy's own `platform` field, else the segment after the
/// connection in `/proxy/{connection}/{platform}/...`.
pub fn from_proxy_answer(url: &str, status: u16, body: &str) -> Option<ConnectionNeed> {
    if !(400..500).contains(&status) {
        return None;
    }

    let answer: Json = serde_json::from_str(body).ok()?;
    let reason = match answer.get("error")?.as_str()? {
        "delegation_missing" | "no_delegation" | "not_delegated" => Reason::NeverConnected,
        "delegation_revoked" => Reason::Revoked,
        "delegation_expired" => Reason::Expired,
        _ => return None,
    };

    let from_path = || {
        let parsed = url::Url::parse(url).ok()?;
        let mut segments = parsed.path_segments()?;
        segments.find(|s| *s == "proxy")?;
        segments.next()?;
        segments.next().map(str::to_string)
    };
    let platform = answer
        .get("platform")
        .and_then(Json::as_str)
        .map(str::to_string)
        .or_else(from_path)
        .filter(|p| is_platform_id(p))?;

    Some(ConnectionNeed { platform, reason })
}

/// Requests that are still open on this installation: `(subject, platform)`.
pub async fn open_requests(db: &Db, plugin: &str) -> Vec<(String, String)> {
    let Ok(resource) = db.get_resource(&plugin.into()).await else {
        return Vec::new();
    };
    let Ok(children) = resource.get_children(db).await else {
        return Vec::new();
    };

    children
        .iter()
        .filter(|child| child.has_class(urls::CONNECTION_REQUEST))
        .map(|child| {
            let platform = child
                .get(urls::CONNECTION_PLATFORM)
                .map(|v| v.to_string())
                .unwrap_or_default();

            (child.get_subject().to_string(), platform)
        })
        .collect()
}

/// Whether the node must not start this installation's runs.
///
/// Any open request pauses the installation, not only runs known to need that
/// platform: the host cannot see which platforms a plugin will touch before it
/// runs, and a run that is going to be refused again is exactly what the pause
/// prevents.
pub async fn is_paused(db: &Db, plugin: &str) -> bool {
    !open_requests(db, plugin).await.is_empty()
}

/// Records that `plugin` needs `need`, unless that is already requested.
/// Returns the request's subject, or `None` when one was already open.
pub async fn record(
    db: &Db,
    drive: &str,
    plugin: &str,
    actor: ForAgent,
    need: &ConnectionNeed,
    label: &str,
    now: i64,
) -> Result<Option<String>, String> {
    if open_requests(db, plugin)
        .await
        .iter()
        .any(|(_, platform)| platform == &need.platform)
    {
        return Ok(None);
    }

    let mut host = StoreApplyHost::for_installation(db, drive, plugin, actor).await?;
    let mut prop_vals: HashMap<String, Json> = HashMap::new();
    prop_vals.insert(urls::NAME.into(), json!(format!("Needs {}", need.platform)));
    prop_vals.insert(urls::CONNECTION_PLATFORM.into(), json!(need.platform));
    prop_vals.insert(urls::CONNECTION_REASON.into(), json!(need.reason.as_str()));
    prop_vals.insert(urls::CONNECTION_REQUESTED_BY.into(), json!(label));
    prop_vals.insert(urls::CONNECTION_SINCE.into(), json!(now));

    host.create(CreateRequest {
        parent: plugin.to_string(),
        is_a: vec![urls::CONNECTION_REQUEST.to_string()],
        prop_vals,
    })
    .await
    .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_need_survives_being_wrapped_in_a_runtime_error() {
        let need = ConnectionNeed {
            platform: "google-calendar".into(),
            reason: Reason::Revoked,
        };
        let wrapped = format!("Error: fetch failed: {}\n    at run", need.to_error());

        assert_eq!(ConnectionNeed::find(&wrapped), Some(need));
        assert_eq!(ConnectionNeed::find("it just broke"), None);
        assert_eq!(ConnectionNeed::find("needs-connection:X Y:revoked"), None);
    }

    #[test]
    fn only_a_delegation_answer_from_the_proxy_counts() {
        let url = "https://proxy.example/proxy/c_1/google-calendar/events";
        let need = |body: &str| from_proxy_answer(url, 403, body);

        assert_eq!(
            need(r#"{"error":"delegation_revoked","message":"x"}"#),
            Some(ConnectionNeed {
                platform: "google-calendar".into(),
                reason: Reason::Revoked
            })
        );
        assert_eq!(
            need(r#"{"error":"delegation_missing","platform":"github"}"#)
                .unwrap()
                .platform,
            "github"
        );
        assert_eq!(need(r#"{"error":"rate_limited"}"#), None);
        assert_eq!(need("not json"), None);
        assert_eq!(
            from_proxy_answer(url, 200, r#"{"error":"delegation_revoked"}"#),
            None
        );
    }
}
