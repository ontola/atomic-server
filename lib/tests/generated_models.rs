include!("fixtures/generated/model.rs");
#[test]
fn generated_rust_distinguishes_missing_null_and_typed_union() {
    use atomic_lib::schema::model::Optional;
    use serde_json::json;
    let missing: ExampleModel =
        serde_json::from_value(json!({"name":"Bass","mode":"mono","value":{"base":0.5}})).unwrap();
    assert!(matches!(missing.comment, Optional::Missing));
    assert!(matches!(missing.value, SchemaType1::Value1(_)));
    let null: ExampleModel =
        serde_json::from_value(json!({"name":"Bass","mode":"mono","value":1,"comment":null}))
            .unwrap();
    assert!(matches!(null.comment, Optional::Present(None)));
    assert!(serde_json::to_value(missing)
        .unwrap()
        .get("comment")
        .is_none());
    assert!(serde_json::to_value(null)
        .unwrap()
        .get("comment")
        .unwrap()
        .is_null());
}

#[test]
fn generated_json_schema_retains_frozen_identity() {
    let bundle: atomic_lib::schema::app::AppSchema =
        serde_json::from_str(include_str!("fixtures/generated/bundle.json")).unwrap();
    let document: atomic_lib::schema::json_schema::JsonSchemaDocument =
        serde_json::from_str(include_str!("fixtures/generated/schema-document.json")).unwrap();
    assert_eq!(
        serde_json::to_value(bundle.export_json_schema().unwrap()).unwrap(),
        serde_json::to_value(&document).unwrap()
    );
    assert_eq!(
        serde_json::to_value(document.import().unwrap()).unwrap(),
        serde_json::to_value(bundle).unwrap()
    );
}

#[test]
fn generated_accessors_use_language_conventions_without_changing_json_keys() {
    use atomic_lib::schema::model::Optional;
    let value: ExampleModel = serde_json::from_value(serde_json::json!({"name":"Bass","mode":"mono","value":1,"midiKey":60,"type":true,"toJson":"label"})).unwrap();
    assert!(matches!(value.midi_key, Optional::Present(60)));
    assert!(matches!(value.r#type, Optional::Present(true)));
    assert!(matches!(value.to_json, Optional::Present(_)));
    assert_eq!(serde_json::to_value(value).unwrap()["midiKey"], 60);
}
