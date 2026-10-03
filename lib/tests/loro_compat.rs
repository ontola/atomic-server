//! Loro runs twice in the browser: the tab edits resources with the npm
//! `loro-crdt` build, while the client-DB worker (atomic-wasm) and the server
//! read and merge the same bytes with this crate's Rust `loro`. These tests pin
//! that the two engines agree on the bytes they hand each other.
//!
//! Fixtures live in `lib/test_files/loro-compat/` and are shared with
//! `browser/lib/src/loro-compat.test.ts`:
//! - `tab-*` is written there with loro-crdt, shaped like a tab's resource doc;
//!   this file reads it through the same calls the worker makes.
//! - `rust-*` is written here, through `AtomicLoroDoc::set_property` (the
//!   worker's `build_state_doc` path); the JS test reads it.
//!
//! Regenerate after changing a fixture's shape (not after a version bump: the
//! point is that old bytes keep reading the same):
//!   LORO_COMPAT_REGENERATE=1 cargo test -p atomic_lib --test loro_compat
//!   LORO_COMPAT_REGENERATE=1 pnpm exec vitest run src/loro-compat.test.ts
//! Run: cargo test -p atomic_lib --test loro_compat

use atomic_lib::loro::{loro_value_to_atomic_value_tagged, AtomicLoroDoc};
use atomic_lib::values::SubResource;
use atomic_lib::Value;
use loro::{CommitOptions, LoroText, ValueOrContainer};
use serde_json::{json, Value as Json};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

const NAME: &str = "https://atomicdata.dev/properties/name";
const DESCRIPTION: &str = "https://atomicdata.dev/properties/description";
const IS_A: &str = "https://atomicdata.dev/properties/isA";
const PARENT: &str = "https://atomicdata.dev/properties/parent";
const COUNT: &str = "https://example.com/count";
const RATIO: &str = "https://example.com/ratio";
const DONE: &str = "https://example.com/done";
const LABEL: &str = "https://example.com/label";
const CONFIG: &str = "https://example.com/config";
const CREATED_AT: &str = "https://atomicdata.dev/properties/createdAt";
const TEXT_PATH: &str = "doc/children/0/children/0";
const T1: i64 = 1_700_000_000_000;
const T2: i64 = 1_700_000_060_000;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("test_files/loro-compat")
}

