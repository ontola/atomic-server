//! cargo run -p atomic_lib --features db-redb --example app_schema
//! Emits a portable schema bundle and a native snapshot for the browser example.
use atomic_lib::{
    schema::app::{AppSchema, Field},
    Db,
};
use serde_json::{json, Value};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let input: Value =
        serde_json::from_str(include_str!("../tests/fixtures/app-schema-input.json"))?;
    let fields = serde_json::from_value::<std::collections::BTreeMap<String, Field>>(
        input["fields"].clone(),
    )?;
    let schema = AppSchema::define(input["name"].as_str().unwrap(), fields)?;
    let store = Db::init_temp("app-schema-example").await?;
    schema.register(&store).await?;
    let mut slice = schema.new_resource("atomic:example".into())?;
    schema.set(&mut slice, "tune", json!(7), &store).await?;
    schema
        .set(
            &mut slice,
            "envelope",
            json!({"attack":0.01,"release":0.2}),
            &store,
        )
        .await?;
    let base = slice.build_state_doc()?.export_snapshot();
    schema
        .patch(
            &mut slice,
            "envelope",
            &["attack"],
            Some(json!(0.05)),
            &store,
        )
        .await?;
    let edited = slice.build_state_doc()?.export_snapshot();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({"input":input,"bundle":schema,
        "rust_base": atomic_lib::agents::encode_base64(&base),
        "rust_edit": atomic_lib::agents::encode_base64(&edited)}))?
    );
    Ok(())
}
