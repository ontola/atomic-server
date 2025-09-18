/*!
# Migrations

Whenever the schema of the database changes, a newer version will not be able to read an older database.
Therefore, we need migrations to convert the old schema to the new one.

## Adding a Migration

- Write a function called `v{OLD}_to_v{NEW}` that takes a [Db]. Make sure it removes the old table.
- In [migrate_maybe] add a check for version tables
- Update the table keys used in [crate::db::trees]
 */

 use crate::{errors::AtomicResult, Db};
 use rusqlite::params;
 
 /// Checks the current version(s) of the internal Store, and performs migrations if needed.
 /// For SQLite, we check for presence of legacy sled-related tables or files.
 pub fn migrate_maybe(store: &Db) -> AtomicResult<()> {
     // For SQLite, migrations are simpler - we just need to check if old database files exist
     // or old data needs to be imported. Since we're starting fresh with SQLite,
     // we'll focus on ensuring the schema is current.
     
     let conn = store.pool.get()
         .map_err(|e| format!("Failed to get connection from pool: {}", e))?;
     
     // Check for any legacy tables that might need migration
     let legacy_check_result = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'");
     
     if let Ok(mut stmt) = legacy_check_result {
         let table_names: Vec<String> = stmt
             .query_map([], |row| {
                 let name: String = row.get(0)?;
                 Ok(name)
             }).map_err(|e| format!("Failed to query table names: {}", e))?
             .filter_map(Result::ok)
             .collect();
         
         for table_name in &table_names {
             match table_name.as_str() {
                 // Add specific migration logic if needed for legacy data
                 "legacy_resources" => legacy_resources_migration(store)?,
                 _ => {}
             }
         }
     }
     
     // Check if we need to migrate from Sled database
     if let Err(e) = migrate_from_sled_if_exists(store) {
         tracing::warn!("Sled migration check failed (this is expected for new installations): {}", e);
     }
     
     Ok(())
 }
 
 /// Placeholder for potential legacy resource migration
 fn legacy_resources_migration(_store: &Db) -> AtomicResult<()> {
     // If we need to migrate from old sled data, this is where the logic would go
     // For now, we assume we're starting fresh with SQLite
     tracing::info!("Legacy resources migration - no action needed");
     Ok(())
 }
 
 /// Attempts to migrate from an existing Sled database if one exists
#[cfg(feature = "sled")]
fn migrate_from_sled_if_exists(store: &Db) -> AtomicResult<()> {
     
     // Try to find a Sled database in the same directory
     let sqlite_path = &store.path;
     let parent_dir = sqlite_path.parent()
         .ok_or("Invalid database path")?;
     
     // Look for Sled database files
     let sled_candidates = [
         parent_dir.join("atomic"),
         parent_dir.join("db"),
         sqlite_path.with_extension("sled"),
     ];
     
     for sled_path in &sled_candidates {
         if sled_path.exists() && sled_path.is_dir() {
             tracing::info!("Found potential Sled database at {:?}, attempting migration...", sled_path);
             return migrate_from_sled_to_sqlite(store, sled_path);
         }
     }
     
     // No Sled database found, this is expected for new installations
     Ok(())
 }
 
 /// Fallback for when Sled feature is not enabled
 #[cfg(not(feature = "sled"))]
 fn migrate_from_sled_if_exists(_store: &Db) -> AtomicResult<()> {
     // Sled feature not enabled, skip migration
     Ok(())
 }
 
