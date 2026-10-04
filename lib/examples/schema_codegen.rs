//! cargo run -p atomic_lib --example schema_codegen -- bundle.json Model output-dir
use atomic_lib::schema::app::AppSchema;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if !(4..=5).contains(&args.len()) {
        return Err(
            "Usage: schema_codegen input.json Model output-dir [semantic-name-for-json-schema]"
                .into(),
        );
    }
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let schema: AppSchema = if let Some(input) = json.get("input") {
        AppSchema::define(
            input["name"].as_str().ok_or("Missing name")?,
            serde_json::from_value(input["fields"].clone())?,
        )?
    } else if json.get("atomic").is_some() {
        serde_json::from_value::<atomic_lib::schema::json_schema::JsonSchemaDocument>(json)?
            .import()?
    } else if args.len() == 5 {
        AppSchema::from_json_schema(&args[4], &json)?
    } else {
        serde_json::from_value(json)?
    };
    let models = schema.generate_models(&args[2])?;
    std::fs::create_dir_all(&args[3])?;
    let out = std::path::Path::new(&args[3]);
    std::fs::write(out.join("model.rs"), models.rust)?;
    std::fs::write(out.join("model.dart"), models.dart)?;
    std::fs::write(out.join("bundle.json"), serde_json::to_vec_pretty(&schema)?)?;
    std::fs::write(
        out.join("schema.json"),
        serde_json::to_vec_pretty(&schema.to_json_schema()?)?,
    )?;
    std::fs::write(
        out.join("schema-document.json"),
        serde_json::to_vec_pretty(&schema.export_json_schema()?)?,
    )?;
    Ok(())
}
