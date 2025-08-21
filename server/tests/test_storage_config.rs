// Test script to verify OpenDAL storage configuration
use std::path::Path;

#[test]
fn test_storage_config_default() {
    // Test default configuration
    let default_config = atomic_lib::StorageConfig::default();
    assert_eq!(default_config.enabled_backends, vec!["sled".to_string(), "dashmap".to_string()]);
    assert_eq!(default_config.prefer_memory, false);
    assert!(default_config.rocksdb_path.is_none());
    assert!(default_config.redb_path.is_none());
    assert!(default_config.fs_path.is_none());
}

#[test]
fn test_storage_config_custom() {
    // Test custom configuration
    let custom_config = atomic_lib::StorageConfig {
        enabled_backends: vec!["dashmap".to_string(), "sled".to_string()],
        prefer_memory: true,
        rocksdb_path: Some(Path::new("/tmp/rocksdb").to_path_buf()),
        redb_path: Some(Path::new("/tmp/redb").to_path_buf()),
        fs_path: Some(Path::new("/tmp/fs").to_path_buf()),
    };
    
    assert_eq!(custom_config.enabled_backends, vec!["dashmap".to_string(), "sled".to_string()]);
    assert!(custom_config.prefer_memory);
    assert_eq!(custom_config.rocksdb_path, Some(Path::new("/tmp/rocksdb").to_path_buf()));
    assert_eq!(custom_config.redb_path, Some(Path::new("/tmp/redb").to_path_buf()));
    assert_eq!(custom_config.fs_path, Some(Path::new("/tmp/fs").to_path_buf()));
}

#[test]
fn test_db_init_with_custom_config() {
    // Test DB initialization with custom config
    let tmp_dir_path = ".temp/db/test_storage_config";
    let _try_remove_existing = std::fs::remove_dir_all(&tmp_dir_path);
    std::fs::create_dir_all(&tmp_dir_path).unwrap();
    
    let custom_config = atomic_lib::StorageConfig {
        enabled_backends: vec!["sled".to_string(), "dashmap".to_string()],
        prefer_memory: false,
        rocksdb_path: None,
        redb_path: None,
        fs_path: None,
    };
    
    let result = atomic_lib::Db::init_with_config(
        Path::new(&tmp_dir_path),
        "http://localhost".to_string(),
        custom_config,
    );
    
    assert!(result.is_ok(), "Failed to initialize DB with custom config: {:?}", result.err());
    
    // Clean up
    let _cleanup = std::fs::remove_dir_all(&tmp_dir_path);
}

#[test]
fn test_db_init_with_prefer_memory() {
    // Test DB initialization with prefer_memory option
    let tmp_dir_path = ".temp/db/test_storage_prefer_memory";
    let _try_remove_existing = std::fs::remove_dir_all(&tmp_dir_path);
    std::fs::create_dir_all(&tmp_dir_path).unwrap();
    
    let memory_config = atomic_lib::StorageConfig {
        enabled_backends: vec!["dashmap".to_string(), "sled".to_string()],
        prefer_memory: true,
        rocksdb_path: None,
        redb_path: None,
        fs_path: None,
    };
    
    let result = atomic_lib::Db::init_with_config(
        Path::new(&tmp_dir_path),
        "http://localhost".to_string(),
        memory_config,
    );
    
    assert!(result.is_ok(), "Failed to initialize DB with prefer_memory config: {:?}", result.err());
    
    // Clean up
    let _cleanup = std::fs::remove_dir_all(&tmp_dir_path);
}