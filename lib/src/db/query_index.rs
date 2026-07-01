//! The QueryIndex is used to speed up queries by persisting filtered, sorted collections.
//! It relies on lexicographic ordering of keys, which Sled utilizes using `scan_prefix` queries.

use crate::{
    agents::ForAgent, atoms::IndexAtom, errors::AtomicResult, storelike::Query,
    utils::truncate_string, values::SortableValue, Atom, Db, Resource, Storelike, Subject, Value,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::trees::{self, Operation, Transaction, Tree};

/// Returned by functions that iterate over [IndexAtom]s
pub type IndexIterator = Box<dyn Iterator<Item = AtomicResult<IndexAtom>> + Send>;

// `PropVal` lives in `storelike` (always compiled, unlike the feature-gated
// `db` module) so `Query` can reference it. Re-exported here for the index code
// and existing `query_index::PropVal` consumers.
pub use crate::storelike::{FilterOperator, PropVal};

/// A subset of a full [Query].
/// Represents a sorted filter on the Store.
/// A Value in the `watched_collections`.
/// Used as keys in the query_index.
/// These are used to check whether collections have to be updated when values have changed.
///
/// The `filters` are combined with **AND** semantics: a resource is a member
/// only if it matches every constraint. A single-constraint filter behaves
/// exactly like the old `property`/`value` pair.
///
/// Every `QueryFilter` is scoped to a specific drive. Cross-drive indexed queries are not supported.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryFilter {
    /// ANDed `(property, value)` constraints.
    pub filters: Vec<PropVal>,
    /// The property by which the collection is sorted
    pub sort_by: Option<String>,
    /// Drive scope: only index/match resources whose subject starts with this URL prefix.
    /// All watched queries must be drive-scoped to avoid spurious cross-tenant index updates.
    pub drive: Subject,
}

impl QueryFilter {
    #[tracing::instrument(skip_all)]
    /// Adds the QueryFilter to the `watched_queries` of the store.
    /// This means that whenever the store is updated (when a [Commit](crate::Commit) is added), the QueryFilter is checked.
    ///
    /// Routes through `Db::register_watched_query` so the in-memory
    /// `watched_queries_by_drive` map stays in sync. Repeated `watch()`
    /// calls for the same filter are idempotent.
    pub fn watch(&self, store: &Db) -> AtomicResult<()> {
        let has_constraint = self
            .filters
            .iter()
            .any(|c| c.property.is_some() || c.value.is_some());
        if !has_constraint {
            return Err("Cannot watch a query without a property or value. These types of queries are not implemented. See https://github.com/atomicdata-dev/atomic-server/issues/548 ".into());
        };
        store.register_watched_query(self.clone())
    }

    /// Check if this [QueryFilter] is being indexed
    pub fn is_watched(&self, store: &Db) -> bool {
        let query_filter_bin = self.encode().expect("Failed to encode QueryFilter");

        store
            .kv
            .contains_key(Tree::WatchedQueries, &query_filter_bin)
            .unwrap_or(false)
    }
}

impl QueryFilter {
    /// Constructs a QueryFilter from a Query that has a drive set.
    /// Returns an error if the query has no drive — all indexed queries must be drive-scoped.
    /// Convenience constructor for a single-constraint filter — mirrors the
    /// old `property`/`value` shape.
    pub fn single(
        property: Option<String>,
        value: Option<Value>,
        sort_by: Option<String>,
        drive: Subject,
    ) -> Self {
        QueryFilter {
            filters: vec![PropVal {
                property,
                value,
                ..Default::default()
            }],
            sort_by,
            drive,
        }
    }

    pub fn try_from_query(q: &Query) -> AtomicResult<Self> {
        let drive = q.drive.clone().ok_or(
            "Indexed queries require a drive scope. Set Query::drive to the drive Subject.",
        )?;
        let mut filters: Vec<PropVal> = Vec::new();
        // The primary `property`/`value` pair (back-compat) becomes the first
        // constraint.
        if q.property.is_some() || q.value.is_some() {
            filters.push(PropVal {
                property: q.property.clone(),
                value: q.value.clone(),
                operator: crate::storelike::FilterOperator::Equal,
            });
        }
        // Additional ANDed constraints.
        filters.extend(q.filters.iter().cloned());

        Ok(QueryFilter {
            filters,
            sort_by: q.sort_by.clone(),
            drive,
        })
    }
}

