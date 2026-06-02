//! Content-addressed `did:ad:frozen` resources.
//!
//! A frozen resource is identified by `did:ad:frozen:{blake3-hex}` over the
//! RFC 8785 (JCS) canonicalization of its JSON-AD body. This is the exact hash
//! the TypeScript producer computes
//! (`browser/lib/src/freeze.ts#frozenIdFor`), so ids are byte-for-byte
//! reproducible across languages. The shared contract is pinned by
//! `test-vectors/frozen.json`.
//!
//! Frozen objects are immutable and signatureless: they are verified by
//! re-hashing, never by a commit signature. See `planning/did-ad-frozen-server.md`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde_json::Value;

use crate::errors::AtomicResult;
use crate::subject::DID_AD_FROZEN_PREFIX;

/// Placeholder for an intra-cycle reference, by the referent's canonical index.
/// Matches `browser/lib/src/freeze.ts#SELF_PREFIX`.
const SELF_PREFIX: &str = "did:ad:frozen:self:";

/// Reserved top-level key marking a frozen **unit** object: the materialized form
/// of a reference cycle, whose value is an ordered array of member bodies that
/// reference each other by `did:ad:frozen:self:{index}`. Matches
/// `browser/lib/src/freeze.ts#UNIT_MEMBERS_KEY`.
pub const FROZEN_UNIT_KEY: &str = "urn:atomic-freeze:unit";

/// True if a frozen body is a cycle unit (vs. a single resource body).
pub fn is_unit(body: &serde_json::Value) -> bool {
    body.get(FROZEN_UNIT_KEY).is_some()
}

/// Computes the `did:ad:frozen:{blake3-hex}` id for a JSON-AD body.
pub fn frozen_id(body: &serde_json::Value) -> AtomicResult<String> {
    let canonical = serde_jcs::to_string(body)
        .map_err(|e| format!("Failed to JCS-canonicalize frozen body: {}", e))?;
    let hash = blake3::hash(canonical.as_bytes());

    Ok(format!("{}{}", DID_AD_FROZEN_PREFIX, hash.to_hex()))
}

/// Returns `Ok(())` when `body` hashes to `id`, otherwise an error. This is the
/// verify-by-rehash check the server runs on store and serve; no signature or
/// trust in the source is required.
pub fn verify_frozen(id: &str, body: &serde_json::Value) -> AtomicResult<()> {
    let actual = frozen_id(body)?;

    if actual == id {
        Ok(())
    } else {
        Err(format!(
            "Frozen body hashes to {} but was addressed as {}",
            actual, id
        )
        .into())
    }
}

/// A resource to be frozen, identified by a temporary `local_id`. Any string
/// value inside another resource's `content` that equals this `local_id` is a
/// reference and is rewritten to the computed frozen id.
pub struct FreezableResource {
    pub local_id: String,
    pub content: Value,
}

/// A content-addressed result: one per distinct frozen object (ordinary resource
/// or cycle unit). `unit` lists the local_ids it covers.
pub struct FrozenResource {
    pub frozen_id: String,
    pub content: Value,
    pub unit: Vec<String>,
}

pub struct FreezeResult {
    pub resources: Vec<FrozenResource>,
    pub by_local_id: HashMap<String, String>,
}

