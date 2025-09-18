#[test]
fn wrong_command() {
    let mut cmd = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
    cmd.args(["non-existent-command"]).assert().failure();
}

#[test]
fn help() {
    let mut cmd = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
    cmd.args(["help"]).assert().success();
}

#[test]
fn import_file() {
    // Create a unique temporary directory for this test to avoid search index lock conflicts
    let test_id = std::process::id();
    let temp_cache_dir = format!(".temp/test_import_cache_{}", test_id);
    let temp_data_dir = format!(".temp/test_import_data_{}", test_id);
    
    // Clean up any existing directories
    let _ = std::fs::remove_dir_all(&temp_cache_dir);
    let _ = std::fs::remove_dir_all(&temp_data_dir);
    
    let mut cmd = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
    let mut d = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    d.push("../lib/test_files/local_id.json");
    
    cmd.args([
        "--cache-dir", &temp_cache_dir,
        "--data-dir", &temp_data_dir,
        "import", 
        "--file", d.to_str().unwrap(),
    ])
    .assert()
    .success();
    
    // Clean up test directories
    let _ = std::fs::remove_dir_all(&temp_cache_dir);
    let _ = std::fs::remove_dir_all(&temp_data_dir);
}

#[test]
fn export_data() {
    // Create a unique temporary directory for this test
    let test_id = std::process::id();
    let temp_cache_dir = format!(".temp/test_export_cache_{}", test_id);
    let temp_data_dir = format!(".temp/test_export_data_{}", test_id);
    let temp_export_file = format!(".temp/test_export_{}.json", test_id);
    
    // Clean up any existing directories and files
    let _ = std::fs::remove_dir_all(&temp_cache_dir);
    let _ = std::fs::remove_dir_all(&temp_data_dir);
    let _ = std::fs::remove_file(&temp_export_file);
    
    // First import some data to export
    let mut import_cmd = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
    let mut import_file_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    import_file_path.push("../lib/test_files/local_id.json");
    
    import_cmd.args([
        "--cache-dir", &temp_cache_dir,
        "--data-dir", &temp_data_dir,
        "import", 
        "--file", import_file_path.to_str().unwrap(),
    ])
    .assert()
    .success();
    
    // Now test export
    let mut export_cmd = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
    export_cmd.args([
        "--cache-dir", &temp_cache_dir,
        "--data-dir", &temp_data_dir,
        "export",
        "-p", &temp_export_file,
    ])
    .assert()
    .success();
    
    // Verify the export file was created and contains valid JSON
    assert!(std::path::Path::new(&temp_export_file).exists(), "Export file should be created");
    
    let exported_content = std::fs::read_to_string(&temp_export_file)
        .expect("Should be able to read exported file");
    
    // Basic validation - should be valid JSON and contain some expected structure
    let json_value: serde_json::Value = serde_json::from_str(&exported_content)
        .expect("Exported content should be valid JSON");
    
    // Should be an array of resources
    assert!(json_value.is_array(), "Export should be a JSON array");
    let resources = json_value.as_array().unwrap();
    assert!(!resources.is_empty(), "Export should contain at least some resources");
    
    // Clean up test directories and files
    let _ = std::fs::remove_dir_all(&temp_cache_dir);
    let _ = std::fs::remove_dir_all(&temp_data_dir);
    let _ = std::fs::remove_file(&temp_export_file);
}

#[test] 
fn export_concurrent_with_database_operations() {
    use std::thread;
    use std::time::Duration;
    
    // Create unique temporary directories for this test - separate cache dirs to avoid search index locks
    let test_id = std::process::id();
    let temp_cache_dir = format!(".temp/test_concurrent_cache_{}", test_id);
    let temp_data_dir = format!(".temp/test_concurrent_data_{}", test_id);
    let temp_cache_dir1 = format!(".temp/test_concurrent_cache1_{}", test_id);
    let temp_cache_dir2 = format!(".temp/test_concurrent_cache2_{}", test_id);
    let temp_export_file1 = format!(".temp/test_concurrent_export1_{}.json", test_id);
    let temp_export_file2 = format!(".temp/test_concurrent_export2_{}.json", test_id);
    
    // Clean up any existing directories and files
    let _ = std::fs::remove_dir_all(&temp_cache_dir);
    let _ = std::fs::remove_dir_all(&temp_data_dir);
    let _ = std::fs::remove_dir_all(&temp_cache_dir1);
    let _ = std::fs::remove_dir_all(&temp_cache_dir2);
    let _ = std::fs::remove_file(&temp_export_file1);
    let _ = std::fs::remove_file(&temp_export_file2);
    
    // First import some data to export
    let mut import_cmd = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
    let mut import_file_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    import_file_path.push("../lib/test_files/local_id.json");
    
    import_cmd.args([
        "--cache-dir", &temp_cache_dir,
        "--data-dir", &temp_data_dir,
        "import", 
        "--file", import_file_path.to_str().unwrap(),
    ])
    .assert()
    .success();
    
    // Create two export commands that will run concurrently with separate cache dirs but same data dir
    let temp_cache_dir1_clone = temp_cache_dir1.clone();
    let temp_cache_dir2_clone = temp_cache_dir2.clone();
    let temp_data_dir1 = temp_data_dir.clone();
    let temp_data_dir2 = temp_data_dir.clone();
    let export_file1 = temp_export_file1.clone();
    let export_file2 = temp_export_file2.clone();
    
    // Run two exports concurrently to test SQLite WAL mode concurrent read access
    let handle1 = thread::spawn(move || {
        let mut export_cmd1 = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
        export_cmd1.args([
            "--cache-dir", &temp_cache_dir1_clone,
            "--data-dir", &temp_data_dir1,
            "export",
            "-p", &export_file1,
        ])
        .assert()
        .success();
    });
    
    let handle2 = thread::spawn(move || {
        // Add a small delay to ensure concurrent execution
        thread::sleep(Duration::from_millis(10));
        let mut export_cmd2 = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
        export_cmd2.args([
            "--cache-dir", &temp_cache_dir2_clone,
            "--data-dir", &temp_data_dir2,
            "export",
            "-p", &export_file2,
        ])
        .assert()
        .success();
    });
    
    // Wait for both exports to complete
    handle1.join().expect("First export thread should complete successfully");
    handle2.join().expect("Second export thread should complete successfully");
    
    // Verify both export files were created
    assert!(std::path::Path::new(&temp_export_file1).exists(), "First export file should be created");
    assert!(std::path::Path::new(&temp_export_file2).exists(), "Second export file should be created");
    
    // Verify both files contain valid JSON with the same content (since they're from the same database)
    let content1 = std::fs::read_to_string(&temp_export_file1)
        .expect("Should be able to read first exported file");
    let content2 = std::fs::read_to_string(&temp_export_file2)
        .expect("Should be able to read second exported file");
    
    let json1: serde_json::Value = serde_json::from_str(&content1)
        .expect("First export should be valid JSON");
    let json2: serde_json::Value = serde_json::from_str(&content2)
        .expect("Second export should be valid JSON");
    
    assert_eq!(json1, json2, "Both concurrent exports should produce identical results");
    
    // Clean up test directories and files
    let _ = std::fs::remove_dir_all(&temp_cache_dir);
    let _ = std::fs::remove_dir_all(&temp_cache_dir1);
    let _ = std::fs::remove_dir_all(&temp_cache_dir2);
    let _ = std::fs::remove_dir_all(&temp_data_dir);
    let _ = std::fs::remove_file(&temp_export_file1);
    let _ = std::fs::remove_file(&temp_export_file2);
}