/// Last character in lexicographic ordering
pub const FIRST_CHAR: &str = "\u{0000}";
pub const END_CHAR: &str = "\u{ffff}";
/// We can only store one bytearray as a key in Sled.
/// We separate the various items in it using this bit that's illegal in UTF-8.
pub const SEPARATION_BIT: u8 = 0xff;
/// If we want to sort by a value that is no longer there, we use this special value.
pub const NO_VALUE: &str = "";

#[tracing::instrument(skip_all)]
/// Performs a query on the `query_index` Tree, which is a lexicographic sorted list of all hits for QueryFilters.
pub async fn query_sorted_indexed(
    store: &Db,
    q: &Query,
    q_filter: &QueryFilter,
) -> AtomicResult<(Vec<Subject>, Vec<Resource>, usize)> {
    // When there is no explicit start / end value passed, we use the very first and last
    // lexicographic characters in existence to make the range practically encompass all values.
    let start = if let Some(val) = &q.start_val {
        val.clone()
    } else {
        Value::String(FIRST_CHAR.into())
    };
    let end = if let Some(val) = &q.end_val {
        val.clone()
    } else {
        Value::String(END_CHAR.into())
    };
    let start_key = create_query_index_key(q_filter, Some(&start.to_sortable_string()), None)?;
    let end_key = create_query_index_key(q_filter, Some(&end.to_sortable_string()), None)?;

    let iter = store
        .kv
        .range(Tree::QueryMembers, start_key, end_key, q.sort_desc);

    let mut subjects: Vec<Subject> = vec![];
    let mut resources: Vec<Resource> = vec![];
    let mut count = 0;

    let base_domain = store.get_base_domain();

    let limit = q.limit.unwrap_or(usize::MAX);

    for (i, kv) in iter.enumerate() {
        // The user's maximum amount of results has not yet been reached
        // and
        // The users minimum starting distance (offset) has been reached
        let in_selection = subjects.len() < limit && i >= q.offset;
        // Tracks whether this iter step should bump the visible count.
        // Defaults to true so entries past the page limit still count
        // (preserving the cheap-pagination behavior). Flipped to false
        // for in-page entries that don't survive include_external /
        // auth filtering, so count stays consistent with subjects.len()
        // for the page the client just received — eliminates the
        // `totalMembers: N, members: []` drift (issue #286).
        let mut should_count = true;
        if in_selection {
            let (k, _v) = kv?;
            let (_q_filter, _val, subject_str) = parse_collection_members_key(&k)?;

            let subject = Subject::from_raw(subject_str, base_domain.as_deref());

            if !q.include_external && !subject.is_local() {
                should_count = false;
            } else if should_include_resource(q) {
                if let Ok(resource) = store
                    .get_resource_extended(&subject, true, &q.for_agent)
                    .await
                {
                    resources.push(resource.to_single());
                    subjects.push(subject);
                } else {
                    // Index hit that doesn't resolve for this agent
                    // (auth-filtered or destroyed-with-stale-index).
                    should_count = false;
                }
            } else {
                subjects.push(subject);
            }
        }

        // We iterate over every single resource, even if we don't perform any computation on the items.
        // This helps with pagination, but it comes at a serious performance cost. We might need to change how this works later on.
        // Also, this count does not take into account the `include_external` filter.
        if should_count {
            count += 1;
        }
        // https://github.com/atomicdata-dev/atomic-server/issues/290
    }

    Ok((subjects, resources, count))
}

/// Compares two values for ordering operators. Numeric when both parse as
/// numbers (covers Integer/Float/Timestamp and numeric strings); otherwise a
/// lexical comparison of their string forms (ISO dates sort correctly this way).
fn compare_values(actual: &Value, query: &Value) -> std::cmp::Ordering {
    let a = actual.to_string();
    let b = query.to_string();

    match (a.parse::<f64>(), b.parse::<f64>()) {
        (Ok(x), Ok(y)) => x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal),
        _ => a.cmp(&b),
    }
}

