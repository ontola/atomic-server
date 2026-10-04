use super::{
    app::{AppSchema, Field},
    frozen,
    shape::Shape,
};
use crate::{Db, Resource, Storelike, Value};
use serde_json::json;

fn audio() -> AppSchema {
    AppSchema::define(
        "audio-slice",
        [
            (
                "tune".into(),
                Field {
                    required: true,
                    shape: Shape::Number {
                        minimum: Some(-48.),
                        maximum: Some(48.),
                    },
                },
            ),
            (
                "envelope".into(),
                Field {
                    required: true,
                    shape: serde_json::from_value(json!({
                        "type":"object", "properties": {
                            "attack":{"type":"number","minimum":0,"maximum":2},
                            "release":{"type":"number","minimum":0,"maximum":4}
                        }, "required":["attack","release"], "additionalProperties": false
                    }))
                    .unwrap(),
                },
            ),
        ]
        .into(),
    )
    .unwrap()
}

#[tokio::test]
async fn registered_schema_validates_nested_data_and_rejects_mutation() {
    let store = Db::init_temp("schema-registered").await.unwrap();
    let schema = audio();
    schema.register(&store).await.unwrap();
    schema.register(&store).await.unwrap();
    assert!(schema.class_id.starts_with("atomic:frozen:"));
    let property = schema.property("envelope").unwrap();
    assert!(store.get_property(property).await.is_ok());
    let mut resource = schema.new_resource("atomic:example".into()).unwrap();
    assert!(resource.check_required_props(&store).await.is_err());
    schema
        .set(&mut resource, "tune", json!(7), &store)
        .await
        .unwrap();
    schema
        .set(
            &mut resource,
            "envelope",
            json!({"attack":0.01,"release":0.2}),
            &store,
        )
        .await
        .unwrap();
    resource.check_required_props(&store).await.unwrap();
    assert!(schema
        .patch(
            &mut resource,
            "envelope",
            &["attack"],
            Some(json!(5)),
            &store
        )
        .await
        .is_err());
    assert_eq!(
        resource.get(property).unwrap().to_string(),
        json!({"attack":0.01,"release":0.2}).to_string()
    );
    assert!(schema
        .patch(&mut resource, "envelope", &["attack"], None, &store)
        .await
        .is_err());
    // A raw write must fail on persistence too; SDK validation is not the boundary.
    resource
        .set_unsafe(
            property.into(),
            Value::Json(json!({"attack":5,"release":0.2})),
        )
        .unwrap();
    assert!(store.add_resource(&resource).await.is_err());
    let definition = store.get_resource(&property.into()).await.unwrap();
    assert!(definition.materialized_state().is_none());
    let mut tampered = definition.clone();
    assert!(tampered
        .set_unsafe(
            crate::urls::DESCRIPTION.into(),
            Value::String("changed".into())
        )
        .is_err());
    let mut values = definition.get_propvals().clone();
    values.insert(
        crate::urls::DESCRIPTION.into(),
        Value::String("changed".into()),
    );
    let tampered = Resource::from_propvals(values, definition.get_subject().clone());
    assert!(store
        .add_resource_opts(&tampered, false, false, true)
        .await
        .is_err());
    assert!(frozen::verify(&definition).is_ok());
    let alias = property.replacen("atomic:", "did:ad:", 1);
    assert_eq!(
        frozen::body(&store.get_resource(&alias.as_str().into()).await.unwrap()).unwrap(),
        frozen::body(&definition).unwrap()
    );
}

#[tokio::test]
async fn nested_edits_merge_without_replacing_the_envelope() {
    let store = Db::init_temp("schema-merge").await.unwrap();
    let schema = audio();
    schema.register(&store).await.unwrap();
    let mut base = schema.new_resource("atomic:base".into()).unwrap();
    schema
        .set(&mut base, "tune", json!(0), &store)
        .await
        .unwrap();
    schema
        .set(
            &mut base,
            "envelope",
            json!({"attack":0.01,"release":0.2}),
            &store,
        )
        .await
        .unwrap();
    let snapshot = base.build_state_doc().unwrap().export_snapshot();
    let mut left = Resource::new("atomic:base".into());
    left.apply_state_doc(crate::loro::AtomicLoroDoc::from_snapshot(&snapshot).unwrap())
        .unwrap();
    let mut right = Resource::new("atomic:base".into());
    right
        .apply_state_doc(crate::loro::AtomicLoroDoc::from_snapshot(&snapshot).unwrap())
        .unwrap();
    schema
        .patch(
            &mut left,
            "envelope",
            &["attack"],
            Some(json!(0.05)),
            &store,
        )
        .await
        .unwrap();
    schema
        .patch(
            &mut right,
            "envelope",
            &["release"],
            Some(json!(0.9)),
            &store,
        )
        .await
        .unwrap();
    let merged = left.build_state_doc().unwrap();
    merged
        .doc()
        .import(&right.build_state_doc().unwrap().export_snapshot())
        .unwrap();
    let mut result = Resource::new("atomic:base".into());
    result.apply_state_doc(merged).unwrap();
    assert_eq!(
        result
            .get(schema.property("envelope").unwrap())
            .unwrap()
            .to_string(),
        json!({"attack":0.05,"release":0.9}).to_string()
    );
}

