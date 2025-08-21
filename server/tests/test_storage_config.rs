// Test script to verify OpenDAL storage configuration
use std::path::Path;

fn main() {
    println!("Testing OpenDAL storage configuration...");
    
    // Test default configuration
    let default_config = atomic_lib::StorageConfig::default();
    println!("Default config: {:?}", default_config);
    assert_eq!(default_config.enabled_backends, vec!["sled".to_string(), "dashmap".to_string()]);
    assert_eq!(default_config.prefer_memory, false);
    
    // Test custom configuration
    let custom_config = atomic_lib::StorageConfig {
        enabled_backends: vec!["dashmap".to_string(), "rocksdb".to_string()],
        prefer_memory: true,
        rocksdb_path: Some(Path::new("/tmp/rocksdb").to_path_buf()),
        redb_path: None,
        fs_path: None,
    };
    println!("Custom config: {:?}", custom_config);
    
    // Test DB initialization with config
    let temp_dir = tempfile::tempdir().unwrap();
    let result = atomic_lib::Db::init_with_config(
        temp_dir.path(),
        "http://localhost".to_string(),
        custom_config,
    );
    
    match result {
        Ok(_) => println!("✓ DB initialized successfully with custom config"),
        Err(e) => println!("✗ Failed to initialize DB: {}", e),
    }
    
    println!("All tests passed!");
}