/// Whether a single resource value satisfies the constraint's value + operator.
fn value_matches(actual: &Value, query: &Value, operator: FilterOperator) -> bool {
    use std::cmp::Ordering;
    use FilterOperator::*;

    match operator {
        // Scalar equality or array membership — the historical behaviour.
        Equal => actual.contains_value(query),
        StartsWith => actual.to_string().starts_with(&query.to_string()),
        Contains => actual.to_string().contains(&query.to_string()),
        GreaterThan => compare_values(actual, query) == Ordering::Greater,
        GreaterThanOrEqual => {
            matches!(
                compare_values(actual, query),
                Ordering::Greater | Ordering::Equal
            )
        }
        LessThan => compare_values(actual, query) == Ordering::Less,
        LessThanOrEqual => {
            matches!(
                compare_values(actual, query),
                Ordering::Less | Ordering::Equal
            )
        }
    }
}

/// Whether a single `(property, value)` constraint matches a resource.
fn constraint_matches(resource: &Resource, c: &PropVal) -> bool {
    match (&c.property, &c.value) {
        (Some(property), Some(value)) => {
            matches!(resource.get(property), Ok(v) if value_matches(v, value, c.operator))
        }
        // Property only: the resource must have that property.
        (Some(property), None) => resource.get(property).is_ok(),
        // Value only: any property of the resource satisfies the constraint.
        (None, Some(value)) => resource
            .get_propvals()
            .iter()
            .any(|(_p, v)| value_matches(v, value, c.operator)),
        // No constraint at all is vacuously true (filtered out by `watch`).
        (None, None) => true,
    }
}

/// Whether a resource matches **all** of a QueryFilter's constraints (AND).
pub fn resource_matches_filter(resource: &Resource, q_filter: &QueryFilter) -> bool {
    q_filter
        .filters
        .iter()
        .all(|c| constraint_matches(resource, c))
}

/// Whether this atom is part of any of the filter's constraints (so a change
/// to it can flip membership and must trigger an index update).
fn atom_touches_constraint(q_filter: &QueryFilter, index_atom: &IndexAtom) -> bool {
    q_filter
        .filters
        .iter()
        .any(|c| match (&c.property, &c.value) {
            (Some(property), _) => property == &index_atom.property,
            (None, Some(value)) => value.to_string() == index_atom.ref_value,
            (None, None) => false,
        })
}

/// The property whose value is written into the index key for this filter.
/// `sort_by` wins (so members sort by it); otherwise the first constraint
/// property gives a stable bucket; failing that (all value-only) the atom's
/// own property is used.
fn index_key_property<'a>(q_filter: &'a QueryFilter, index_atom: &'a IndexAtom) -> &'a String {
    if let Some(sort_by) = &q_filter.sort_by {
        return sort_by;
    }
    for c in &q_filter.filters {
        if let Some(property) = &c.property {
            return property;
        }
    }
    &index_atom.property
}

/// Checks if a new IndexAtom should be updated for a specific [QueryFilter]
/// Returns which property should be updated, if any.
//
// Generalised for multi-constraint (AND) filters. The resource must match
// every constraint, and the changed atom must be relevant (it's the `sort_by`
// property or part of one of the constraints). The returned property
// determines which value lands in the index key (see `index_key_property`).
// See https://github.com/atomicdata-dev/atomic-server/issues/395 and #548.
pub fn should_update_property<'a>(
    q_filter: &'a QueryFilter,
    index_atom: &'a IndexAtom,
    resource: &Resource,
) -> Option<&'a String> {
    // The resource must be a member of the filter (all constraints match).
    if !resource_matches_filter(resource, q_filter) {
        return None;
    }

    // Is this specific atom relevant to the index? Either it's the sort key, or
    // it participates in one of the constraints (so changing it can flip
    // membership). If neither, the index key for this resource is unaffected.
    let touches_sort = q_filter
        .sort_by
        .as_ref()
        .is_some_and(|s| s == &index_atom.property);

    if !touches_sort && !atom_touches_constraint(q_filter, index_atom) {
        return None;
    }

    Some(index_key_property(q_filter, index_atom))
}

