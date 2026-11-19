// SPDX-License-Identifier: MIT
// Shared only by the offline fixture and opt-in native recovery test build.
use std::collections::{BTreeMap, HashSet};

use atomic_lib::{db::trees::Tree, Db};
use serde::Serialize;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Fingerprint {
    entries: u64,
    bytes: u64,
    blake3: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Fingerprints {
    all: BTreeMap<String, Fingerprint>,
    drive: BTreeMap<String, Fingerprint>,
}

fn fingerprint(
    db: &Db,
    tree: Tree,
    subjects: Option<&HashSet<String>>,
) -> atomic_lib::errors::AtomicResult<Fingerprint> {
    let mut digest = blake3::Hasher::new();
    let mut entries = 0;
    let mut bytes = 0;
    // KvStore iter_tree is ordered by key. Length prefixes prevent field
    // boundaries from creating ambiguous concatenations.
    for entry in db.kv.iter_tree(tree) {
        let (key, value) = entry?;
        if let Some(subjects) = subjects {
            let subject_key = if tree == Tree::Envelopes {
                key.split(|byte| *byte == 0).next().unwrap_or_default()
            } else {
                &key
            };
            if !subjects
                .contains(std::str::from_utf8(subject_key).map_err(|error| error.to_string())?)
            {
                continue;
            }
        }
        digest.update(&(key.len() as u64).to_be_bytes());
        digest.update(&key);
        digest.update(&(value.len() as u64).to_be_bytes());
        digest.update(&value);
        entries += 1;
        bytes += (key.len() + value.len()) as u64;
    }
    Ok(Fingerprint {
        entries,
        bytes,
        blake3: digest.finalize().to_hex().to_string(),
    })
}

pub(crate) fn fingerprints(
    db: &Db,
    subjects: &HashSet<String>,
) -> atomic_lib::errors::AtomicResult<Fingerprints> {
    let mut all = BTreeMap::new();
    let mut drive = BTreeMap::new();
    for (name, tree) in [
        ("resources", Tree::Resources),
        ("loroSnapshots", Tree::LoroSnapshots),
        ("signedEnvelopes", Tree::Envelopes),
    ] {
        all.insert(name.into(), fingerprint(db, tree, None)?);
        drive.insert(name.into(), fingerprint(db, tree, Some(subjects))?);
    }
    Ok(Fingerprints { all, drive })
}
