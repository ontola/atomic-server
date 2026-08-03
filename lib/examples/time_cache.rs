use std::time::Instant;
use redb::{Database, TableDefinition};

const T: TableDefinition<&[u8], &[u8]> = TableDefinition::new("t");

fn main() {
    for &(label, cache) in &[("default_1gb", None), ("16mb", Some(16*1024*1024usize)), ("64mb", Some(64*1024*1024))] {
        let mut times = Vec::new();
        for i in 0..5 {
            let path = format!(".temp/cache_{label}_{i}.redb");
            let _ = std::fs::remove_file(&path);
            let t = Instant::now();
            let db = match cache {
                None => Database::create(&path).unwrap(),
                Some(c) => Database::builder().set_cache_size(c).create(&path).unwrap(),
            };
            {
                let mut tx = db.begin_write().unwrap();
                let _ = tx.open_table(T);
                tx.commit().unwrap();
            }
            times.push(t.elapsed());
            drop(db);
            let _ = std::fs::remove_file(&path);
        }
        println!("{label}: {:?}", times);
    }
}
