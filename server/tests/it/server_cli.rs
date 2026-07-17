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
    let unique_string = atomic_lib::utils::random_string(10);
    let data_dir = format!("./.temp/{}/db", unique_string);
    let config_dir = format!("./.temp/{}/config", unique_string);
    let cache_dir = format!("./.temp/{}/cache", unique_string);

    let mut cmd = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
    let mut d = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    d.push("../lib/test_files/local_id.json");
    cmd.args([
        "--data-dir",
        &data_dir,
        "--config-dir",
        &config_dir,
        "--cache-dir",
        &cache_dir,
        "import",
        "--file",
        d.to_str().unwrap(),
    ])
    .assert()
    .success();
}