/// This is called when an atom is added or deleted.
/// Check whether the [Atom] will be hit by a [Query] matching the [QueryFilter].
/// Updates the index accordingly.
/// We need both the `index_atom` and the full `atom`.
///
/// Reads from the in-memory `watched_queries_by_drive` map populated by
/// `Db::populate_watched_queries_cache` at open and kept in sync by
/// `Db::register_watched_query`. The KV `Tree::WatchedQueries` is the
/// persistence layer; this hot path doesn't touch msgpack at all.
///
/// For URL-drive atoms we look up by drive prefix — O(1) HashMap lookup
/// → iterate only that drive's filters. DID-subject atoms can't be
/// prefix-matched to a single drive, so they iterate every filter in the
/// map (matches the prior `iter_tree` fallback).
#[tracing::instrument(level = "info", skip_all)]
pub fn check_if_atom_matches_watched_query_filters(
    store: &Db,
    index_atom: &IndexAtom,
    _atom: &Atom,
    delete: bool,
    resource: &Resource,
    transaction: &mut Transaction,
) -> AtomicResult<()> {
    let subject_str = index_atom.subject.as_str();

    let filters: Vec<Arc<QueryFilter>> = if subject_str.starts_with("did:") {
        store.all_watched_queries()
    } else {
        let drive_prefix = drive_prefix_from_subject(&index_atom.subject);
        store.watched_queries_for_drive(drive_prefix.as_str())
    };

    tracing::trace!(
        "check_if_atom_matches_watched_query_filters: subject={}, atom_prop={}, filters_count={}",
        subject_str,
        index_atom.property,
        filters.len()
    );

    for q_filter in &filters {
        if let Some(prop) = should_update_property(q_filter, index_atom, resource) {
            let update_val = match resource.get(prop) {
                Ok(val) => val.to_sortable_string(),
                Err(_e) => NO_VALUE.to_string(),
            };
            update_indexed_member(
                q_filter,
                index_atom.subject.as_str(),
                &update_val,
                delete,
                transaction,
            )?;
        }
    }
    Ok(())
}

/// Adds or removes a single item (IndexAtom) to the [Tree::QueryMembers] cache.
#[tracing::instrument(skip_all)]
pub fn update_indexed_member(
    collection: &QueryFilter,
    subject: &str,
    value: &SortableValue,
    delete: bool,
    transaction: &mut Transaction,
) -> AtomicResult<()> {
    tracing::info!(
        "update_indexed_member: subject={}, value={}, delete={}, filter={:?}",
        subject,
        value,
        delete,
        collection
    );
    let key = create_query_index_key(collection, Some(value), Some(subject))?;
    if delete {
        transaction.push(Operation {
            tree: Tree::QueryMembers,
            method: trees::Method::Delete,
            key,
            val: None,
        })
    } else {
        transaction.push(Operation {
            tree: Tree::QueryMembers,
            method: trees::Method::Insert,
            key,
            val: Some(b"".into()),
        });
    }
    Ok(())
}

/// Maximum string length for values in the query_index. Should be long enough to contain pretty long URLs, but not very long documents.
// Consider moving this to [Value::to_sortable_string]
pub const MAX_LEN: usize = 120;

/// Creates a key for a collection + value combination.
/// These are designed to be lexicographically sortable.
#[tracing::instrument(skip_all)]
pub fn create_query_index_key(
    query_filter: &QueryFilter,
    value: Option<&SortableValue>,
    subject: Option<&str>,
) -> AtomicResult<Vec<u8>> {
    let mut q_filter_bytes = query_filter.encode()?;

    q_filter_bytes.push(SEPARATION_BIT);

    let mut value_bytes: Vec<u8> = if let Some(val) = value {
        let shorter = truncate_string(val, MAX_LEN);
        let lowercase = shorter.to_lowercase();
        lowercase.as_bytes().to_vec()
    } else {
        vec![0]
    };

    value_bytes.push(SEPARATION_BIT);

    let subject_bytes = if let Some(sub) = subject {
        sub.as_bytes().to_vec()
    } else {
        vec![0]
    };

    let bytesvec: Vec<u8> = [q_filter_bytes, value_bytes, subject_bytes].concat();
    Ok(bytesvec)
}

/// Parses a key that is meant for collections to a tuble of QueryFilter, value, and subject.
#[tracing::instrument(skip_all)]
pub fn parse_collection_members_key(bytes: &[u8]) -> AtomicResult<(QueryFilter, &str, &str)> {
    let mut iter = bytes.split(|b| b == &SEPARATION_BIT);
    let q_filter_bytes = iter.next().ok_or("No q_filter_bytes")?;
    let value_bytes = iter.next().ok_or("No value_bytes")?;
    let subject_bytes = iter.next().ok_or("No value_bytes")?;

    let q_filter: QueryFilter = QueryFilter::from_bytes(q_filter_bytes)?;

    let value = if !value_bytes.is_empty() {
        std::str::from_utf8(value_bytes)
            .map_err(|e| format!("Can't parse value in members_key: {}", e))?
    } else {
        return Err("Can't parse value in members_key".into());
    };

    let subject = if !subject_bytes.is_empty() {
        std::str::from_utf8(subject_bytes)
            .map_err(|e| format!("Can't parse subject in members_key: {}", e))?
    } else {
        return Err("Can't parse subject in members_key".into());
    };

    Ok((q_filter, value, subject))
}