/// Content-addresses a set of mutually-referencing resources into a
/// `did:ad:frozen` Merkle DAG, byte-for-byte identical to
/// `browser/lib/src/freeze.ts#freezeResources`. References are rewritten to the
/// referent's hash before hashing; each reference cycle is frozen as one unit
/// object so every stored object stays verifiable by re-hash.
pub fn freeze_resources(input: Vec<FreezableResource>) -> AtomicResult<FreezeResult> {
    let ids: HashSet<String> = input.iter().map(|r| r.local_id.clone()).collect();

    if ids.len() != input.len() {
        return Err("freeze_resources: local_id values must be unique".into());
    }

    let by_id: HashMap<String, Value> =
        input.into_iter().map(|r| (r.local_id, r.content)).collect();
    let nodes: Vec<String> = by_id.keys().cloned().collect();
    let edges: HashMap<String, BTreeSet<String>> = by_id
        .iter()
        .map(|(id, content)| (id.clone(), collect_refs(content, &ids)))
        .collect();

    // Tarjan emits SCCs sinks-first (reverse topological), so every out-edge
    // points at an already-frozen component.
    let sccs = strongly_connected_components(&nodes, &edges);
    let mut frozen_by_local: HashMap<String, String> = HashMap::new();
    let mut out: Vec<FrozenResource> = Vec::new();

    for scc in sccs {
        let is_cycle = scc.len() > 1
            || edges
                .get(&scc[0])
                .map(|e| e.contains(&scc[0]))
                .unwrap_or(false);

        if is_cycle {
            freeze_cycle(&scc, &by_id, &edges, &mut frozen_by_local, &mut out)?;
        } else {
            freeze_singleton(&scc[0], &by_id, &edges, &mut frozen_by_local, &mut out)?;
        }
    }

    Ok(FreezeResult {
        resources: out,
        by_local_id: frozen_by_local,
    })
}

fn freeze_singleton(
    local_id: &str,
    by_id: &HashMap<String, Value>,
    edges: &HashMap<String, BTreeSet<String>>,
    frozen_by_local: &mut HashMap<String, String>,
    out: &mut Vec<FrozenResource>,
) -> AtomicResult<()> {
    let map = resolved_ref_map(edges.get(local_id), frozen_by_local);
    let content = substitute(&by_id[local_id], &map);
    let frozen_id = frozen_id(&content)?;

    frozen_by_local.insert(local_id.to_string(), frozen_id.clone());

    if let Some(existing) = out.iter_mut().find(|r| r.frozen_id == frozen_id) {
        existing.unit.push(local_id.to_string());
    } else {
        out.push(FrozenResource {
            frozen_id,
            content,
            unit: vec![local_id.to_string()],
        });
    }

    Ok(())
}

fn freeze_cycle(
    scc: &[String],
    by_id: &HashMap<String, Value>,
    edges: &HashMap<String, BTreeSet<String>>,
    frozen_by_local: &mut HashMap<String, String>,
    out: &mut Vec<FrozenResource>,
) -> AtomicResult<()> {
    let scc_set: HashSet<String> = scc.iter().cloned().collect();
    let order = canonical_order(scc, &scc_set, by_id, edges, frozen_by_local)?;
    let index_of: HashMap<String, usize> = order
        .iter()
        .enumerate()
        .map(|(i, id)| (id.clone(), i))
        .collect();

    let mut members: Vec<Value> = Vec::with_capacity(order.len());
    for local_id in &order {
        let map = cycle_ref_map(
            edges.get(local_id),
            &scc_set,
            Some(&index_of),
            frozen_by_local,
        );
        members.push(substitute(&by_id[local_id], &map));
    }
    let content = serde_json::json!({ FROZEN_UNIT_KEY: members });
    let frozen_id = frozen_id(&content)?;

    for local_id in &order {
        frozen_by_local.insert(local_id.clone(), frozen_id.clone());
    }

    out.push(FrozenResource {
        frozen_id,
        content,
        unit: order,
    });

    Ok(())
}

/// Deterministic, input-order-independent ordering of a cycle's members via
/// color refinement. Mirrors `freeze.ts#canonicalOrder`.
fn canonical_order(
    scc: &[String],
    scc_set: &HashSet<String>,
    by_id: &HashMap<String, Value>,
    edges: &HashMap<String, BTreeSet<String>>,
    frozen_by_local: &HashMap<String, String>,
) -> AtomicResult<Vec<String>> {
    let mut color: HashMap<String, String> = HashMap::new();
    for local_id in scc {
        let map = cycle_ref_map(edges.get(local_id), scc_set, None, frozen_by_local);
        color.insert(
            local_id.clone(),
            hash_canonical(&substitute(&by_id[local_id], &map))?,
        );
    }

    for _ in 0..scc.len() {
        let mut next: HashMap<String, String> = HashMap::new();
        for local_id in scc {
            let map = neighbor_color_ref_map(edges.get(local_id), scc_set, &color, frozen_by_local);
            next.insert(
                local_id.clone(),
                hash_canonical(&substitute(&by_id[local_id], &map))?,
            );
        }

        if partition_signature(scc, &next) == partition_signature(scc, &color) {
            color = next;
            break;
        }

        color = next;
    }

    let mut order: Vec<String> = scc.to_vec();
    order.sort_by(|a, b| color[a].cmp(&color[b]).then_with(|| a.cmp(b)));

    Ok(order)
}

