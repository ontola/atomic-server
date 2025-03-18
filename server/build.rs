use std::{
    fs::{self, Metadata},
    path::PathBuf,
    time::{Instant, SystemTime},
};

macro_rules! p {
    ($($tokens: tt)*) => {
        println!("cargo:warning={}", format!($($tokens)*))
    }
}

struct Dirs {
    js_dist_source: PathBuf,
    js_dist_tmp: PathBuf,
    src_browser: PathBuf,
    browser_root: PathBuf,
}

fn main() -> std::io::Result<()> {
    let start_total = Instant::now();
    // Uncomment this line if you want faster builds during development
    // return Ok(());

    const BROWSER_ROOT: &str = "../browser/";
    let dirs: Dirs = {
        Dirs {
            js_dist_source: PathBuf::from("../browser/data-browser/dist"),
            js_dist_tmp: PathBuf::from("./assets_tmp"),
            src_browser: PathBuf::from("../browser/data-browser/src"),
            browser_root: PathBuf::from(BROWSER_ROOT),
        }
    };
    println!("cargo:rerun-if-changed={}", BROWSER_ROOT);

    let start_should_build = Instant::now();
    let needs_build = should_build(&dirs);
    p!(
        "should_build() took: {:.3}s",
        start_should_build.elapsed().as_secs_f32()
    );

    if needs_build {
        let start_build_js = Instant::now();
        build_js(&dirs);
        p!(
            "build_js() took: {:.3}s",
            start_build_js.elapsed().as_secs_f32()
        );

        let start_copy = Instant::now();
        let _ = fs::remove_dir_all(&dirs.js_dist_tmp);
        dircpy::copy_dir(&dirs.js_dist_source, &dirs.js_dist_tmp)?;
        p!(
            "Copying assets took: {:.3}s",
            start_copy.elapsed().as_secs_f32()
        );
    } else if dirs.js_dist_tmp.exists() {
        p!("Found {}, skipping copy", dirs.js_dist_tmp.display());
    } else {
        p!(
            "Could not find {} , copying from {}",
            dirs.js_dist_tmp.display(),
            dirs.js_dist_source.display()
        );
        let start_copy = Instant::now();
        dircpy::copy_dir(&dirs.js_dist_source, &dirs.js_dist_tmp)?;
        p!(
            "Copying assets took: {:.3}s",
            start_copy.elapsed().as_secs_f32()
        );
    }

    // Makes the static files available for compilation
    let start_bundle = Instant::now();
    static_files::resource_dir(&dirs.js_dist_tmp)
        .build()
        .unwrap_or_else(|_e| {
            panic!(
                "failed to open data browser assets from {}",
                dirs.js_dist_tmp.display()
            )
        });
    p!(
        "Bundling static files took: {:.3}s",
        start_bundle.elapsed().as_secs_f32()
    );

    p!(
        "Total build.rs time: {:.3}s",
        start_total.elapsed().as_secs_f32()
    );

    Ok(())
}

fn should_build(dirs: &Dirs) -> bool {
    // If the ATOMICSERVER_SKIP_JS_BUILD environment variable is set, skip the JS build
    if let Ok(env_skip) = std::env::var("ATOMICSERVER_SKIP_JS_BUILD") {
        if env_skip == "true" {
            p!("ATOMICSERVER_SKIP_JS_BUILD is set, skipping JS build.");
            return false;
        }
    }

    if !dirs.browser_root.exists() {
        p!("Could not find browser folder, assuming this is a `cargo publish` run. Skipping JS build.");
        return false;
    }
    // Check if any JS files were modified since the last build
    // Compare against the actual dist output, not the temporary copy
    if let Ok(dist_index_html) =
        std::fs::metadata(format!("{}/index.html", dirs.js_dist_source.display()))
    {
        let has_changes = walkdir::WalkDir::new(&dirs.src_browser)
            .into_iter()
            .filter_entry(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|s| !s.starts_with(".DS_Store"))
                    .unwrap_or(false)
            })
            .any(|entry| is_older_than(&entry.unwrap(), &dist_index_html));

        if has_changes {
            return true;
        }

        p!("No changes in JS source files, skipping JS build.");
        false
    } else if dirs.src_browser.exists() {
        p!(
            "No JS dist folder found at {}, but did find source folder {}, building...",
            dirs.js_dist_tmp.display(),
            dirs.src_browser.display()
        );
        true
    } else {
        p!(
            "Could not find index.html in {}. Skipping JS build.",
            dirs.js_dist_tmp.display()
        );
        false
    }
}

/// Runs JS package manager to install packages and build the JS bundle
fn build_js(dirs: &Dirs) {
    let pkg_manager = "pnpm";

    p!("install js packages...");

    std::process::Command::new(pkg_manager)
        .current_dir(&dirs.browser_root)
        .args(["install"])
        .output()
        .unwrap_or_else(|_| {
            panic!(
                "Failed to install js packages. Make sure you have {} installed.",
                pkg_manager
            )
        });
    p!("build js assets...");
    let out = std::process::Command::new(pkg_manager)
        .current_dir(&dirs.browser_root)
        .args(["run", "build"])
        .output()
        .expect("Failed to build js bundle");
    // Check if out contains errors
    if out.status.success() {
        p!("js build successful");
    } else {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        panic!("js build failed:\nStdout:\n{}\nStderr:\n{}", stdout, stderr);
    }
}

fn is_older_than(dir_entry: &walkdir::DirEntry, dist_meta: &Metadata) -> bool {
    let dist_time = dist_meta
        .modified()
        .unwrap()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap();

    if dir_entry.path().is_file() {
        let src_time = dir_entry
            .metadata()
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap();
        if src_time >= dist_time {
            p!(
                "Source file modified: {:?}, rebuilding...",
                dir_entry.path()
            );
            return true;
        }
    }
    false
}
