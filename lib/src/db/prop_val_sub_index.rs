//! Index sorted by {Property}-{Value}-{Subject}.
use crate::{atoms::IndexAtom, errors::AtomicResult, storelike::Storelike, Db, Value};

use super::{
    query_index::{IndexIterator, SEPARATION_BIT},
    trees::{Method, Operation, Transaction, Tree},
};

/// Finds all Atoms for a given {property}-{value} tuple.
pub fn find_in_prop_val_sub_index(store: &Db, prop: &str, val: Option<&Value>) -> IndexIterator {
    let mut prefix: Vec<u8> = [prop.as_bytes(), &[SEPARATION_BIT]].concat();
    if let Some(value) = val {
        prefix.extend(value.to_sortable_string().as_bytes());
        prefix.extend([SEPARATION_BIT]);
    }
    // Subjects are stored as their raw URL form in the index key. On read we
    // must re-normalize against the server's base_domain so that e.g.
    // `https://localhost/x` becomes `Subject::Internal { internal:/x }` — the
    // later `is_local()` filter in `query_basic` rejects `Subject::External`,
    // which would drop every hit from a query against a localhost server.
    let base_domain = store.get_base_domain();
    Box::new(store.kv.scan_prefix(Tree::PropValSub, &prefix).map(move |kv| {
        let (key, _value) = kv?;
        key_to_index_atom(&key, base_domain.as_deref())
    }))
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
        atom.subject.as_str().as_bytes(),
    ]
    .concat()
}

/// Parses a Value index key string, converts it into an atom.
/// Note that the Value of the atom will always be a single AtomicURL here.
fn key_to_index_atom(key: &[u8], base_domain: Option<&str>) -> AtomicResult<IndexAtom> {
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
        subject: crate::Subject::from_raw(sub, base_domain),
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
        let atom2 = key_to_index_atom(&key, None).unwrap();
        assert_eq!(atom, atom2);
    }
}
