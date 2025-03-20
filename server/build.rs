use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant, SystemTime},
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
    // Find the newest file in the dist directory to compare against
    let dist_time = find_newest_file_time(&dirs.js_dist_source);

    if let Some(dist_time) = dist_time {
        let has_changes = walkdir::WalkDir::new(&dirs.src_browser)
            .into_iter()
            .filter_entry(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|s| !s.starts_with(".DS_Store"))
                    .unwrap_or(false)
            })
            .any(|entry| {
                if let Ok(entry) = entry {
                    is_newer_than_dist(&entry, dist_time)
                } else {
                    false
                }
            });

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

/// Finds the modification time of the newest file in the dist directory
fn find_newest_file_time(dist_dir: &PathBuf) -> Option<Duration> {
    let mut newest_time: Option<Duration> = None;

    if let Ok(entries) = walkdir::WalkDir::new(dist_dir)
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
    {
        for entry in entries {
            if entry.path().is_file() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(time) = modified.duration_since(SystemTime::UNIX_EPOCH) {
                            newest_time = Some(newest_time.map_or(time, |t| t.max(time)));
                        }
                    }
                }
            }
        }
    }

    newest_time
}

/// Checks if a source file is newer than the dist build time
/// Returns true if the source file is significantly newer (more than 2 seconds)
/// This accounts for filesystem timestamp precision issues
fn is_newer_than_dist(dir_entry: &walkdir::DirEntry, dist_time: Duration) -> bool {
    if !dir_entry.path().is_file() {
        return false;
    }

    let src_modified = match dir_entry.metadata() {
        Ok(meta) => meta.modified().ok(),
        Err(_) => return false,
    };

    let src_modified_time = match src_modified {
        Some(time) => time,
        None => return false,
    };

    // Check if source timestamp is in the future relative to current time
    // This handles files with incorrect future timestamps (like Dec 31 2026)
    let now = SystemTime::now();
    match src_modified_time.duration_since(now) {
        Ok(future_duration) => {
            // Source file is in the future - if more than 1 hour, ignore it
            if future_duration > Duration::from_secs(3600) {
                p!(
                    "Source file {:?} has future timestamp ({}s ahead), ignoring...",
                    dir_entry.path(),
                    future_duration.as_secs()
                );
                return false;
            }
        }
        Err(_) => {
            // Source file is in the past or present, which is normal
        }
    }

    // Convert source time to duration since epoch for comparison
    let src_time = match src_modified_time.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(time) => time,
        Err(_) => return false, // Source file has invalid timestamp (before epoch)
    };

    // Add a 2-second tolerance to account for filesystem timestamp precision issues
    // Only rebuild if source is significantly newer (more than 2 seconds)
    let tolerance = Duration::from_secs(2);
    if src_time > dist_time + tolerance {
        p!(
            "Source file modified: {:?}, rebuilding...",
            dir_entry.path()
        );
        return true;
    }

    false
}
