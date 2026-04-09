use crate::atoms::IndexAtom;

use super::{prop_val_sub_index::propvalsub_key, val_prop_sub_index::valpropsub_key};

#[derive(Debug, Clone)]
pub enum Tree {
    /// Full resources, Key: Subject, Value: [Propvals](crate::resources::PropVals)
    Resources,
    /// Stores the members of Collections, easily sortable.
    QueryMembers,
    /// A list of all the Collections currently being used. Is used to update `query_index`.
    WatchedQueries,
    /// Index sorted by {Property}-{Value}-{Subject}.
    /// Used for queries where the property is known.
    PropValSub,
    /// Reference index, used for queries where the value (or one of the values, in case of an array) is known but the subject is not.
    /// Index sorted by {Value}-{Property}-{Subject}.
    ValPropSub,
    /// Stores metadata about installed plugins.
    PluginMeta,
    /// Maps Drive Hints (short IDs) to full Drive DIDs.
    DriveMapping,
    /// Maps DID pure IDs to their best known routing hint (e.g. drive DID).
    DidMapping,
    /// Stores Loro CRDT snapshots as raw bytes, keyed by resource subject.
    /// Kept separate from Resources because binary data doesn't round-trip through JSON-AD.
    LoroSnapshots,
}

const RESOURCES: &str = "resources_v3";
const VALPROPSUB: &str = "reference_index_v1";
const QUERY_MEMBERS: &str = "members_index_v2";
const PROPVALSUB: &str = "prop_val_sub_index";
const QUERIES_WATCHED: &str = "watched_queries_v2";
const PLUGIN_META: &str = "plugin_meta";
const DRIVE_MAPPING: &str = "drive_mapping";
const DID_MAPPING: &str = "did_mapping";
const LORO_SNAPSHOTS: &str = "loro_snapshots";

impl std::fmt::Display for Tree {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Tree::Resources => f.write_str(RESOURCES),
            Tree::WatchedQueries => f.write_str(QUERIES_WATCHED),
            Tree::PropValSub => f.write_str(PROPVALSUB),
            Tree::ValPropSub => f.write_str(VALPROPSUB),
            Tree::QueryMembers => f.write_str(QUERY_MEMBERS),
            Tree::PluginMeta => f.write_str(PLUGIN_META),
            Tree::DriveMapping => f.write_str(DRIVE_MAPPING),
            Tree::DidMapping => f.write_str(DID_MAPPING),
            Tree::LoroSnapshots => f.write_str(LORO_SNAPSHOTS),
        }
    }
}

// convert Tree into AsRef<[u8]> by using the string above
impl AsRef<[u8]> for Tree {
    fn as_ref(&self) -> &[u8] {
        match self {
            Tree::Resources => RESOURCES.as_bytes(),
            Tree::WatchedQueries => QUERIES_WATCHED.as_bytes(),
            Tree::PropValSub => PROPVALSUB.as_bytes(),
            Tree::ValPropSub => VALPROPSUB.as_bytes(),
            Tree::QueryMembers => QUERY_MEMBERS.as_bytes(),
            Tree::PluginMeta => PLUGIN_META.as_bytes(),
            Tree::DriveMapping => DRIVE_MAPPING.as_bytes(),
            Tree::DidMapping => DID_MAPPING.as_bytes(),
            Tree::LoroSnapshots => LORO_SNAPSHOTS.as_bytes(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum Method {
    Insert,
    Delete,
}

/// A single operation to be executed on the database.
#[derive(Debug, Clone)]
pub struct Operation {
    pub tree: Tree,
    pub method: Method,
    pub key: Vec<u8>,
    pub val: Option<Vec<u8>>,
}

impl Operation {
    pub fn remove_atom_from_reference_index(index_atom: &IndexAtom) -> Self {
        Operation {
            tree: Tree::ValPropSub,
            method: Method::Delete,
            key: valpropsub_key(index_atom),
            val: None,
        }
    }
    pub fn remove_atom_from_prop_val_sub_index(index_atom: &IndexAtom) -> Self {
        Operation {
            tree: Tree::PropValSub,
            method: Method::Delete,
            key: propvalsub_key(index_atom),
            val: None,
        }
    }

    pub fn remove_resource(subject: &str) -> Self {
        Operation {
            tree: Tree::Resources,
            method: Method::Delete,
            key: subject.as_bytes().to_vec(),
            val: None,
        }
    }
}

/// A set of [Operation]s that should be executed atomically by the database.
pub type Transaction = Vec<Operation>;
