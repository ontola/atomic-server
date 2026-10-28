#![doc = include_str!("../README.md")]

pub mod agents;
/// **Internal:** aggregation helpers; outside the application API contract.
pub mod aggregate;
pub mod atoms;
pub mod authentication;
/// **Internal:** chat log models; outside the application API contract.
pub mod chat_log;
/// **Internal:** schema constraints; outside the application API contract.
pub mod class_constraints;
#[cfg(feature = "db")]
/// **Internal:** schema extension helpers; outside the application API contract.
pub mod class_extender;
pub mod client;
/// **Internal:** collection helpers; outside the application API contract.
pub mod collections;
pub mod commit;
#[cfg(feature = "config")]
/// **Internal:** filesystem configuration; outside the application API contract.
pub mod config;
#[cfg(feature = "db")]
/// **Internal:** conversation models; outside the application API contract.
pub mod conversation;
pub mod datatype;
#[cfg(feature = "db")]
/// **Internal:** database implementation and storage helpers; outside the application API contract.
pub mod db;
#[cfg(feature = "discovery")]
pub mod discovery;
#[doc(hidden)]
/// **Internal:** document rendering; outside the application API contract.
pub mod document_markdown;
#[cfg(feature = "db")]
/// **Internal:** application endpoints; outside the application API contract.
pub mod endpoints;
#[cfg(feature = "db")]
pub mod envelopes;
pub mod errors;
/// **Internal:** formula evaluation; outside the application API contract.
pub mod expression;
pub mod genesis;
pub mod hierarchy;
pub mod history;
pub mod identifiers;
/// **Internal:** identity import helpers; outside the application API contract.
pub mod import_identity;
pub mod loro;
/// **Internal:** mapping helpers; outside the application API contract.
pub mod mapping;
/// **Internal:** instrumentation; outside the application API contract.
pub mod metrics;
/// **Internal:** parsing helpers; outside the application API contract.
pub mod parse;
#[cfg(feature = "db")]
/// **Internal:** plugin models and helpers; outside the application API contract.
pub mod plugins;
/// **Internal:** website helpers; outside the application API contract.
pub mod website;

/// **Internal:** lens implementation; outside the application API contract.
pub mod lens;
/// **Internal:** built-in data population; outside the application API contract.
pub mod populate;
/// **Internal:** property identity helpers; outside the application API contract.
pub mod property_identity;
pub mod resources;
/// The node runtime boundary (`AtomicNode`). Wraps `Db`, so it needs `db`.
#[cfg(feature = "db")]
pub mod runtime;
/// **Internal:** schema implementation; outside the application API contract.
pub mod schema;
#[cfg(feature = "db")]
pub mod search;
/// **Internal:** interchange helpers; outside the application API contract.
pub mod serialize;
pub mod store;
pub mod storelike;
pub mod subject;
/// Only the persisting write paths need it, and those are all behind `db`.
#[cfg(feature = "db")]
pub(crate) mod subject_lock;
pub mod sync;
/// **Internal:** test support; outside the application API contract.
pub mod test_utils;
#[cfg(feature = "db")]
/// **Internal:** trash implementation; outside the application API contract.
pub mod trash;
pub mod urls;
/// **Internal:** implementation utilities; outside the application API contract.
pub mod utils;
/// **Internal:** schema validation helpers; outside the application API contract.
pub mod validate;
pub mod values;
/// **Internal:** vault and recovery helpers; outside the application API contract.
pub mod vault;

pub use atoms::Atom;
pub use commit::Commit;
#[cfg(feature = "db")]
pub use db::{
    AgentLoadResult, Db, DbEvent, DriveInfo, DriveUsage, ReplicationTarget, ResourceUsage,
};
pub use errors::AtomicError;
pub use errors::AtomicErrorType;
pub use identifiers::{
    agent_subject, blob_subject, canonicalize_scheme, commit_subject, emit_subject_for_caps,
    node_subject, resource_subject, scheme_alias, ATOMIC_AGENT_PREFIX, ATOMIC_BLOB_PREFIX,
    ATOMIC_COMMIT_PREFIX, ATOMIC_NODE_PREFIX, ATOMIC_PREFIX, CAP_CANONICAL_SCHEME,
    DID_AD_AGENT_PREFIX, DID_AD_BLOB_PREFIX, DID_AD_COMMIT_PREFIX, DID_AD_NODE_PREFIX,
    DID_AD_PREFIX,
};
pub use resources::Resource;
pub use store::Store;
pub use storelike::Storelike;
pub use subject::{DidKind, Subject};
pub use values::Value;
