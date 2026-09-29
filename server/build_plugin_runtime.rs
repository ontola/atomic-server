use std::path::PathBuf;

macro_rules! runtime_warning {
    ($($tokens: tt)*) => {
        println!("cargo:warning={}", format!($($tokens)*))
    }
}

/// The WASM component that runs plugin JavaScript, embedded into the binary so
/// a server is self-contained.
///
/// Built for `wasm32-wasip2`, which is a different target than the server
/// itself, so this only works where that target is installed. When it is not,
/// the build still succeeds and the runtime is absent — a server without
/// server-side plugins is a degraded server, not a broken build, and failing
/// here would block anyone who never touches plugins. The absence is reported
/// at the point someone tries to use it, not swallowed.
/// CI sets ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME=true to fail the build instead
/// of allowing this degradation in jobs that exercise server-side plugins.
pub fn build() {
    const TARGET: &str = "wasm32-wasip2";
    const CRATE: &str = "atomic-plugin-runtime";

    println!("cargo:rerun-if-changed=../plugin-runtime/src");
    println!("cargo:rerun-if-changed=../plugin-runtime/wit");
    println!("cargo:rerun-if-changed=../plugin-runtime/Cargo.toml");
    println!("cargo:rerun-if-env-changed=ATOMICSERVER_SKIP_PLUGIN_RUNTIME");
    println!("cargo:rerun-if-env-changed=ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME");
    let required = std::env::var("ATOMICSERVER_REQUIRE_PLUGIN_RUNTIME").is_ok_and(|v| v == "true");

    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo");
    let embedded = PathBuf::from(&out_dir).join("plugin_runtime.wasm");

    if std::env::var("ATOMICSERVER_SKIP_PLUGIN_RUNTIME").is_ok_and(|v| v == "true") {
        assert!(
            !required,
            "the plugin runtime cannot be both required and skipped"
        );
        runtime_warning!("ATOMICSERVER_SKIP_PLUGIN_RUNTIME is set, skipping the plugin runtime.");
        let _ = std::fs::write(&embedded, []);

        return;
    }

    let has_target = std::process::Command::new("rustc")
        .args(["--print", "target-list"])
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .any(|t| t == TARGET)
        })
        .unwrap_or(false);

    if !has_target {
        assert!(
            !required,
            "the required {TARGET} plugin runtime target is unavailable"
        );
        runtime_warning!(
            "{TARGET} is unknown to this toolchain; plugins will not run server-side."
        );
        let _ = std::fs::write(&embedded, []);

        return;
    }

    // Always release: a debug build of QuickJS is ~8MB against ~1.2MB, and this
    // is embedded in every server binary including debug ones.
    // A different target triple still shares target/release for host build
    // dependencies. The outer release build holds that Cargo lock while this
    // script runs, so the nested build needs a separate target directory too.
    let runtime_target = PathBuf::from(&out_dir).join("plugin-runtime-target");
    let built =
        std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args(["build", "-p", CRATE, "--release", "--target", TARGET])
            .arg("--target-dir")
            .arg(&runtime_target)
            // A configured build.build-dir can be shared even when target-dir
            // differs. Give this nested Cargo its own intermediate directory
            // so it cannot wait on the outer Cargo's artifact lock.
            .env("CARGO_BUILD_BUILD_DIR", runtime_target.join("build-cache"))
            // Host compiler flags and target selection do not apply to WASI.
            .env_remove("CARGO_ENCODED_RUSTFLAGS")
            .env_remove("RUSTFLAGS")
            .env_remove("CARGO_BUILD_TARGET")
            // rust-musl-cross exports TARGET_CC/AR for the native server.
            // cc-rs prefers these over the CC/AR selected by rquickjs's
            // WASI SDK, so leaking them compiles QuickJS with the Linux
            // toolchain instead of clang for WebAssembly.
            .env_remove("TARGET_CC")
            .env_remove("TARGET_CXX")
            .env_remove("TARGET_AR")
            .env_remove("TARGET_RANLIB")
            .env_remove("TARGET_CFLAGS")
            .env_remove("TARGET_CXXFLAGS")
            .current_dir("..")
            .status();

    let artifact = runtime_target
        .join(TARGET)
        .join("release/atomic_plugin_runtime.wasm");

    match built {
        Ok(status) if status.success() && artifact.exists() => {
            std::fs::copy(&artifact, &embedded).expect("could not embed the plugin runtime");
            runtime_warning!(
                "embedded the plugin runtime ({} KB)",
                std::fs::metadata(&embedded)
                    .map(|m| m.len() / 1024)
                    .unwrap_or(0),
            );
        }
        _ => {
            assert!(
                !required,
                "could not build the required {CRATE} for {TARGET}; see the nested cargo build error above"
            );
            runtime_warning!(
                "could not build {CRATE} for {TARGET}; plugins will not run server-side. \
                 Install the target with `rustup target add {TARGET}`.",
            );
            let _ = std::fs::write(&embedded, []);
        }
    }
}