pub fn requires_query_index(query: &Query) -> bool {
    query.sort_by.is_some()
        || query.start_val.is_some()
        || query.end_val.is_some()
        // Multi-property (AND) filters can only be answered by the combined
        // index — the basic prop/val sub-index path matches a single constraint.
        || !query.filters.is_empty()
}

/// Extracts the drive prefix from a resource subject URL.
///
/// - `internal:/path` → `"internal:/"`
/// - `internal:tenant:/path` → `"internal:tenant:/"`
/// - `https://example.com/path` → `"https://example.com"`
/// - `did:ad:...` → the subject itself (DID subjects have no prefix drive)
pub fn drive_prefix_from_subject(subject: &Subject) -> Subject {
    let s = subject.as_str();
    let prefix = if s.starts_with("internal:") {
        // Matches both "internal:/path" and "internal:sub:/path"
        s.find(":/").map(|pos| s[..pos + 2].to_string())
    } else if s.starts_with("http://") || s.starts_with("https://") {
        url::Url::parse(s).ok().map(|url| {
            let host = url.host_str().unwrap_or("");
            match url.port() {
                Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
                None => format!("{}://{}", url.scheme(), host),
            }
        })
    } else {
        None
    };
    Subject::from(prefix.unwrap_or_else(|| s.to_string()))
}

pub fn should_include_resource(query: &Query) -> bool {
    query.include_nested || query.for_agent != ForAgent::Sudo
}

#[cfg(test)]
pub mod test {
    use super::*;
    use crate::{urls, values::SubResource};

    /// Regression: real-world folder-table filters (where value is a DID
    /// Subject and property+sort_by are atomicdata.dev URLs) must round-trip
    /// through encode/from_bytes. If the msgpack tail contains an 0xff byte
    /// it collides with the outer SEPARATION_BIT splitter in
    /// `parse_collection_members_key`, silently cutting the q_filter prefix
    /// short — which shows up in the UI as duplicate/unordered rows.
    #[test]
    fn encode_decode_folder_table_filter() {
        use crate::Value;
        let filter = QueryFilter::single(
            Some("https://atomicdata.dev/properties/parent".to_string()),
            Some(Value::AtomicUrl(Subject::from(
                "did:ad:C1PsEdNI7K1D4N2dMVaaHwxwevsl/6pL8rSdejvD+ori3rZb6eafyTgeEVKCHPG0Po3SBQyT7Ea/7pB/Fl8PCg==",
            ))),
            Some("https://atomicdata.dev/properties/createdAt".to_string()),
            Subject::from("http://localhost:9883"),
        );

        let bytes = filter.encode().expect("encode");
        let contains_ff = bytes.contains(&0xff);
        assert!(
            !contains_ff,
            "QueryFilter encode must not contain 0xff (collides with SEPARATION_BIT used in QueryMembers keys). First ff at index {:?}",
            bytes.iter().position(|b| *b == 0xff)
        );

        let decoded = QueryFilter::from_bytes(&bytes).expect("decode");
        assert_eq!(decoded.filters[0].property, filter.filters[0].property);
        assert_eq!(decoded.sort_by, filter.sort_by);
        assert_eq!(decoded.drive.as_str(), filter.drive.as_str());

        // Round-trip through create_query_index_key + parse_collection_members_key
        // — this is the path queries actually take.
        let key = create_query_index_key(
            &filter,
            Some(&"2026-04-21".to_string()),
            Some("https://localhost/members/foo"),
        )
        .expect("create_query_index_key");
        let (parsed_filter, val, sub) =
            parse_collection_members_key(&key).expect("parse_collection_members_key");
        assert_eq!(parsed_filter.drive.as_str(), filter.drive.as_str());
        assert_eq!(val, "2026-04-21");
        assert_eq!(sub, "https://localhost/members/foo");
    }

