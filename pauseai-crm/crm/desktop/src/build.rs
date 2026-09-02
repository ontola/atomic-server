use std::path::Path;

fn main() {
  ensure_frontend_dist();
  tauri_build::build()
}

/// `tauri::generate_context!()` requires `build.frontendDist` to exist at compile
/// time. Production/desktop builds populate it via `beforeBuildCommand`
/// (`pnpm -C browser/data-browser build:tauri`). Workspace `cargo test` /
/// `cargo nextest run` compile this crate without that step, so we create a
/// minimal stub when the directory is missing.
fn ensure_frontend_dist() {
  let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
  let frontend_dist = manifest_dir.join("../browser/data-browser/dist-tauri");

  if frontend_dist.exists() {
    return;
  }

  println!(
    "cargo:warning=Creating stub {} for compile-only build; run `pnpm -C browser/data-browser build:tauri` before packaging the desktop app",
    frontend_dist.display()
  );

  std::fs::create_dir_all(&frontend_dist).expect("create dist-tauri stub directory");
  std::fs::write(
    frontend_dist.join("index.html"),
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body></body></html>",
  )
  .expect("write dist-tauri stub index.html");
}
