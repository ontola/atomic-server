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

/// `atomic-server show-config` with the given env, in a throwaway data dir:
/// builds the config (where the plugin-routes gates are checked) and exits.
fn show_config_with_env(env: &[(&str, &str)]) -> std::process::Output {
    let unique_string = atomic_lib::utils::random_string(10);
    let mut cmd = assert_cmd::Command::cargo_bin("atomic-server").unwrap();
    cmd.args([
        "--data-dir",
        &format!("./.temp/{unique_string}/db"),
        "--config-dir",
        &format!("./.temp/{unique_string}/config"),
        "--cache-dir",
        &format!("./.temp/{unique_string}/cache"),
        "show-config",
    ]);
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.output().unwrap()
}

#[cfg(not(feature = "plugin-routes"))]
#[test]
fn plugin_routes_env_var_without_the_feature_refuses_to_start() {
    let output = show_config_with_env(&[("ATOMIC_PLUGIN_ROUTES", "read-only")]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "{stderr}");
    assert!(
        stderr.contains("built without the `plugin-routes` feature")
            && stderr.contains("--features plugin-routes"),
        "{stderr}"
    );
    assert!(show_config_with_env(&[("ATOMIC_PLUGIN_ROUTES", "off")])
        .status
        .success());
}

#[cfg(feature = "plugin-routes")]
#[test]
fn plugin_routes_env_vars_with_the_feature() {
    let output = show_config_with_env(&[("ATOMIC_PLUGIN_ROUTES", "read-only")]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "{stdout}");
    assert!(stdout.contains("level: ReadOnly"), "{stdout}");

    let output = show_config_with_env(&[
        ("ATOMIC_PLUGIN_ROUTES", "read-only"),
        ("ATOMIC_PLUGIN_LISTENERS", "x:4455"),
    ]);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "{stderr}");
    assert!(stderr.contains("ATOMIC_PLUGIN_LISTENERS"), "{stderr}");
}
