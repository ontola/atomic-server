#![cfg(all(unix, feature = "wasm-plugins"))]

use std::{
    fs,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

struct Workspace(PathBuf);

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn release_build_embeds_runtime_without_waiting_on_its_own_cargo_lock() {
    let workspace = Workspace(std::env::temp_dir().join(format!(
        "atomic-runtime-lock-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    )));
    let root = &workspace.0;
    fs::create_dir_all(root.join("server/src")).unwrap();
    fs::create_dir_all(root.join("plugin-runtime/src")).unwrap();
    fs::write(
        root.join("Cargo.toml"),
        "[workspace]\nmembers = [\"server\", \"plugin-runtime\"]\nresolver = \"2\"\n",
    )
    .unwrap();
    fs::write(
        root.join("server/Cargo.toml"),
        "[package]\nname = \"runtime-build-host\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    fs::write(root.join("server/src/lib.rs"), "").unwrap();
    fs::write(
        root.join("plugin-runtime/Cargo.toml"),
        "[package]\nname = \"atomic-plugin-runtime\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[lib]\ncrate-type = [\"cdylib\"]\n",
    )
    .unwrap();
    fs::write(root.join("plugin-runtime/src/lib.rs"), "").unwrap();
    let module = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("build_plugin_runtime.rs");
    fs::write(
        root.join("server/build.rs"),
        format!("#[path = {module:?}] mod runtime;\nfn main() {{ runtime::build(); }}\n"),
    )
    .unwrap();

    // Use the production build script with dependency-free fixture crates.
    // The outer release build holds the real host Cargo lock while the script
    // builds a real WASI component, reproducing the Docker release deadlock.
    let log_path = root.join("build.log");
    let log = fs::File::create(&log_path).unwrap();
    let mut child = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .args([
            "build",
            "--offline",
            "--release",
            "-p",
            "runtime-build-host",
        ])
        .current_dir(root.join("server"))
        .env("CARGO_TARGET_DIR", root.join("custom-target"))
        .env("ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME", "true")
        .env_remove("ATOMICSERVER_SKIP_PLUGIN_RUNTIME")
        .env_remove("CARGO_BUILD_TARGET")
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .env_remove("RUSTFLAGS")
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .process_group(0)
        .spawn()
        .unwrap();
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(30) {
            // Kill only this fixture's process group, including nested Cargo.
            let _ = Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", child.id())])
                .status();
            let _ = child.wait();
            panic!(
                "release build stalled:\n{}",
                fs::read_to_string(&log_path).unwrap()
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(
        status.success(),
        "{}",
        fs::read_to_string(&log_path).unwrap()
    );
    let embedded = fs::read_dir(root.join("custom-target/release/build"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("out/plugin_runtime.wasm"))
        .find(|path| path.exists())
        .expect("the host build must embed the runtime");
    assert!(fs::read(embedded).unwrap().starts_with(b"\0asm"));
}
