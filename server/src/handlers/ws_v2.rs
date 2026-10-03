//! Re-export the v2 binary protocol from atomic_lib, plus the one server-side
//! helper every fan-out path shares.
//! The server uses this for WebSocket frame encoding/decoding.

use std::sync::Arc;

use atomic_lib::Storelike;

pub use atomic_lib::sync::protocol::*;

/// What changed about a subject, for [`encode_change_frame`].
#[derive(Clone, Copy)]
pub enum Change<'a> {
    /// A commit's Loro delta, with the id of the commit that produced it.
    Delta { bytes: &'a [u8], commit_id: &'a str },
    /// The subject's full Loro state (a commit-less change read from
    /// `Tree::LoroSnapshots`, or a filter-membership join), with the commit
    /// id when one is known.
    Snapshot {
        bytes: &'a [u8],
        commit_id: Option<&'a str>,
    },
    /// The subject was deleted.
    Destroyed,
}

/// The `UPDATE` / `DESTROY` frame that tells a subscriber `subject` changed,
/// encoded once for fan-out (`Arc<[u8]>`, see `Handler<SendFrame>`).
///
/// One place for what used to be three copies (the commit fan-out, the
/// commit-less external change, and the filter-membership push), which had
/// drifted: full state labelled as a delta made the client merge it into a
/// document it did not have and render a peer's new table row with every
/// cell empty. The `SNAPSHOT` flag is set exactly when the payload is one.
/// `PUSH` is always set: these are unsolicited (`request_id == 0`).
/// Subjects resolve against this server's base domain, so one encoding
/// serves every connection.
pub fn encode_change_frame(
    store: &atomic_lib::Db,
    subject: &atomic_lib::Subject,
    change: Change<'_>,
) -> Arc<[u8]> {
    encode_change_frame_for_caps(
        store,
        subject,
        change,
        &[atomic_lib::identifiers::CAP_CANONICAL_SCHEME],
    )
}

/// Like [`encode_change_frame`], but subjects on the wire follow `caps`:
/// a peer that listed `canonical-scheme` gets `atomic:`, everyone else
/// `did:ad:`.
pub fn encode_change_frame_for_caps(
    store: &atomic_lib::Db,
    subject: &atomic_lib::Subject,
    change: Change<'_>,
    caps: &[impl AsRef<str>],
) -> Arc<[u8]> {
    let origin = store
        .get_base_domain()
        .unwrap_or_else(|| "http://localhost".to_string());
    let resolved = atomic_lib::identifiers::emit_subject_for_caps(&subject.resolve(&origin), caps);
    let frame = match change {
        Change::Delta { bytes, commit_id } => {
            let commit_id = atomic_lib::identifiers::emit_subject_for_caps(commit_id, caps);
            encode_update(
                flags::HAS_COMMIT_ID | flags::PUSH,
                0,
                &resolved,
                Some(&commit_id),
                bytes,
            )
        }
        Change::Snapshot { bytes, commit_id } => {
            let mut bits = flags::SNAPSHOT | flags::PUSH;
            if commit_id.is_some() {
                bits |= flags::HAS_COMMIT_ID;
            }
            let commit_id =
                commit_id.map(|c| atomic_lib::identifiers::emit_subject_for_caps(c, caps));
            encode_update(bits, 0, &resolved, commit_id.as_deref(), bytes)
        }
        Change::Destroyed => encode_destroy(0, &resolved),
    };
    Arc::from(frame.into_boxed_slice())
}
