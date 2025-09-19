//! Index sorted by {Property}-{Value}-{Subject}.
use crate::{atoms::IndexAtom, errors::AtomicResult, Db, Value};
use rusqlite::params;

use super::{
    query_index::{IndexIterator, SEPARATION_BIT},
    trees::{Method, Operation, Transaction, Tree},
};

/// Finds all Atoms for a given {property}-{value} tuple.
/// Optimized version with connection pooling
pub fn find_in_prop_val_sub_index(store: &Db, prop: &str, val: Option<&Value>) -> IndexIterator {
    let mut prefix: Vec<u8> = [prop.as_bytes(), &[SEPARATION_BIT]].concat();
    if let Some(value) = val {
        prefix.extend(value.to_sortable_string().as_bytes());
        prefix.extend([SEPARATION_BIT]);
    }

    // Create an exclusive upper bound by appending 0xFF
    let mut prefix_end = prefix.clone();
    prefix_end.push(0xFF);

    let conn_result = store.pool.get();
    if conn_result.is_err() {
        return Box::new(std::iter::once(Err(
            "Failed to get connection from pool".into()
        )));
    }
    let conn = conn_result.unwrap();

    let stmt_result = conn
        .prepare_cached("SELECT key FROM prop_val_sub WHERE key >= ?1 AND key < ?2 ORDER BY key");

    if let Err(e) = stmt_result {
        return Box::new(std::iter::once(Err(format!(
            "Failed to prepare statement: {}",
            e
        )
        .into())));
    }
    let mut stmt = stmt_result.unwrap();

    let results: Vec<Vec<u8>> = match stmt.query_map(params![prefix, prefix_end], |row| {
        let key: Vec<u8> = row.get(0)?;
        Ok(key)
    }) {
        Ok(iter) => iter.filter_map(Result::ok).collect(),
        Err(e) => {
            return Box::new(std::iter::once(Err(format!(
                "Failed to query prop_val_sub: {}",
                e
            )
            .into())));
        }
    };

    Box::new(results.into_iter().map(|key| key_to_index_atom(&key)))
}

pub fn add_atom_to_prop_val_sub_index(
    index_atom: &IndexAtom,
    transaction: &mut Transaction,
) -> AtomicResult<()> {
    transaction.push(Operation {
        key: propvalsub_key(index_atom),
        val: Some(b"".to_vec()),
        tree: Tree::PropValSub,
        method: Method::Insert,
    });
    Ok(())
}

/// Constructs the Key for the prop_val_sub_index.
pub fn propvalsub_key(atom: &IndexAtom) -> Vec<u8> {
    [
        atom.property.as_bytes(),
        &[SEPARATION_BIT],
        atom.ref_value.as_bytes(),
        &[SEPARATION_BIT],
        atom.sort_value.as_bytes(),
        &[SEPARATION_BIT],
        atom.subject.as_bytes(),
    ]
    .concat()
}

/// Parses a Value index key string, converts it into an atom.
/// Note that the Value of the atom will always be a single AtomicURL here.
fn key_to_index_atom(key: &[u8]) -> AtomicResult<IndexAtom> {
    let mut parts = key.split(|b| b == &SEPARATION_BIT);
    let prop = std::str::from_utf8(parts.next().ok_or("Invalid key for prop_val_sub_index")?)
        .map_err(|_| "Can't parse prop into string")?;
    let ref_val = std::str::from_utf8(parts.next().ok_or("Invalid key for prop_val_sub_index")?)
        .map_err(|_| "Can't parse ref_val into string")?;
    let sort_val = std::str::from_utf8(parts.next().ok_or("Invalid key for prop_val_sub_index")?)
        .map_err(|_| "Can't parse sort_val into string")?;
    let sub = std::str::from_utf8(parts.next().ok_or("Invalid key for prop_val_sub_index")?)
        .map_err(|_| "Can't parse subject into string")?;
    Ok(IndexAtom {
        property: prop.into(),
        ref_value: ref_val.into(),
        sort_value: sort_val.into(),
        subject: sub.into(),
    })
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn round_trip() {
        let atom = IndexAtom {
            property: "http://example.com/prop".into(),
            ref_value: "http://example.com/val \n hello \n".into(),
            sort_value: "2".into(),
            subject: "http://example.com/subj".into(),
        };
        let key = propvalsub_key(&atom);
        let atom2 = key_to_index_atom(&key).unwrap();
        assert_eq!(atom, atom2);
    }

    #[test]
    fn test_find_in_prop_val_sub_index() {
        use crate::Db;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test.db");

        let store = Db::init(&db_path, "http://localhost".to_string()).unwrap();

        // Test finding atoms by property
        let iterator = find_in_prop_val_sub_index(&store, "http://example.com/prop", None);
        let results: Vec<_> = iterator.collect();
        assert_eq!(
            results.len(),
            0,
            "Should return empty results for new database"
        );

        // Test error handling with invalid connection
        // This is harder to test without mocking, but the error handling is in place
    }

    #[test]
    fn test_propvalsub_key_construction() {
        let atom = IndexAtom {
            property: "http://example.com/prop".into(),
            ref_value: "http://example.com/val".into(),
            sort_value: "sort_value".into(),
            subject: "http://example.com/subj".into(),
        };

        let key = propvalsub_key(&atom);

        // Verify the key structure
        assert!(key
            .windows(b"http://example.com/prop".len())
            .any(|w| w == b"http://example.com/prop"));
        assert!(key
            .windows(b"http://example.com/val".len())
            .any(|w| w == b"http://example.com/val"));
        assert!(key.windows(b"sort_value".len()).any(|w| w == b"sort_value"));
        assert!(key
            .windows(b"http://example.com/subj".len())
            .any(|w| w == b"http://example.com/subj"));

        // Verify separation bits are present
        let separation_count = key.iter().filter(|&&b| b == SEPARATION_BIT).count();
        assert_eq!(separation_count, 3, "Should have exactly 3 separation bits");
    }
}