fn load(name: &str) -> Vec<u8> {
    std::fs::read(fixtures().join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"))
}

fn load_json(name: &str) -> Json {
    serde_json::from_slice(&load(name)).unwrap()
}

fn commit(doc: &AtomicLoroDoc, timestamp: i64, message: &str) {
    doc.doc().commit_with(
        CommitOptions::new()
            .timestamp(timestamp)
            .commit_msg(message),
    );
}

fn text_at(doc: &AtomicLoroDoc) -> Option<LoroText> {
    match doc.doc().get_by_str_path(TEXT_PATH)? {
        ValueOrContainer::Container(c) => c.into_text().ok(),
        ValueOrContainer::Value(_) => None,
    }
}

/// The same `{ deep, vv, delta }` view the JS test records with loro-crdt.
fn read_back(doc: &AtomicLoroDoc) -> Json {
    let delta = text_at(doc)
        .map(|t| serde_json::to_value(t.get_richtext_value()).unwrap())
        .unwrap_or(Json::Null);
    json!({
        "deep": serde_json::to_value(doc.doc().get_deep_value()).unwrap(),
        "vv": doc.oplog_vv_map(),
        "delta": delta,
    })
}

/// JSON equality that treats `42` and `42.0` as the same number: loro-crdt
/// stores every JS number as a double, and JSON cannot tell them apart.
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn assert_same(actual: &Json, expected: &Json, what: &str) {
    assert!(
        same(actual, expected),
        "{what} differs between engines\n  rust: {actual}\n  js:   {expected}"
    );
}

/// Shaped like a resource the worker or server materialises from JSON-AD:
/// every property goes through `AtomicLoroDoc::set_property`, plus a
/// loro-prosemirror style `doc` tree with a marked text node.
fn build_rust_docs() -> (Vec<u8>, Vec<u8>, Json) {
    let doc = AtomicLoroDoc::new();
    doc.set_peer_id(11).unwrap();
    let mut styles = loro::StyleConfigMap::new();
    styles.insert(
        "bold".into(),
        loro::StyleConfig {
            expand: loro::ExpandType::After,
        },
    );
    doc.doc().config_text_style(styles.clone());

    let set = |p: &str, v: Value| doc.set_property(p, &v).unwrap();
    set(NAME, Value::String("Written by Rust".into()));
    set(
        DESCRIPTION,
        Value::Markdown("# Heading\n\nSome *markdown*".into()),
    );
    set(PARENT, Value::AtomicUrl("https://example.com/drive".into()));
    set(COUNT, Value::Integer(42));
    set(RATIO, Value::Float(0.25));
    set(DONE, Value::Boolean(true));
    set(CREATED_AT, Value::Timestamp(T1));
    set(
        IS_A,
        Value::ResourceArray(vec![SubResource::Subject(
            "https://atomicdata.dev/classes/Document".into(),
        )]),
    );
    set(
        LABEL,
        Value::LocalizedText(BTreeMap::from([
            ("en".to_string(), "Hello".to_string()),
            ("nl".to_string(), "Hallo".to_string()),
        ])),
    );
    set(
        CONFIG,
        Value::Json(json!({"columns": [1, 2], "wide": false})),
    );

    let root = doc.doc().get_map("doc");
    root.insert("nodeName", "doc").unwrap();
    let children = root
        .insert_container("children", loro::LoroList::new())
        .unwrap();
    let para = children.insert_container(0, loro::LoroMap::new()).unwrap();
    para.insert("nodeName", "paragraph").unwrap();
    let para_children = para
        .insert_container("children", loro::LoroList::new())
        .unwrap();
    let text = para_children.insert_container(0, LoroText::new()).unwrap();
    text.insert(0, "Hello rich world").unwrap();
    text.mark(6..10, "bold", true).unwrap();
    commit(&doc, T1, "did:ad:agent:rust");

    let v1 = doc.export_snapshot();
    let vv1 = doc.oplog_vv();
    let exp1 = read_back(&doc);

    let other = AtomicLoroDoc::from_snapshot(&v1).unwrap();
    other.set_peer_id(12).unwrap();
    other.doc().config_text_style(styles);
    other
        .set_property(NAME, &Value::String("Renamed in Rust".into()))
        .unwrap();
    other.remove_property(DONE).unwrap();
    other
        .push_to_loro_list(IS_A, &json!("https://atomicdata.dev/classes/Article"))
        .unwrap();
    text_at(&other).unwrap().insert(16, "!").unwrap();
    commit(&other, T2, "did:ad:agent:rust-other");
    let v2 = other.export_updates_since(&vv1);

    let mut changed = vec![DONE, IS_A, NAME];
    changed.sort();
    let exp = json!({ "v1": exp1, "v2": read_back(&other), "changedByUpdate": changed });
    (v1, v2, exp)
}

#[test]
fn rust_fixture_describes_what_rust_writes() {
    let (v1, v2, exp) = build_rust_docs();
    let dir = fixtures();
    if std::env::var("LORO_COMPAT_REGENERATE").as_deref() == Ok("1")
        || !dir.join("rust-v1.snapshot").exists()
    {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rust-v1.snapshot"), &v1).unwrap();
        std::fs::write(dir.join("rust-v2.update"), &v2).unwrap();
        std::fs::write(
            dir.join("rust-expected.json"),
            serde_json::to_string_pretty(&exp).unwrap() + "\n",
        )
        .unwrap();
    }
    // If this fails, the committed bytes no longer show what the worker
    // writes, and the JS side would be testing a stale shape.
    assert_same(&exp, &load_json("rust-expected.json"), "rust fixture");
}

#[test]
fn reads_tab_snapshot_and_update_identically() {
    let exp = load_json("tab-expected.json");
    let snapshot = load("tab-v1.snapshot");

    let doc = AtomicLoroDoc::from_snapshot(&snapshot).unwrap();
    assert_same(&read_back(&doc), &exp["v1"], "v1 read");

    // `getAllVersionVectors` reads the version from the blob header only.
    let header_vv = AtomicLoroDoc::vv_map_from_snapshot(&snapshot).unwrap();
    assert_same(&json!(header_vv), &exp["v1"]["vv"], "v1 header version");

    doc.import_update(&load("tab-v2.update")).unwrap();
    assert_same(&read_back(&doc), &exp["v2"], "v2 read");
}

#[test]
fn materialises_tab_snapshot_to_atomic_values() {
    // What the worker indexes and returns as JSON-AD for a tab-written doc.
    let doc = AtomicLoroDoc::from_snapshot(&load("tab-v1.snapshot")).unwrap();
    let datatypes = doc.get_all_datatypes();
    let values: HashMap<String, Value> = doc
        .get_all_properties()
        .into_iter()
        .filter_map(|(k, v)| {
            let tag = datatypes.get(&k).map(String::as_str);
            loro_value_to_atomic_value_tagged(&v, tag).map(|v| (k, v))
        })
        .collect();

    assert!(matches!(&values[NAME], Value::String(s) if s == "Written by the tab"));
    assert!(matches!(&values[DESCRIPTION], Value::Markdown(s) if s.starts_with("# Heading")));
    assert!(matches!(&values[PARENT], Value::AtomicUrl(_)));
    assert_eq!(values[PARENT].to_string(), "https://example.com/drive");
    match &values[IS_A] {
        Value::ResourceArray(items) => {
            assert_eq!(items.len(), 1);
            assert_eq!(
                items[0].to_string(),
                "https://atomicdata.dev/classes/Document"
            );
        }
        other => panic!("isA materialised as {other:?}"),
    }
    assert!(matches!(values[DONE], Value::Boolean(true)));
    match values[COUNT] {
        Value::Integer(42) => {}
        Value::Float(42.0) => {}
        ref other => panic!("count materialised as {other:?}"),
    }
    assert!(matches!(values[RATIO], Value::Float(f) if f == 0.25));
}

#[test]
fn diffs_tab_update_like_an_incoming_commit() {
    // `applyCommit` in the worker: import the commit's Loro update into the
    // stored snapshot and derive the index atoms from the diff.
    let exp = load_json("tab-expected.json");
    let doc = AtomicLoroDoc::from_snapshot(&load("tab-v1.snapshot")).unwrap();
    let diff = doc
        .import_update_with_diff(&load("tab-v2.update"), "https://example.com/r")
        .unwrap();

    let mut changed: Vec<String> = diff
        .add_atoms
        .iter()
        .chain(&diff.remove_atoms)
        .map(|a| a.property.clone())
        .collect();
    changed.sort();
    changed.dedup();
    assert_same(
        &json!(changed),
        &exp["changedByUpdate"],
        "changed properties",
    );
}
