//! Diagnostic: list every sled tree in a store with its entry count.
//!
//! Used to work out which `resources_v*` schema a legacy store is actually on
//! before migrating it. Run with:
//!
//! ```sh
//! cargo run -p atomic_lib --features db-sled --example list_sled_trees -- <path>
//! ```
fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: list_sled_trees <sled-dir>");

    let db = sled::open(&path).expect("could not open sled store");

    println!("sled store: {path}");
    let mut names: Vec<String> = db
        .tree_names()
        .iter()
        .map(|n| String::from_utf8_lossy(n).to_string())
        .collect();
    names.sort();

    for name in names {
        let len = db
            .open_tree(name.as_bytes())
            .map(|t| t.len())
            .unwrap_or_default();
        println!("{len:>10}  {name}");
    }
}
