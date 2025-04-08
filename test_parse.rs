use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Clone, Debug)]
pub struct Opts {
    #[clap(long, env = "ATOMIC_DATA_DIR")]
    pub data_dir: Option<PathBuf>,
    #[clap(long, env = "ATOMIC_CONFIG_DIR")]
    pub config_dir: Option<PathBuf>,
    #[clap(long, env = "ATOMIC_CACHE_DIR")]
    pub cache_dir: Option<PathBuf>,
}

fn main() {
    let opts = Opts::parse_from([
        "atomic-server",
        "--data-dir",
        "/data/dir",
        "--config-dir",
        "/config/dir",
        "--cache-dir",
        "/cache/dir",
    ]);
    println!("{:?}", opts);
}
