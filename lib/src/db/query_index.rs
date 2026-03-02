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

/// A subset of a full [Query].
/// Represents a sorted filter on the Store.
/// A Value in the `watched_collections`.
/// Used as keys in the query_index.
/// These are used to check whether collections have to be updated when values have changed.
///
/// Every `QueryFilter` is scoped to a specific drive. Cross-drive indexed queries are not supported.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryFilter {
    /// Filtering by property URL
    pub property: Option<String>,
    /// Filtering by value
    pub value: Option<Value>,
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
        if self.property.is_none() && self.value.is_none() {
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
    pub fn try_from_query(q: &Query) -> AtomicResult<Self> {
        let drive = q.drive.clone().ok_or(
            "Indexed queries require a drive scope. Set Query::drive to the drive Subject.",
        )?;
        Ok(QueryFilter {
            property: q.property.clone(),
            value: q.value.clone(),
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

/// Checks if the resource will match with a QueryFilter.
/// Does any value or property or sort value match?
/// Returns the matching property, if found.
/// E.g. if a Resource
fn find_matching_propval<'a>(
    resource: &'a Resource,
    q_filter: &'a QueryFilter,
) -> Option<&'a String> {
    if let Some(property) = &q_filter.property {
        if let Ok(matched_val) = resource.get(property) {
            let Some(filter_val) = &q_filter.value else {
                // QueryFilter does not specify a value, so we always return a match for the property.
                return Some(property);
            };

            if matched_val.contains_value(filter_val) {
                return Some(property);
            }
        }
    } else if let Some(filter_val) = &q_filter.value {
        for (prop, val) in resource.get_propvals() {
            if val.contains_value(filter_val) {
                return Some(prop);
            }
        }
        return None;
    }
    None
}

/// Checks if a new IndexAtom should be updated for a specific [QueryFilter]
/// Returns which property should be updated, if any.
// This is probably the most complex function in the whole repo.
// If things go wrong when making changes, add a test and fix stuff in the logic below.
pub fn should_update_property<'a>(
    q_filter: &'a QueryFilter,
    index_atom: &'a IndexAtom,
    resource: &Resource,
) -> Option<&'a String> {
    // First we'll check if the resource matches the QueryFilter.
    // We'll need the `matching_val` for updating the index when a value changes that influences other indexed members.
    // For example, if we have a Query for children of a particular folder, sorted by name,
    // and we move one of the children to a different folder, we'll need to make sure that the index is updated containing the name of the child.
    // This name is not part of the `index_atom` itself, as the name wasn't updated.
    // So here we not only make sure that the QueryFilter actually matches the resource,
    // But we also return which prop & val we matched on, so we can update the index with the correct value.
    // See https://github.com/atomicdata-dev/atomic-server/issues/395
    let Some(matching_prop) = find_matching_propval(resource, q_filter) else {
        // if the resource doesn't match the filter, we don't need to update the index
        return None;
    };

    // Now we know that our new Resource is a member for this QueryFilter.
    // But we don't know whether this specific IndexAtom is relevant for the index of this QueryFilter.
    // There are three possibilities:
    // 1. The Atom is not relevant for the index, and we don't need to update the index.
    // 2. The Atom is directly relevant for the index, and we need to update the index using the value of the IndexAtom.
    // 3. The Atom is indirectly relevant for the index. This only happens if there is a `sort_by`.
    //    The Atom influences if the QueryFilter hits, and we need to construct a Key in the index with
    //    a value from another Property.
    match (&q_filter.property, &q_filter.value, &q_filter.sort_by) {
        // Whenever the atom matches with either the sorted or the filtered prop, we have to update
        (Some(_filterprop), Some(_filter_val), Some(sortprop)) => {
            if sortprop == &index_atom.property || matching_prop == &index_atom.property {
                // Update the Key, which contains the sorted prop & value.
                return Some(sortprop);
            }
            None
        }
        (Some(_filterprop), None, Some(sortprop)) => {
            if sortprop == &index_atom.property || matching_prop == &index_atom.property {
                return Some(sortprop);
            }
            None
        }
        (Some(filter_prop), Some(_filter_val), None) => {
            if filter_prop == &index_atom.property {
                // Update the Key, which contains the filtered value
                return Some(filter_prop);
            }
            None
        }
        (Some(filter_prop), None, None) => {
            if filter_prop == &index_atom.property {
                return Some(filter_prop);
            }
            None
        }
        (None, Some(filter_val), None) => {
            if filter_val.to_string() == index_atom.ref_value {
                return Some(&index_atom.property);
            }
            None
        }
        (None, Some(filter_val), Some(sort_by)) => {
            if filter_val.to_string() == index_atom.ref_value || &index_atom.property == sort_by {
                return Some(sort_by);
            }
            None
        }
        // TODO: Consider if we should allow the following indexes this.
        // See https://github.com/atomicdata-dev/atomic-server/issues/548
        // When changing these, also update [QueryFilter::watch]
        (None, None, None) => None,
        (None, None, Some(_)) => None,
    }
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
    println!("DEBUG: check_if_atom_matches_watched_query_filters: subject={}", index_atom.subject);
    let subject_str = index_atom.subject.as_str();

    let filters: Vec<Arc<QueryFilter>> = if subject_str.starts_with("did:") {
        store.all_watched_queries()
    } else {
        let drive_prefix = drive_prefix_from_subject(&index_atom.subject);
        store.watched_queries_for_drive(drive_prefix.as_str())
    };

    tracing::info!("check_if_atom_matches_watched_query_filters: subject={}, atom_prop={}, filters_count={}", subject_str, index_atom.property, filters.len());

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
    tracing::info!("update_indexed_member: subject={}, value={}, delete={}, filter={:?}", subject, value, delete, collection);
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
    query.sort_by.is_some() || query.start_val.is_some() || query.end_val.is_some()
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
        let filter = QueryFilter {
            property: Some("https://atomicdata.dev/properties/parent".to_string()),
            value: Some(Value::AtomicUrl(Subject::from(
                "did:ad:C1PsEdNI7K1D4N2dMVaaHwxwevsl/6pL8rSdejvD+ori3rZb6eafyTgeEVKCHPG0Po3SBQyT7Ea/7pB/Fl8PCg==",
            ))),
            sort_by: Some("https://atomicdata.dev/properties/createdAt".to_string()),
            drive: Subject::from("http://localhost:9883"),
        };

        let bytes = filter.encode().expect("encode");
        let contains_ff = bytes.contains(&0xff);
        assert!(
            !contains_ff,
            "QueryFilter encode must not contain 0xff (collides with SEPARATION_BIT used in QueryMembers keys). First ff at index {:?}",
            bytes.iter().position(|b| *b == 0xff)
        );

        let decoded = QueryFilter::from_bytes(&bytes).expect("decode");
        assert_eq!(decoded.property, filter.property);
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
            let collection = QueryFilter {
                property: Some("http://example.org/prop".to_string()),
                value: Some(Value::AtomicUrl("http://example.org/value".into())),
                sort_by: None,
                drive: Subject::from("https://example.com"),
            };
            let subject = "https://example.com/subject";
            let key =
                create_query_index_key(&collection, Some(&val.to_sortable_string()), Some(subject))
                    .unwrap();
            let (col, val_out, sub_out) = parse_collection_members_key(&key).unwrap();
            assert_eq!(col.property, collection.property);
            assert_eq!(val_check.to_string(), val_out);
            assert_eq!(sub_out, subject);
        }
    }

    #[test]
    fn lexicographic_partial() {
        let q = QueryFilter {
            property: Some("http://example.org/prop".to_string()),
            value: Some(Value::AtomicUrl("http://example.org/value".into())),
            sort_by: None,
            drive: Subject::from("https://example.com"),
        };

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

        let qf_prop_val = QueryFilter {
            property: Some(prop.clone()),
            value: Some(Value::AtomicUrl(class.to_string().into())),
            sort_by: None,
            drive: Subject::from("https://example.com"),
        };

        let qf_prop = QueryFilter {
            property: Some(prop.clone()),
            value: None,
            sort_by: None,
            drive: Subject::from("https://example.com"),
        };

        let qf_val = QueryFilter {
            property: None,
            value: Some(Value::AtomicUrl(class.to_string().into())),
            sort_by: None,
            drive: Subject::from("https://example.com"),
        };

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

        let qf_prop_val_sort = QueryFilter {
            property: Some(prop.clone()),
            value: Some(Value::AtomicUrl(class.to_string().into())),
            sort_by: Some(urls::DESCRIPTION.to_string()),
            drive: Subject::from("https://example.com"),
        };
        let qf_prop_sort = QueryFilter {
            property: Some(prop.clone()),
            value: None,
            sort_by: Some(urls::DESCRIPTION.to_string()),
            drive: Subject::from("https://example.com"),
        };
        let qf_val_sort = QueryFilter {
            property: Some(prop),
            value: Some(Value::AtomicUrl(class.to_string().into())),
            sort_by: Some(urls::DESCRIPTION.to_string()),
            drive: Subject::from("https://example.com"),
        };

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
}