#[test]
fn shape_errors_are_explicit_and_bounded() {
    assert!(serde_json::from_value::<Shape>(json!({"type":"string","pattern":".*"})).is_err());
    let shape: Shape =
        serde_json::from_value(json!({"type":"array","items":{"type":"integer"},"maxItems":2}))
            .unwrap();
    assert!(shape.validate(&json!([1, 2])).is_ok());
    assert!(shape.validate(&json!([1, 2, 3])).is_err());
    assert!(shape.validate(&json!([1, 1.5])).is_err());
    assert!(Shape::Reference
        .validate(&json!("a literal, not a link"))
        .is_err());
    assert!(Shape::Reference.validate(&json!("atomic:example")).is_ok());
    assert_ne!(
        audio().class_id,
        AppSchema::define("different-meaning", Default::default())
            .unwrap()
            .class_id
    );
}

#[tokio::test]
async fn browser_and_native_share_identity_and_merge_nested_edits() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/app-schema.json")).unwrap();
    let schema: AppSchema = serde_json::from_value(fixture["bundle"].clone()).unwrap();
    assert_eq!(
        serde_jcs::to_vec(&audio()).unwrap(),
        serde_jcs::to_vec(&fixture["bundle"]).unwrap()
    );
    let store = Db::init_temp("schema-browser-fixture").await.unwrap();
    schema.register(&store).await.unwrap();
    let native = crate::agents::decode_base64(fixture["rust_edit"].as_str().unwrap()).unwrap();
    let browser =
        crate::agents::decode_base64(fixture["typescript_edit"].as_str().unwrap()).unwrap();
    let doc = crate::loro::AtomicLoroDoc::from_snapshot(&native).unwrap();
    doc.doc().import(&browser).unwrap();
    let mut resource = Resource::new("atomic:example".into());
    resource.apply_state_doc(doc).unwrap();
    resource.check_required_props(&store).await.unwrap();
    assert_eq!(
        resource
            .get(schema.property("envelope").unwrap())
            .unwrap()
            .to_string(),
        json!({"attack":0.05,"release":0.9}).to_string()
    );
}

#[tokio::test]
async fn commits_cannot_edit_or_delete_frozen_resources_even_without_validations() {
    let store = Db::init_temp("schema-commit").await.unwrap();
    let schema = audio();
    schema.register(&store).await.unwrap();
    for destroy in [false, true] {
        let commit = crate::commit::Commit {
            subject: schema.class_id.clone().into(),
            created_at: 0,
            signer: "atomic:agent:test".into(),
            loro_update: None,
            destroy: Some(destroy),
            signature: None,
            previous_commit: None,
            is_genesis: None,
            url: None,
        };
        let error = commit
            .validate_and_build_response(
                &crate::commit::CommitOpts::no_validations_no_index(),
                &store,
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Frozen definitions"));
    }
}

#[cfg(feature = "db-redb")]
#[tokio::test]
async fn frozen_definitions_survive_database_reopen_without_crdt_metadata() {
    let path = std::env::temp_dir().join(format!(
        "atomic-schema-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    std::fs::create_dir_all(&path).unwrap();
    let schema = audio();
    {
        let store = Db::init_redb_file(&path.join("db.redb"), None, &path.join("uploads"))
            .await
            .unwrap();
        schema.register(&store).await.unwrap();
    }
    {
        let store = Db::init_redb_file(&path.join("db.redb"), None, &path.join("uploads"))
            .await
            .unwrap();
        for (id, expected) in &schema.definitions {
            let resource = store.get_resource(&id.as_str().into()).await.unwrap();
            assert_eq!(&frozen::body(&resource).unwrap(), expected);
            assert!(resource.materialized_state().is_none());
        }
    }
    std::fs::remove_dir_all(&path).unwrap();
}

#[test]
fn null_members_survive_native_json_materialization() {
    let value = json!({"optional":null,"items":[null,null]});
    let mut resource = Resource::new("atomic:null-test".into());
    resource
        .set_unsafe("urn:json".into(), Value::Json(value.clone()))
        .unwrap();
    let doc = resource.build_state_doc().unwrap();
    let mut reloaded = Resource::new("atomic:null-test".into());
    reloaded.apply_state_doc(doc).unwrap();
    assert_eq!(
        reloaded.get("urn:json").unwrap().to_string(),
        value.to_string()
    );
}

#[tokio::test]
async fn schema_validating_commit_rejects_an_invalid_nested_update() {
    let store = Db::init_temp("schema-remote-write").await.unwrap();
    let schema = audio();
    schema.register(&store).await.unwrap();
    let mut resource = schema
        .new_resource("https://example.com/audio-slice".into())
        .unwrap();
    schema
        .set(&mut resource, "tune", json!(0), &store)
        .await
        .unwrap();
    schema
        .set(
            &mut resource,
            "envelope",
            json!({"attack":0.01,"release":0.2}),
            &store,
        )
        .await
        .unwrap();
    store.add_resource(&resource).await.unwrap();
    resource
        .set_unsafe(
            schema.property("envelope").unwrap().into(),
            Value::Json(json!({"attack":99,"release":0.2})),
        )
        .unwrap();
    let commit = crate::commit::Commit {
        subject: resource.get_subject().clone(),
        created_at: 0,
        signer: "atomic:agent:test".into(),
        loro_update: Some(resource.build_state_doc().unwrap().export_snapshot()),
        destroy: None,
        signature: None,
        previous_commit: None,
        is_genesis: None,
        url: None,
    };
    let mut opts = crate::commit::CommitOpts::no_validations_no_index();
    opts.validate_schema = true;
    let error = commit
        .validate_and_build_response(&opts, &store)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("$/attack"), "{error}");
}
