use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct PluginMeta {
    pub subject: String,
    pub agent_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMetaKey {
    pub drive: String,
    pub name: String,
    pub namespace: String,
}

impl PluginMetaKey {
    pub fn new(drive: &str, namespace: &str, name: &str) -> Self {
        Self {
            drive: drive.to_string(),
            namespace: namespace.to_string(),
            name: name.to_string(),
        }
    }
}
