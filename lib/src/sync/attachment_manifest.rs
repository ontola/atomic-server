//! Canonical, bounded content identity. A resource's metadata frontier is separate.
use serde::{Deserialize, Serialize};

pub const MAX_ATTACHMENT_FILES: usize = 128;
pub const MAX_ATTACHMENT_CHUNKS: usize = 4096;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentFile {
    pub subject: String,
    pub hash: String,
    /// Ordered content-addressed chunks; empty means one blob named by `hash`.
    pub chunks: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttachmentManifest {
    pub files: Vec<AttachmentFile>,
}

pub fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl AttachmentManifest {
    pub fn validate(&self) -> bool {
        self.files.len() <= MAX_ATTACHMENT_FILES
            && self
                .files
                .windows(2)
                .all(|pair| pair[0].subject < pair[1].subject)
            && self.files.iter().all(|file| {
                !file.subject.is_empty()
                    && file.subject.len() <= 4096
                    && !file.subject.contains(['\0', '#', '?'])
                    && (file.subject.starts_with("atomic:")
                        || file.subject.starts_with("https://")
                        || file.subject.starts_with("http://"))
                    && crate::Subject::from(file.subject.as_str()).pure_id() == file.subject
                    && crate::identifiers::canonicalize_scheme(&file.subject) == file.subject
                    && valid_hash(&file.hash)
                    && file.chunks.len() <= MAX_ATTACHMENT_CHUNKS
                    && file.chunks.iter().all(|hash| valid_hash(hash))
            })
            && self
                .files
                .iter()
                .map(|file| file.chunks.len())
                .sum::<usize>()
                <= MAX_ATTACHMENT_CHUNKS
            && serde_json::to_vec(self).is_ok_and(|bytes| bytes.len() < 48 * 1024)
    }
}