fn resolved_ref_map(
    refs: Option<&BTreeSet<String>>,
    frozen_by_local: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for r in refs.into_iter().flatten() {
        if let Some(fid) = frozen_by_local.get(r) {
            map.insert(r.clone(), fid.clone());
        }
    }
    map
}

fn cycle_ref_map(
    refs: Option<&BTreeSet<String>>,
    scc_set: &HashSet<String>,
    index_of: Option<&HashMap<String, usize>>,
    frozen_by_local: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for r in refs.into_iter().flatten() {
        if scc_set.contains(r) {
            let token = match index_of {
                Some(idx) => format!("{}{}", SELF_PREFIX, idx[r]),
                None => SELF_PREFIX.to_string(),
            };
            map.insert(r.clone(), token);
        } else if let Some(fid) = frozen_by_local.get(r) {
            map.insert(r.clone(), fid.clone());
        }
    }
    map
}

fn neighbor_color_ref_map(
    refs: Option<&BTreeSet<String>>,
    scc_set: &HashSet<String>,
    color: &HashMap<String, String>,
    frozen_by_local: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for r in refs.into_iter().flatten() {
        if scc_set.contains(r) {
            map.insert(r.clone(), format!("{}{}", SELF_PREFIX, color[r]));
        } else if let Some(fid) = frozen_by_local.get(r) {
            map.insert(r.clone(), fid.clone());
        }
    }
    map
}

fn partition_signature(scc: &[String], color: &HashMap<String, String>) -> String {
    let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in scc {
        groups
            .entry(color[id].clone())
            .or_default()
            .push(id.clone());
    }
    let mut parts: Vec<String> = groups
        .into_values()
        .map(|mut g| {
            g.sort();
            g.join(",")
        })
        .collect();
    parts.sort();
    parts.join("|")
}

fn collect_refs(value: &Value, ids: &HashSet<String>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    walk_refs(value, ids, &mut out);
    out
}

fn walk_refs(value: &Value, ids: &HashSet<String>, out: &mut BTreeSet<String>) {
    match value {
        Value::String(s) => {
            if ids.contains(s) {
                out.insert(s.clone());
            }
        }
        Value::Array(a) => a.iter().for_each(|v| walk_refs(v, ids, out)),
        Value::Object(o) => o.values().for_each(|v| walk_refs(v, ids, out)),
        _ => {}
    }
}