    #[tokio::test]
    async fn create_and_parse_key() {
        round_trip_same(Value::String("\n".into()));
        round_trip_same(Value::String("short".into()));
        round_trip_same(Value::Float(1.142));
        round_trip_same(Value::Float(-1.142));
        round_trip(
            &Value::String("UPPERCASE".into()),
            &Value::String("uppercase".into()),
        );
        round_trip(&Value::String("29NA(E*Tn3028nt87n_#T&*NF_AE*&#N@_T*&!#B_&*TN&*AEBT&*#B&TB@#!#@BB29NA(E*Tn3028nt87n_#T&*NF_AE*&#N@_T*&!#B_&*TN&*AEBT&*#B&TB@#!#@BB29NA(E*Tn3028nt87n_#T&*NF_AE*&#N@_T*&!#B_&*TN&*AEBT&*#B&TB@#!#@BB29NA(E*Tn3028nt87n_#T&*NF_AE*&#N@_T*&!#B_&*TN&*AEBT&*#B&TB@#!#@BB29NA(E*Tn3028nt87n_#T&*NF_AE*&#N@_T*&!#B_&*TN&*AEBT&*#B&TB@#!#@BB29NA(E*Tn3028nt87n_#T&*NF_AE*&#N@_T*&!#B_&*TN&*AEBT&*#B&TB@#!#@BB29NA(E*Tn3028nt87n_#T&*NF_AE*&#N@_T*&!#B_&*TN&*AEBT&*#B&TB@#!#@BB29NA(E*Tn3028nt87n_#T&*NF_AE*&#N@_T*&!#B_&*TN&*AEBT&*#B&TB@#!#@BB".into()), &Value::String("29na(e*tn3028nt87n_#t&*nf_ae*&#n@_t*&!#b_&*tn&*aebt&*#b&tb@#!#@bb29na(e*tn3028nt87n_#t&*nf_ae*&#n@_t*&!#b_&*tn&*aebt&*#b".into()));

        fn round_trip_same(val: Value) {
            round_trip(&val, &val)
        }

        fn round_trip(val: &Value, val_check: &Value) {
            let collection = QueryFilter::single(
                Some("http://example.org/prop".to_string()),
                Some(Value::AtomicUrl("http://example.org/value".into())),
                None,
                Subject::from("https://example.com"),
            );
            let subject = "https://example.com/subject";
            let key =
                create_query_index_key(&collection, Some(&val.to_sortable_string()), Some(subject))
                    .unwrap();
            let (col, val_out, sub_out) = parse_collection_members_key(&key).unwrap();
            assert_eq!(col.filters[0].property, collection.filters[0].property);
            assert_eq!(val_check.to_string(), val_out);
            assert_eq!(sub_out, subject);
        }
    }

    #[test]
    fn lexicographic_partial() {
        let q = QueryFilter::single(
            Some("http://example.org/prop".to_string()),
            Some(Value::AtomicUrl("http://example.org/value".into())),
            None,
            Subject::from("https://example.com"),
        );

        let start_none = create_query_index_key(&q, None, None).unwrap();
        let num_1 = create_query_index_key(&q, Some(&Value::Float(1.0).to_sortable_string()), None)
            .unwrap();
        let num_2 = create_query_index_key(&q, Some(&Value::Float(2.0).to_sortable_string()), None)
            .unwrap();
        // let num_10 = create_query_index_key(&q, Some(&Value::Float(10.0)), None).unwrap();
        let num_1000 =
            create_query_index_key(&q, Some(&Value::Float(1000.0).to_sortable_string()), None)
                .unwrap();
        let start_str = create_query_index_key(
            &q,
            Some(&Value::String("1".into()).to_sortable_string()),
            None,
        )
        .unwrap();
        let a_downcase = create_query_index_key(
            &q,
            Some(&Value::String("a".into()).to_sortable_string()),
            None,
        )
        .unwrap();
        let b_upcase = create_query_index_key(
            &q,
            Some(&Value::String("B".into()).to_sortable_string()),
            None,
        )
        .unwrap();
        let mid3 = create_query_index_key(
            &q,
            Some(&Value::String("hi there".into()).to_sortable_string()),
            None,
        )
        .unwrap();
        let end = create_query_index_key(
            &q,
            Some(&Value::String(END_CHAR.into()).to_sortable_string()),
            None,
        )
        .unwrap();

        assert!(start_none < num_1);
        assert!(num_1 < num_2);
        // TODO: Fix sorting numbers
        // https://github.com/atomicdata-dev/atomic-server/issues/287
        // assert!(num_2 < num_10);
        // assert!(num_10 < num_1000);
        assert!(num_1000 < a_downcase);
        assert!(a_downcase < b_upcase);
        assert!(b_upcase < mid3);
        assert!(mid3 < end);

        let mut sorted = vec![&end, &start_str, &a_downcase, &b_upcase, &start_none];
        sorted.sort();

        let expected = vec![&start_none, &start_str, &a_downcase, &b_upcase, &end];

        assert_eq!(sorted, expected);
    }

