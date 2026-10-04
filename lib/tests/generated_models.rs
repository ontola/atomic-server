include!("fixtures/generated/model.rs");
#[test]
fn generated_rust_distinguishes_missing_null_and_typed_union() {
    use atomic_lib::schema::model::Optional;
    use serde_json::json;
    let missing: ExampleModel =
        serde_json::from_value(json!({"name":"Bass","mode":"mono","value":{"base":0.5}})).unwrap();
    assert!(matches!(missing.field_comment, Optional::Missing));
    assert!(matches!(missing.field_value, SchemaType1::Value1(_)));
    let null: ExampleModel =
        serde_json::from_value(json!({"name":"Bass","mode":"mono","value":1,"comment":null}))
            .unwrap();
    assert!(matches!(null.field_comment, Optional::Present(None)));
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
