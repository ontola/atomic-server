//! Build a sample drive and export it as a git repository.
//!
//! ```sh
//! cargo run -p atomic_lib --features db-redb --example export_drive_git -- /tmp/atomic-drive-git
//! ```
use std::path::PathBuf;

use atomic_lib::git_export::{export_drive, write_sample_drive, ExportOptions};
use atomic_lib::{Db, Subject};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let dest = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| ".temp/atomic-drive-git".into()),
    );
    if dest.exists() {
        std::fs::remove_dir_all(&dest).expect("could not clear dest");
    }
    std::fs::create_dir_all(&dest).expect("could not create dest");

    let store = Db::init_temp("export_drive_git_example")
        .await
        .expect("init store");
    let drive = write_sample_drive(&store).await.expect("sample drive");
    let report = export_drive(
        &store,
        &Subject::from(drive.as_str()),
        &dest,
        &ExportOptions::default(),
    )
    .await
    .expect("export");

    println!(
        "Exported {} resources to {}",
        report.resources,
        dest.display()
    );
    println!("Files written: {}", report.files_written);
    if let Some(sha) = report.git_commit {
        println!("Git commit: {sha}");
    }
    println!("Drive DID: {drive}");
}
