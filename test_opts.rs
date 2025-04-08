use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Clone, Debug)]
pub struct Opts {
    #[clap(subcommand)]
    pub command: Option<Command>,

    #[clap(long, env = "ATOMIC_DATA_DIR")]
    pub data_dir: Option<PathBuf>,
}

#[derive(Parser, Clone, Debug)]
pub enum Command {
    Export,
    Import,
}

fn main() {
    let opts = Opts::parse_from([
        "atomic-server",
        "--data-dir",
        "/data/dir",
    ]);
    println!("{:?}", opts);
}
