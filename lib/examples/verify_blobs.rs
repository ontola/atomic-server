//! Diagnostic: verify every blob in a migrated redb store is intact.
//!
//! The sled→redb migration moves uploaded files from loose files on disk into
//! content-addressed storage (`Tree::Blobs`, keyed by BLAKE3 of the content).
//! This checks that every stored blob actually hashes to the key it is filed
//! under, so a truncated or mis-copied file cannot pass silently.
//!
//! ```sh
//! cargo run -p atomic_lib --features db-redb --example verify_blobs -- <store-dir>
//! ```
use atomic_lib::db::{kv_store::KvStore, redb_store::RedbStore, trees::Tree};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: verify_blobs <store-dir containing atomic.redb>");
    let path = std::path::Path::new(&dir).join("atomic.redb");

    let store = RedbStore::new_file(&path).expect("could not open redb");

    let mut count = 0usize;
    let mut total_bytes = 0usize;
    let mut corrupt = 0usize;

    for item in store.iter_tree(Tree::Blobs) {
        let (key, val) = item.expect("could not read blob");
        count += 1;
        total_bytes += val.len();

        let actual = blake3::hash(&val);
        if actual.as_bytes() != key.as_slice() {
            corrupt += 1;
            println!(
                "CORRUPT: stored under {} but content hashes to {}",
                hex::encode(&key),
                actual.to_hex()
            );
        }
    }

    println!("blobs checked : {count}");
    println!(
        "total bytes   : {total_bytes} ({:.1} MB)",
        total_bytes as f64 / 1_048_576.0
    );
    println!("corrupt       : {corrupt}");

    // Optional second arg: a file of hex blob hashes (one per line) that
    // resources reference. Every one must resolve, otherwise a File resource
    // points at content that is not there.
    let mut dangling = 0usize;
    if let Some(list) = std::env::args().nth(2) {
        let contents = std::fs::read_to_string(&list).expect("could not read hash list");
        let mut checked = 0usize;
        for line in contents.lines().filter(|l| !l.trim().is_empty()) {
            checked += 1;
            let key = hex::decode(line.trim()).expect("bad hex in hash list");
            match store.get(Tree::Blobs, &key) {
                Ok(Some(_)) => {}
                _ => {
                    dangling += 1;
                    println!("DANGLING: no blob stored for {line}");
                }
            }
        }
        println!("referenced    : {checked}");
        println!("dangling      : {dangling}");
    }

    if corrupt > 0 || dangling > 0 {
        std::process::exit(1);
    }
}
