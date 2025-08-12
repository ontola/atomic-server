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
    let mut cmd = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
    // Ensure a clean, isolated search index to avoid schema mismatch between runs
    cmd.env("ATOMIC_REBUILD_INDEX", "true");
    let mut d = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    d.push("../lib/test_files/local_id.json");
    cmd.args(["import", "--file", d.to_str().unwrap()])
        .assert()
        .success();
}