fn substitute(value: &Value, map: &HashMap<String, String>) -> Value {
    match value {
        Value::String(s) => map
            .get(s)
            .map(|r| Value::String(r.clone()))
            .unwrap_or_else(|| value.clone()),
        Value::Array(a) => Value::Array(a.iter().map(|v| substitute(v, map)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), substitute(v, map)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn hash_canonical(value: &Value) -> AtomicResult<String> {
    let canonical =
        serde_jcs::to_string(value).map_err(|e| format!("Failed to JCS-canonicalize: {}", e))?;
    Ok(blake3::hash(canonical.as_bytes()).to_hex().to_string())
}

fn strongly_connected_components(
    nodes: &[String],
    edges: &HashMap<String, BTreeSet<String>>,
) -> Vec<Vec<String>> {
    struct State<'a> {
        edges: &'a HashMap<String, BTreeSet<String>>,
        index: HashMap<String, usize>,
        low: HashMap<String, usize>,
        on_stack: HashSet<String>,
        stack: Vec<String>,
        counter: usize,
        result: Vec<Vec<String>>,
    }

    fn connect(s: &mut State, v: &str) {
        s.index.insert(v.to_string(), s.counter);
        s.low.insert(v.to_string(), s.counter);
        s.counter += 1;
        s.stack.push(v.to_string());
        s.on_stack.insert(v.to_string());

        let neighbors: Vec<String> = s
            .edges
            .get(v)
            .map(|e| e.iter().cloned().collect())
            .unwrap_or_default();

        for w in neighbors {
            if !s.index.contains_key(&w) {
                connect(s, &w);
                let lw = s.low[&w];
                let lv = s.low[v];
                s.low.insert(v.to_string(), lv.min(lw));
            } else if s.on_stack.contains(&w) {
                let iw = s.index[&w];
                let lv = s.low[v];
                s.low.insert(v.to_string(), lv.min(iw));
            }
        }

        if s.low[v] == s.index[v] {
            let mut component = Vec::new();
            loop {
                let w = s.stack.pop().unwrap();
                s.on_stack.remove(&w);
                let is_root = w == v;
                component.push(w);
                if is_root {
                    break;
                }
            }
            s.result.push(component);
        }
    }

    let mut state = State {
        edges,
        index: HashMap::new(),
        low: HashMap::new(),
        on_stack: HashSet::new(),
        stack: Vec::new(),
        counter: 0,
        result: Vec::new(),
    };

    for v in nodes {
        if !state.index.contains_key(v) {
            connect(&mut state, v);
        }
    }

    state.result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vector {
        name: String,
        body: serde_json::Value,
        id: String,
    }

    #[derive(serde::Deserialize)]
    struct Vectors {
        vectors: Vec<Vector>,
    }

    /// Proves the Rust frozen id matches the TypeScript producer for every
    /// shared vector. A failure here is a cross-language identity break.
    #[test]
    fn matches_cross_language_vectors() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test-vectors/frozen.json"
        ));
        let parsed: Vectors = serde_json::from_str(raw).expect("valid fixture");

        assert!(!parsed.vectors.is_empty(), "fixture has no vectors");

        for vector in parsed.vectors {
            assert_eq!(
                frozen_id(&vector.body).unwrap(),
                vector.id,
                "frozen id mismatch for vector {}",
                vector.name
            );
        }
    }

    #[test]
    fn verify_frozen_rejects_a_mismatch() {
        let body = serde_json::json!({ "a": 1 });
        let wrong =
            "did:ad:frozen:0000000000000000000000000000000000000000000000000000000000000000";

        assert!(verify_frozen(&frozen_id(&body).unwrap(), &body).is_ok());
        assert!(verify_frozen(wrong, &body).is_err());
    }

    #[derive(serde::Deserialize)]
    struct FreezeInput {
        #[serde(rename = "localId")]
        local_id: String,
        content: serde_json::Value,
    }

    #[derive(serde::Deserialize)]
    struct FreezeCase {
        name: String,
        input: Vec<FreezeInput>,
        expected: HashMap<String, String>,
    }

    #[derive(serde::Deserialize)]
    struct FreezeCases {
        cases: Vec<FreezeCase>,
    }

    /// Proves the Rust `freeze_resources` graph algorithm (topological hashing +
    /// cycle units + color refinement) is byte-for-byte identical to the
    /// TypeScript producer — the foundation for authoring schemas in Rust.
    #[test]
    fn freeze_resources_matches_cross_language_vectors() {
        let raw = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test-vectors/freeze-resources.json"
        ));
        let parsed: FreezeCases = serde_json::from_str(raw).expect("valid fixture");

        assert!(!parsed.cases.is_empty(), "fixture has no cases");

        for case in parsed.cases {
            let input: Vec<FreezableResource> = case
                .input
                .into_iter()
                .map(|i| FreezableResource {
                    local_id: i.local_id,
                    content: i.content,
                })
                .collect();
            let result = freeze_resources(input).unwrap();

            assert_eq!(
                result.by_local_id, case.expected,
                "freeze_resources mismatch for case {}",
                case.name
            );
        }
    }
}
