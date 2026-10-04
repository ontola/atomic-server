//! cargo run -p atomic_lib --example schema_codegen -- bundle.json Model output-dir
use atomic_lib::schema::app::AppSchema;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 4 {
        return Err("Usage: schema_codegen bundle.json Model output-dir".into());
    }
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let schema: AppSchema = if let Some(input) = json.get("input") {
        AppSchema::define(
            input["name"].as_str().ok_or("Missing name")?,
            serde_json::from_value(input["fields"].clone())?,
        )?
    } else {
        serde_json::from_value(json)?
    };
    let models = schema.generate_models(&args[2])?;
    std::fs::create_dir_all(&args[3])?;
    let out = std::path::Path::new(&args[3]);
    std::fs::write(out.join("model.rs"), models.rust)?;
    std::fs::write(out.join("model.dart"), models.dart)?;
    std::fs::write(out.join("bundle.json"), serde_json::to_vec_pretty(&schema)?)?;
    Ok(())
}
