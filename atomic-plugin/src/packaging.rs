// Only compile this module for non-wasm32 targets (host tools)
#[cfg(not(target_arch = "wasm32"))]
pub mod packaging_impl {
    use anyhow::{Context, Result};
    use clap::Parser;
    use serde::Deserialize;
    use std::fs::File;
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use walkdir::WalkDir;
    use zip::write::FileOptions;

    #[derive(Parser)]
    #[command(author, version, about, long_about = None)]
    pub struct Cli {
        /// Path to the WASM file. Defaults to target/wasm32-wasip2/release/*.wasm
        #[arg(long)]
        pub wasm: Option<PathBuf>,

        /// Path to the assets folder. Defaults to ./assets
        #[arg(long)]
        pub assets: Option<PathBuf>,

        /// Path to the plugin.json file. Defaults to ./plugin.json
        #[arg(long, default_value = "plugin.json")]
        pub descriptor: PathBuf,

        /// Path to the UI JS file. Defaults to ./ui/dist/ui.js
        #[arg(long)]
        pub ui_js: Option<PathBuf>,

        /// Path to the UI CSS file. Defaults to ./ui/dist/ui.css
        #[arg(long)]
        pub ui_css: Option<PathBuf>,

        /// Output path for the zip file. Defaults to [namespace].[name].zip in cwd
        #[arg(long)]
        pub out: Option<PathBuf>,
    }

    #[derive(Deserialize)]
    struct PluginDescriptor {
        namespace: String,
        name: String,
    }

    pub fn main() -> Result<()> {
        let cli = Cli::parse();
        package_plugin(cli)
    }

    pub fn package_plugin(cli: Cli) -> Result<()> {
        // Read descriptor
        let descriptor_content = std::fs::read_to_string(&cli.descriptor)
            .with_context(|| format!("Failed to read descriptor at {:?}", cli.descriptor))?;
        let descriptor: PluginDescriptor = serde_json::from_str(&descriptor_content)
            .context("Failed to parse plugin descriptor")?;

        let namespace = &descriptor.namespace;
        let name = &descriptor.name;

        // Determine paths
        let wasm_path = match cli.wasm {
            Some(p) => p,
            None => find_wasm_file()?,
        };

        let assets_path = cli.assets.unwrap_or_else(|| PathBuf::from("assets"));

        let ui_js_path = cli.ui_js.or_else(|| {
            let p = PathBuf::from("ui/dist/ui.js");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        });

        let ui_css_path = cli.ui_css.or_else(|| {
            let p = PathBuf::from("ui/dist/ui.css");
            if p.exists() {
                Some(p)
            } else {
                None
            }
        });

        let out_path = cli
            .out
            .unwrap_or_else(|| PathBuf::from(format!("dist/{}.zip", namespace)));

        println!("Packaging plugin: {}/{}", namespace, name);
        println!("  Wasm: {:?}", wasm_path);
        println!("  Assets: {:?}", assets_path);
        if let Some(ui_js) = &ui_js_path {
            println!("  UI JS: {:?}", ui_js);
        }
        if let Some(ui_css) = &ui_css_path {
            println!("  UI CSS: {:?}", ui_css);
        }
        println!("  Descriptor: {:?}", cli.descriptor);
        println!("  Output: {:?}", out_path);

        // Make sure the output directory exists
        std::fs::create_dir_all(out_path.parent().unwrap())?;

        // Create Zip
        let file = File::create(&out_path).context("Failed to create output file")?;
        let mut zip = zip::ZipWriter::new(file);
        let options = FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o755);

        // Add WASM
        zip.start_file("plugin.wasm", options)?;
        let mut wasm_file = File::open(&wasm_path).context("Failed to open WASM file")?;
        let mut buffer = Vec::new();
        wasm_file.read_to_end(&mut buffer)?;
        zip.write_all(&buffer)?;

        // Add Descriptor
        // Keep as plugin.json
        zip.start_file("plugin.json", options)?;
        zip.write_all(descriptor_content.as_bytes())?;

        // Add UI files
        if let Some(ui_js_path) = ui_js_path {
            zip.start_file("ui.js", options)?;
            let mut ui_js_file = File::open(&ui_js_path).context("Failed to open UI JS file")?;
            let mut buffer = Vec::new();
            ui_js_file.read_to_end(&mut buffer)?;
            zip.write_all(&buffer)?;
        }

        if let Some(ui_css_path) = ui_css_path {
            zip.start_file("ui.css", options)?;
            let mut ui_css_file = File::open(&ui_css_path).context("Failed to open UI CSS file")?;
            let mut buffer = Vec::new();
            ui_css_file.read_to_end(&mut buffer)?;
            zip.write_all(&buffer)?;
        }

        // Add Assets
        if assets_path.exists() {
            let walk = WalkDir::new(&assets_path);
            for entry in walk {
                let entry = entry?;
                let path = entry.path();
                if path.is_dir() {
                    continue;
                }

                let relative_path = path.strip_prefix(&assets_path)?;
                // Place inside assets/...
                let zip_path = Path::new("assets").join(relative_path);
                let zip_path_str = zip_path.to_string_lossy();

                zip.start_file(zip_path_str, options)?;
                let mut asset_file = File::open(path)?;
                let mut buffer = Vec::new();
                asset_file.read_to_end(&mut buffer)?;
                zip.write_all(&buffer)?;
            }
        } else {
            println!(
                "Warning: Assets directory {:?} not found, skipping.",
                assets_path
            );
        }

        zip.finish()?;
        println!("Done!");

        Ok(())
    }

    fn find_wasm_file() -> Result<PathBuf> {
        let target_dir = PathBuf::from("target/wasm32-wasip2/release");
        if !target_dir.exists() {
            anyhow::bail!(
                "Target directory {:?} does not exist. Please build the project first or specify --wasm",
                target_dir
            );
        }

        let mut wasm_files = Vec::new();
        let entries = std::fs::read_dir(&target_dir)
            .with_context(|| format!("Failed to read directory {:?}", target_dir))?;

        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if let Some(ext) = path.extension() {
                if ext == "wasm" {
                    wasm_files.push(path);
                }
            }
        }

        if wasm_files.is_empty() {
            anyhow::bail!("No WASM files found in {:?}.", target_dir);
        }

        if wasm_files.len() > 1 {
            println!(
                "Warning: Multiple WASM files found in {:?}. Using {:?}",
                target_dir, wasm_files[0]
            );
        }

        Ok(wasm_files[0].clone())
    }
}