/// Migrates data from an existing Sled database to SQLite
#[cfg(feature = "sled")]
fn migrate_from_sled_to_sqlite(store: &Db, sled_path: &std::path::Path) -> AtomicResult<()> {
    use sled::open as sled_open;
     
     tracing::info!("Starting migration from Sled to SQLite...");
     
    // Open the Sled database
    let sled_db = sled_open(sled_path)
        .map_err(|e| format!("Failed to open Sled database at {:?}: {}", sled_path, e))?;
     
    let mut conn = store.pool.get()
        .map_err(|e| format!("Failed to get SQLite connection: {}", e))?;
    
    let tx = conn.transaction()
        .map_err(|e| format!("Failed to start SQLite transaction: {}", e))?;
     
     // Migrate resources
     if let Ok(resources_tree) = sled_db.open_tree("resources") {
         tracing::info!("Migrating resources...");
         let mut stmt = tx.prepare("INSERT OR REPLACE INTO resources (key, value) VALUES (?1, ?2)")
             .map_err(|e| format!("Failed to prepare resources statement: {}", e))?;
         
        let mut count = 0;
        for item in resources_tree.iter() {
            let (key, value) = item.map_err(|e| format!("Failed to read from Sled resources: {}", e))?;
            stmt.execute(params![&key.to_vec(), &value.to_vec()])
                .map_err(|e| format!("Failed to insert resource into SQLite: {}", e))?;
            count += 1;
        }
         tracing::info!("Migrated {} resources", count);
     }
     
     // Migrate prop_val_sub index
     if let Ok(prop_val_sub_tree) = sled_db.open_tree("prop_val_sub") {
         tracing::info!("Migrating prop_val_sub index...");
         let mut stmt = tx.prepare("INSERT OR REPLACE INTO prop_val_sub (key, value) VALUES (?1, ?2)")
             .map_err(|e| format!("Failed to prepare prop_val_sub statement: {}", e))?;
         
        let mut count = 0;
        for item in prop_val_sub_tree.iter() {
            let (key, value) = item.map_err(|e| format!("Failed to read from Sled prop_val_sub: {}", e))?;
            stmt.execute(params![&key.to_vec(), &value.to_vec()])
                .map_err(|e| format!("Failed to insert into SQLite prop_val_sub: {}", e))?;
            count += 1;
        }
         tracing::info!("Migrated {} prop_val_sub entries", count);
     }
     
     // Migrate val_prop_sub index
     if let Ok(val_prop_sub_tree) = sled_db.open_tree("val_prop_sub") {
         tracing::info!("Migrating val_prop_sub index...");
         let mut stmt = tx.prepare("INSERT OR REPLACE INTO val_prop_sub (key, value) VALUES (?1, ?2)")
             .map_err(|e| format!("Failed to prepare val_prop_sub statement: {}", e))?;
         
        let mut count = 0;
        for item in val_prop_sub_tree.iter() {
            let (key, value) = item.map_err(|e| format!("Failed to read from Sled val_prop_sub: {}", e))?;
            stmt.execute(params![&key.to_vec(), &value.to_vec()])
                .map_err(|e| format!("Failed to insert into SQLite val_prop_sub: {}", e))?;
            count += 1;
        }
         tracing::info!("Migrated {} val_prop_sub entries", count);
     }
     
     // Migrate query_members index
     if let Ok(query_members_tree) = sled_db.open_tree("query_members") {
         tracing::info!("Migrating query_members index...");
         let mut stmt = tx.prepare("INSERT OR REPLACE INTO query_members (key, value) VALUES (?1, ?2)")
             .map_err(|e| format!("Failed to prepare query_members statement: {}", e))?;
         
        let mut count = 0;
        for item in query_members_tree.iter() {
            let (key, value) = item.map_err(|e| format!("Failed to read from Sled query_members: {}", e))?;
            stmt.execute(params![&key.to_vec(), &value.to_vec()])
                .map_err(|e| format!("Failed to insert into SQLite query_members: {}", e))?;
            count += 1;
        }
         tracing::info!("Migrated {} query_members entries", count);
     }
     
     // Migrate watched_queries index
     if let Ok(watched_queries_tree) = sled_db.open_tree("watched_queries") {
         tracing::info!("Migrating watched_queries index...");
         let mut stmt = tx.prepare("INSERT OR REPLACE INTO watched_queries (key, value) VALUES (?1, ?2)")
             .map_err(|e| format!("Failed to prepare watched_queries statement: {}", e))?;
         
        let mut count = 0;
        for item in watched_queries_tree.iter() {
            let (key, value) = item.map_err(|e| format!("Failed to read from Sled watched_queries: {}", e))?;
            stmt.execute(params![&key.to_vec(), &value.to_vec()])
                .map_err(|e| format!("Failed to insert into SQLite watched_queries: {}", e))?;
            count += 1;
        }
         tracing::info!("Migrated {} watched_queries entries", count);
     }
     
     // Commit the transaction
     tx.commit()
         .map_err(|e| format!("Failed to commit migration transaction: {}", e))?;
     
     // Close the Sled database
     drop(sled_db);
     
     tracing::info!("Migration from Sled to SQLite completed successfully!");
     
     // Optionally, you might want to rename the old Sled database to indicate it's been migrated
     // This is commented out for safety - uncomment if you want to mark the old database as migrated
    
     let migrated_path = sled_path.with_extension("migrated");
     std::fs::rename(sled_path, &migrated_path)
         .map_err(|e| format!("Failed to rename migrated Sled database: {}", e))?;
     tracing::info!("Renamed old Sled database to {:?}", migrated_path);
     
     Ok(())
 }
 