    #[tokio::test]
    async fn should_update_or_not() {
        let store = &Db::init_temp("should_update_or_not").await.unwrap();

        let prop = urls::IS_A.to_string();
        let class = urls::AGENT;

        let qf_prop_val = QueryFilter::single(
            Some(prop.clone()),
            Some(Value::AtomicUrl(class.to_string().into())),
            None,
            Subject::from("https://example.com"),
        );

        let qf_prop = QueryFilter::single(
            Some(prop.clone()),
            None,
            None,
            Subject::from("https://example.com"),
        );

        let qf_val = QueryFilter::single(
            None,
            Some(Value::AtomicUrl(class.to_string().into())),
            None,
            Subject::from("https://example.com"),
        );

        let mut resource_correct_class = Resource::new_instance(class, store).await.unwrap();

        resource_correct_class
            .set(
                urls::IS_A.into(),
                Value::ResourceArray(vec![
                    SubResource::Subject(class.to_string().into()),
                    SubResource::Subject(urls::PARAGRAPH.to_string().into()),
                ]),
                store,
            )
            .await
            .unwrap();

        resource_correct_class
            .set(
                urls::PUBLIC_KEY.into(),
                Value::String("This is not a public key but it should be fine".into()),
                store,
            )
            .await
            .unwrap();
        resource_correct_class
            .set(
                urls::DESCRIPTION.into(),
                Value::Markdown("random description".into()),
                store,
            )
            .await
            .unwrap();

        let subject = Subject::from("https://example.com/someAgent");

        let index_atom = IndexAtom {
            subject,
            property: prop.clone(),
            ref_value: class.to_string(),
            sort_value: class.to_string(),
        };

        // We should be able to find the resource by propval, val, and / or prop.
        assert!(should_update_property(&qf_val, &index_atom, &resource_correct_class).is_some());
        assert!(
            should_update_property(&qf_prop_val, &index_atom, &resource_correct_class,).is_some()
        );
        assert!(should_update_property(&qf_prop, &index_atom, &resource_correct_class).is_some());

        // Test when a different value is passed
        let resource_wrong_class = Resource::new_instance(urls::PARAGRAPH, store)
            .await
            .unwrap();
        assert!(should_update_property(&qf_prop, &index_atom, &resource_wrong_class).is_some());
        assert!(should_update_property(&qf_val, &index_atom, &resource_wrong_class).is_none());
        assert!(should_update_property(&qf_prop_val, &index_atom, &resource_wrong_class).is_none());

        let qf_prop_val_sort = QueryFilter::single(
            Some(prop.clone()),
            Some(Value::AtomicUrl(class.to_string().into())),
            Some(urls::DESCRIPTION.to_string()),
            Subject::from("https://example.com"),
        );
        let qf_prop_sort = QueryFilter::single(
            Some(prop.clone()),
            None,
            Some(urls::DESCRIPTION.to_string()),
            Subject::from("https://example.com"),
        );
        let qf_val_sort = QueryFilter::single(
            Some(prop),
            Some(Value::AtomicUrl(class.to_string().into())),
            Some(urls::DESCRIPTION.to_string()),
            Subject::from("https://example.com"),
        );

        // We should update with a sort_by attribute
        assert!(
            should_update_property(&qf_prop_val_sort, &index_atom, &resource_correct_class,)
                .is_some()
        );
        assert!(
            should_update_property(&qf_prop_sort, &index_atom, &resource_correct_class,).is_some()
        );
        assert!(
            should_update_property(&qf_val_sort, &index_atom, &resource_correct_class,).is_some()
        );
    }

