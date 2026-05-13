pub struct SetupResult {
    pub agent_secret: String,
    pub agent_subject: String,
    pub drive_subject: String,
}

pub struct AgentInfo {
    pub secret: String,
    pub subject: String,
    pub public_key: String,
    pub name: Option<String>,
}

pub struct CanvasListItem {
    pub subject: String,
    pub name: String,
}

/// Metadata for a single historical version of a resource.
pub struct VersionMetadata {
    pub id: Vec<u8>,
    pub timestamp: i64,
    pub peer_id: String,
    pub lamport: u64,
    pub len: i32,
    pub message: Option<String>,
}