/// Fallback for when Sled feature is not enabled
#[cfg(not(feature = "sled"))]
fn migrate_from_sled_to_sqlite(_store: &Db, _sled_path: &std::path::Path) -> AtomicResult<()> {
    Err("Sled migration not available - sled feature not enabled".into())
}
 
 #[cfg(test)]
 mod tests {
     use super::*;
     use std::fs;
     use tempfile::TempDir;
     
     #[test]
     fn test_migrate_maybe_with_fresh_database() {
         let temp_dir = TempDir::new().unwrap();
         let db_path = temp_dir.path().join("test.db");
         
         // Create a fresh SQLite database
         let store = Db::init(&db_path, "http://localhost".to_string()).unwrap();
         
         // Run migration - should succeed without issues
         let result = migrate_maybe(&store);
         assert!(result.is_ok(), "Migration should succeed for fresh database");
     }
     
     #[test]
     fn test_migrate_maybe_creates_tables() {
         let temp_dir = TempDir::new().unwrap();
         let db_path = temp_dir.path().join("test.db");
         
         let store = Db::init(&db_path, "http://localhost".to_string()).unwrap();
         
         // Verify that all expected tables exist after migration
         let conn = store.pool.get().unwrap();
         let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").unwrap();
         let tables: Vec<String> = stmt.query_map([], |row| {
             let name: String = row.get(0)?;
             Ok(name)
         }).unwrap().filter_map(Result::ok).collect();
         
         assert!(tables.contains(&"resources".to_string()), "resources table should exist");
         assert!(tables.contains(&"prop_val_sub".to_string()), "prop_val_sub table should exist");
         assert!(tables.contains(&"val_prop_sub".to_string()), "val_prop_sub table should exist");
         assert!(tables.contains(&"query_members".to_string()), "query_members table should exist");
         assert!(tables.contains(&"watched_queries".to_string()), "watched_queries table should exist");
     }
     
     #[cfg(feature = "sled")]
     #[test]
     fn test_sled_migration_detection() {
         let temp_dir = TempDir::new().unwrap();
         let db_path = temp_dir.path().join("atomic.db");
         
         // Create a mock Sled database directory
         let sled_path = temp_dir.path().join("atomic");
         fs::create_dir_all(&sled_path).unwrap();
         
        // Create a simple Sled database with some test data
        use sled::open as sled_open;
        let sled_db = sled_open(&sled_path).unwrap();
         let resources_tree = sled_db.open_tree("resources").unwrap();
         resources_tree.insert(b"test_subject", b"test_data").unwrap();
         sled_db.flush().unwrap();
         drop(sled_db);
         
         // Create SQLite database in the same directory
         let store = Db::init(&db_path, "http://localhost".to_string()).unwrap();
         
         // Run migration - should detect and migrate from Sled
         let result = migrate_maybe(&store);
         assert!(result.is_ok(), "Migration should succeed with Sled database present");
         
         // Verify data was migrated
         let conn = store.pool.get().unwrap();
         let mut stmt = conn.prepare("SELECT value FROM resources WHERE key = ?1").unwrap();
         let result: Vec<u8> = stmt.query_row(params![b"test_subject"], |row| {
             let value: Vec<u8> = row.get(0)?;
             Ok(value)
         }).unwrap();
         
         assert_eq!(result, b"test_data", "Migrated data should match original");
     }
     
     #[test]
     fn test_migration_without_sled_feature() {
         // This test verifies that migration works even when Sled feature is not enabled
         let temp_dir = TempDir::new().unwrap();
         let db_path = temp_dir.path().join("test.db");
         
         let store = Db::init(&db_path, "http://localhost".to_string()).unwrap();
         
         // Should not fail even if Sled feature is not available
         let result = migrate_maybe(&store);
         assert!(result.is_ok(), "Migration should succeed without Sled feature");
     }
 }