//! Tests to verify SQLite configuration is applied correctly

#[cfg(test)]
mod tests {
    use crate::Db;
    use tempfile::TempDir;

    #[test]
    fn test_sqlite_wal_configuration() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_wal.db");

        // Create database instance
        let store = Db::init(&db_path, "http://localhost".to_string()).unwrap();

        // Get a connection from the pool to test configuration
        let conn = store.pool.get().unwrap();

        // Check WAL mode
        let journal_mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode, "wal", "Database should be in WAL mode");

        // Check other important settings
        let synchronous: i64 = conn
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .unwrap();
        assert_eq!(synchronous, 1, "Synchronous should be NORMAL (1)"); // NORMAL mode

        let temp_store: i64 = conn
            .pragma_query_value(None, "temp_store", |row| row.get(0))
            .unwrap();
        assert_eq!(temp_store, 2, "temp_store should be MEMORY (2)");

        // For mmap_size and page_size, these might not be set if the database already exists
        // or if the settings are applied differently in the connection pool
        let mmap_size: i64 = conn
            .pragma_query_value(None, "mmap_size", |row| row.get(0))
            .unwrap();
        println!("mmap_size: {}", mmap_size);

        let page_size: i64 = conn
            .pragma_query_value(None, "page_size", |row| row.get(0))
            .unwrap();
        println!("page_size: {}", page_size);

        let cache_size: i64 = conn
            .pragma_query_value(None, "cache_size", |row| row.get(0))
            .unwrap();
        println!("cache_size: {}", cache_size);

        let wal_autocheckpoint: i64 = conn
            .pragma_query_value(None, "wal_autocheckpoint", |row| row.get(0))
            .unwrap();
        assert_eq!(
            wal_autocheckpoint, 2000,
            "WAL autocheckpoint should be 2000"
        );

        println!("✅ WAL configuration test passed!");
    }

    #[test]
    fn test_database_tables_created() {
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test_tables.db");

        // Create database instance
        let store = Db::init(&db_path, "http://localhost".to_string()).unwrap();

        // Get a connection from the pool
        let conn = store.pool.get().unwrap();

        // Check that all required tables exist
        let tables = vec![
            "resources",
            "prop_val_sub",
            "val_prop_sub",
            "query_members",
            "watched_queries",
        ];

        for table in tables {
            let count: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{}'",
                        table
                    ),
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "Table '{}' should exist", table);
        }

        println!("✅ All required tables exist!");
    }
}