    /// Multi-property AND: a resource is a member only when it matches every
    /// constraint, and a change to any constraint property triggers an update.
    #[tokio::test]
    async fn multi_property_and_filter() {
        let store = &Db::init_temp("multi_property_and_filter").await.unwrap();
        let class = urls::AGENT;
        let drive = Subject::from("https://example.com");

        let mut resource = Resource::new_instance(class, store).await.unwrap();
        resource
            .set(
                urls::DESCRIPTION.into(),
                Value::Markdown("hello".into()),
                store,
            )
            .await
            .unwrap();

        // isA = Agent AND description = "hello"
        let matching = QueryFilter {
            filters: vec![
                PropVal {
                    property: Some(urls::IS_A.to_string()),
                    value: Some(Value::AtomicUrl(class.to_string().into())),
                    ..Default::default()
                },
                PropVal {
                    property: Some(urls::DESCRIPTION.to_string()),
                    value: Some(Value::String("hello".into())),
                    ..Default::default()
                },
            ],
            sort_by: None,
            drive: drive.clone(),
        };

        // isA = Agent AND description = "different"
        let non_matching = QueryFilter {
            filters: vec![
                PropVal {
                    property: Some(urls::IS_A.to_string()),
                    value: Some(Value::AtomicUrl(class.to_string().into())),
                    ..Default::default()
                },
                PropVal {
                    property: Some(urls::DESCRIPTION.to_string()),
                    value: Some(Value::String("different".into())),
                    ..Default::default()
                },
            ],
            sort_by: None,
            drive,
        };

        assert!(resource_matches_filter(&resource, &matching));
        assert!(!resource_matches_filter(&resource, &non_matching));

        // A change to the `isA` atom updates the matching filter's index...
        let is_a_atom = IndexAtom {
            subject: Subject::from("https://example.com/someAgent"),
            property: urls::IS_A.to_string(),
            ref_value: class.to_string(),
            sort_value: class.to_string(),
        };
        assert!(should_update_property(&matching, &is_a_atom, &resource).is_some());
        // ...but not the non-matching one (description constraint fails).
        assert!(should_update_property(&non_matching, &is_a_atom, &resource).is_none());

        // A change to the `description` atom (the second constraint prop) also
        // triggers an update for the matching filter.
        let desc_atom = IndexAtom {
            subject: Subject::from("https://example.com/someAgent"),
            property: urls::DESCRIPTION.to_string(),
            ref_value: "hello".to_string(),
            sort_value: "hello".to_string(),
        };
        assert!(should_update_property(&matching, &desc_atom, &resource).is_some());
    }

    #[tokio::test]
    async fn operator_filters() {
        let store = &Db::init_temp("operator_filters").await.unwrap();
        let drive = Subject::from("https://example.com");

        let mut resource = Resource::new_instance(urls::AGENT, store).await.unwrap();
        resource
            .set(
                urls::DESCRIPTION.into(),
                Value::Markdown("hello world".into()),
                store,
            )
            .await
            .unwrap();
        // A numeric value to exercise the comparison operators.
        resource
            .set_unsafe(urls::COLLECTION_PAGE_SIZE.into(), Value::Integer(42))
            .unwrap();

        let f = |property: &str, value: Value, operator: FilterOperator| QueryFilter {
            filters: vec![PropVal {
                property: Some(property.to_string()),
                value: Some(value),
                operator,
            }],
            sort_by: None,
            drive: drive.clone(),
        };

        use FilterOperator::*;

        // starts_with / contains on the markdown description.
        let sw = |v: &str| f(urls::DESCRIPTION, Value::String(v.into()), StartsWith);
        assert!(resource_matches_filter(&resource, &sw("hello")));
        assert!(!resource_matches_filter(&resource, &sw("world")));

        let ct = |v: &str| f(urls::DESCRIPTION, Value::String(v.into()), Contains);
        assert!(resource_matches_filter(&resource, &ct("lo wo")));
        assert!(!resource_matches_filter(&resource, &ct("xyz")));

        // Numeric comparisons against 42.
        let num = |v: i64, op: FilterOperator| f(urls::COLLECTION_PAGE_SIZE, Value::Integer(v), op);
        assert!(resource_matches_filter(&resource, &num(10, GreaterThan)));
        assert!(!resource_matches_filter(&resource, &num(50, GreaterThan)));
        assert!(resource_matches_filter(
            &resource,
            &num(42, GreaterThanOrEqual)
        ));
        assert!(resource_matches_filter(&resource, &num(100, LessThan)));
        assert!(!resource_matches_filter(&resource, &num(42, LessThan)));
        assert!(resource_matches_filter(
            &resource,
            &num(42, LessThanOrEqual)
        ));
    }
}
