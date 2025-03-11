#[cfg(test)]
mod test {
    use assert_cmd::Command;

    const TEST_URL: &str =
        "https://atomicdata.dev/agents/QmfpRIBn2JYEatT0MjSkMNoBJzstz19orwnT5oT2rcQ=";

    #[ignore]
    #[test]
    fn get_url() {
        let mut cmd = Command::cargo_bin(assert_cmd::crate_name!()).unwrap();
        cmd.args(["get", TEST_URL]).assert().success();
    }

    #[ignore]
    #[test]
    fn search() {
        let parent = "https://atomicdata.dev/ontology/core";
        let mut cmd = Command::cargo_bin(assert_cmd::crate_name!()).unwrap();
        cmd.args(["search", "a", "--parent", parent])
            .assert()
            .success();
    }

    #[ignore]
    #[test]
    fn set_and_get() {
        use std::time::SystemTime;
        let value: String = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string();
        let mut cmd_set = Command::cargo_bin(assert_cmd::crate_name!()).unwrap();
        cmd_set
            .args([
                "set",
                "https://atomicdata.dev/test",
                atomic_lib::urls::SHORTNAME,
                &value,
            ])
            .assert()
            .success();

        let mut cmd_get = Command::cargo_bin(assert_cmd::crate_name!()).unwrap();
        let result = cmd_get
            .args(["get", "https://atomicdata.dev/test shortname"])
            .assert()
            .success()
            .to_string();
        assert!(result.contains(&value));
    }
}
