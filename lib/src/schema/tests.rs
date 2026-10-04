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
    assert!(store
        .get_resource(&schema.class_id.as_str().into())
        .await
        .is_err());
    let native = crate::agents::decode_base64(fixture["rust_edit"].as_str().unwrap()).unwrap();
    let browser =
        crate::agents::decode_base64(fixture["typescript_edit"].as_str().unwrap()).unwrap();
    let doc = crate::loro::AtomicLoroDoc::from_snapshot(&native).unwrap();
    doc.doc().import(&browser).unwrap();
    let mut resource = Resource::new("atomic:example".into());
    resource.apply_state_doc(doc).unwrap();
    resource.check_required_props(&store).await.unwrap();
    store.persist_replicated_resource(&resource).await.unwrap();
    assert!(store
        .get_resource(&schema.class_id.as_str().into())
        .await
        .is_ok());
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

async fn slice(store: &Db) -> (AppSchema, Resource) {
    let schema = audio();
    schema.register(store).await.unwrap();
    let mut resource = schema
        .new_resource("atomic:schema-sync-slice".into())
        .unwrap();
    schema
        .set(&mut resource, "tune", json!(7), store)
        .await
        .unwrap();
    schema
        .set(
            &mut resource,
            "envelope",
            json!({"attack":0.01,"release":0.2}),
            store,
        )
        .await
        .unwrap();
    (schema, resource)
}

#[tokio::test]
async fn cold_sync_push_installs_dependencies_and_delta_reuses_them() {
    use crate::{
        agents::ForAgent,
        db::trees::Tree,
        sync::{engine, protocol},
    };
    let source = Db::init_temp("schema-sync-source").await.unwrap();
    let (alice, drive) = source.setup("Alice").await.unwrap();
    let (schema, mut resource) = slice(&source).await;
    resource
        .set_unsafe(
            crate::urls::PARENT.into(),
            Value::AtomicUrl(drive.clone().into()),
        )
        .unwrap();
    resource
        .set_unsafe(
            crate::urls::DRIVE_PROP.into(),
            Value::AtomicUrl(drive.clone().into()),
        )
        .unwrap();
    let doc = resource.build_state_doc().unwrap();
    let snapshot = doc.export_snapshot();
    let version = doc.doc().oplog_vv();
    let drive_snapshot = source
        .kv
        .get(Tree::LoroSnapshots, drive.as_bytes())
        .unwrap()
        .unwrap();
    let frame = protocol::encode_sync_push(
        &drive,
        &[
            (&drive, &drive_snapshot),
            (resource.get_subject().as_str(), &snapshot),
        ],
        true,
    );
    let sink = Db::init_temp("schema-sync-cold").await.unwrap();
    let mut agent = ForAgent::from(alice);
    let output = engine::handle_frame_full(&frame, &sink, &mut agent).await;
    assert!(output.frames.iter().any(|f| f[0] == protocol::tag::SYNC_OK));
    for id in schema.definitions.keys() {
        assert!(sink.get_resource(&id.as_str().into()).await.is_ok());
        // The cache does not introduce a public schema-by-hash read path.
        assert!(sink
            .get_resource_extended(&id.as_str().into(), true, &ForAgent::Public)
            .await
            .is_err());
    }
    schema
        .patch(
            &mut resource,
            "envelope",
            &["release"],
            Some(json!(0.7)),
            &source,
        )
        .await
        .unwrap();
    let delta = resource
        .build_state_doc()
        .unwrap()
        .export_updates_since(&version);
    assert!(delta.len() < snapshot.len());
    let frame =
        protocol::encode_sync_push(&drive, &[(resource.get_subject().as_str(), &delta)], true);
    let output = engine::handle_frame_full(&frame, &sink, &mut agent).await;
    assert!(output.frames.iter().any(|f| f[0] == protocol::tag::SYNC_OK));
    let received = sink.get_resource(resource.get_subject()).await.unwrap();
    assert_eq!(
        received
            .get(schema.property("envelope").unwrap())
            .unwrap()
            .to_string(),
        json!({"attack":0.01,"release":0.7}).to_string()
    );
}

#[tokio::test]
async fn hostile_dependencies_leave_no_resource_or_cache_entries() {
    use super::dependencies::ROOT;
    let source = Db::init_temp("schema-hostile-source").await.unwrap();
    let (schema, resource) = slice(&source).await;
    for attack in [
        "tamper",
        "missing",
        "noncanonical",
        "wrong-type",
        "too-many",
        "too-big",
        "code",
    ] {
        let sink = Db::init_temp(&format!("schema-hostile-{attack}"))
            .await
            .unwrap();
        let doc = resource.build_state_doc().unwrap();
        let map = doc.doc().get_map(ROOT);
        match attack {
            "tamper" => {
                map.insert(&schema.class_id, "{}").unwrap();
            }
            "missing" => {
                map.delete(&schema.class_id).unwrap();
            }
            "noncanonical" => {
                map.insert(
                    &schema.class_id,
                    serde_json::to_string_pretty(&schema.definitions[&schema.class_id]).unwrap(),
                )
                .unwrap();
            }
            "wrong-type" => {
                map.insert(&schema.class_id, 1).unwrap();
            }
            "too-many" => {
                for n in 0..513 {
                    map.insert(&format!("key-{n}"), "{}").unwrap();
                }
            }
            "too-big" => {
                map.insert(&schema.class_id, "x".repeat(frozen::MAX_BYTES + 1))
                    .unwrap();
            }
            "code" => {
                let mut body = schema.definitions[&schema.class_id].clone();
                body["urn:migration:execute"] = json!("fetch('https://attacker.invalid/')");
                let id = frozen::id(&body).unwrap();
                map.insert(&id, serde_jcs::to_string(&body).unwrap())
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let mut incoming = Resource::new(resource.get_subject().to_string());
        incoming.apply_state_doc(doc).unwrap();
        assert!(
            sink.persist_replicated_resource(&incoming).await.is_err(),
            "{attack}"
        );
        assert!(
            sink.get_resource(resource.get_subject()).await.is_err(),
            "{attack}"
        );
        for id in schema.definitions.keys() {
            assert!(
                sink.get_resource(&id.as_str().into()).await.is_err(),
                "{attack}"
            );
        }
    }
}

#[tokio::test]
async fn rejected_sync_never_acknowledges_or_installs_definitions() {
    use crate::{
        agents::ForAgent,
        sync::{engine, protocol},
    };
    let source = Db::init_temp("schema-sync-reject-source").await.unwrap();
    let (schema, mut resource) = slice(&source).await;
    let sink = Db::init_temp("schema-sync-reject-sink").await.unwrap();
    let (alice, drive) = sink.setup("Alice").await.unwrap();
    resource
        .set_unsafe(
            crate::urls::PARENT.into(),
            Value::AtomicUrl(drive.clone().into()),
        )
        .unwrap();
    resource
        .set_unsafe(
            crate::urls::DRIVE_PROP.into(),
            Value::AtomicUrl(drive.clone().into()),
        )
        .unwrap();
    for authorized in [false, true] {
        let doc = resource.build_state_doc().unwrap();
        if authorized {
            doc.doc()
                .get_map(super::dependencies::ROOT)
                .insert(&schema.class_id, "{}")
                .unwrap();
        }
        let frame = protocol::encode_sync_push(
            &drive,
            &[(resource.get_subject().as_str(), &doc.export_snapshot())],
            true,
        );
        let mut agent = if authorized {
            ForAgent::from(alice.clone())
        } else {
            ForAgent::Public
        };
        let output = engine::handle_frame_full(&frame, &sink, &mut agent).await;
        assert!(output.frames.iter().any(|f| f[0] == protocol::tag::ERROR));
        assert!(!output.frames.iter().any(|f| f[0] == protocol::tag::SYNC_OK));
        for id in schema.definitions.keys() {
            assert!(sink.get_resource(&id.as_str().into()).await.is_err());
        }
        assert!(sink.get_resource(resource.get_subject()).await.is_err());
    }
}

#[tokio::test]
async fn migration_coexists_with_concurrent_old_client_edits() {
    let store = Db::init_temp("schema-migration-author").await.unwrap();
    let (v1, mut migrated) = slice(&store).await;
    let base = migrated.build_state_doc().unwrap().export_snapshot();
    let mut old_client = Resource::new(migrated.get_subject().to_string());
    old_client
        .apply_state_doc(crate::loro::AtomicLoroDoc::from_snapshot(&base).unwrap())
        .unwrap();
    // A new representation gets new IDs. The app explicitly converts semitones
    // to cents, preserving the old property for older writers.
    let v2 = AppSchema::define(
        "audio-slice-cents",
        [(
            "cents".into(),
            Field {
                required: true,
                shape: Shape::Integer {
                    minimum: Some(-4800.),
                    maximum: Some(4800.),
                },
            },
        )]
        .into(),
    )
    .unwrap();
    v2.register(&store).await.unwrap();
    v2.set(&mut migrated, "cents", json!(700), &store)
        .await
        .unwrap();
    migrated
        .set_unsafe(
            crate::urls::IS_A.into(),
            Value::ResourceArray(vec![v2.class_id.clone().into()]),
        )
        .unwrap();
    super::dependencies::attach(&mut migrated, &store)
        .await
        .unwrap();
    v1.set(&mut old_client, "tune", json!(9), &store)
        .await
        .unwrap();
    let merged = migrated.build_state_doc().unwrap();
    merged
        .import_update(&old_client.build_state_doc().unwrap().export_snapshot())
        .unwrap();
    migrated.apply_state_doc(merged).unwrap();
    let cold = Db::init_temp("schema-migration-cold").await.unwrap();
    cold.persist_replicated_resource(&migrated).await.unwrap();
    assert_eq!(
        migrated
            .get(v1.property("tune").unwrap())
            .unwrap()
            .to_string(),
        "9"
    );
    assert_eq!(
        migrated
            .get(v2.property("cents").unwrap())
            .unwrap()
            .to_string(),
        "700"
    );
    // CRDT convergence preserves both edits. It does not recompute converted
    // values: reconciling 900 vs 700 cents is an explicit application decision.
    assert!(cold
        .get_resource(&v1.property("tune").unwrap().into())
        .await
        .is_ok());
    assert!(cold
        .get_resource(&v2.class_id.as_str().into())
        .await
        .is_ok());
    // Stale, valid attached definitions are not installed just for existing.
    assert!(cold
        .get_resource(&v1.class_id.as_str().into())
        .await
        .is_err());
    let mut historical = Resource::new("atomic:historical-slice".into());
    historical
        .apply_state_doc(crate::loro::AtomicLoroDoc::from_snapshot(&base).unwrap())
        .unwrap();
    cold.persist_replicated_resource(&historical).await.unwrap();
    assert!(cold
        .get_resource(&v1.class_id.as_str().into())
        .await
        .is_ok());
}

#[tokio::test]
async fn dependency_traversal_and_aggregate_bytes_are_bounded() {
    use super::dependencies::ROOT;
    let store = Db::init_temp("schema-budget").await.unwrap();
    for deep in [false, true] {
        let doc = crate::loro::AtomicLoroDoc::new();
        let map = doc.doc().get_map(ROOT);
        let mut previous = None;
        for index in 0..if deep { 19 } else { 5 } {
            let body = json!({
                crate::urls::IS_A:[crate::urls::CLASS],
                crate::urls::SHORTNAME:format!("class-{index}"),
                crate::urls::DESCRIPTION:if deep { String::new() } else { "x".repeat(220 * 1024) },
                crate::urls::REQUIRES: previous.iter().collect::<Vec<_>>(),
                crate::urls::RECOMMENDS:[],
            });
            let id = frozen::id(&body).unwrap();
            map.insert(&id, serde_jcs::to_string(&body).unwrap())
                .unwrap();
            previous = Some(id);
        }
        doc.set_property(
            crate::urls::IS_A,
            &Value::ResourceArray(vec![previous.unwrap().into()]),
        )
        .unwrap();
        let mut resource = Resource::new("atomic:bounded-dependencies".into());
        resource.apply_state_doc(doc).unwrap();
        let error = super::dependencies::resolve(&resource, &store)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(if deep {
                "traversal limit"
            } else {
                "byte budget"
            }),
            "{error}"
        );
    }
}

#[tokio::test]
async fn cold_commit_validates_attachments_without_registering_them_during_validation() {
    let source = Db::init_temp("schema-cold-commit-source").await.unwrap();
    let (schema, resource) = slice(&source).await;
    let sink = Db::init_temp("schema-cold-commit-sink").await.unwrap();
    let commit = crate::commit::Commit {
        subject: "https://example.com/cold-commit".into(),
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
    let response = commit
        .validate_and_build_response(&opts, &sink)
        .await
        .unwrap();
    for id in schema.definitions.keys() {
        assert!(sink.get_resource(&id.as_str().into()).await.is_err());
    }
    sink.persist_replicated_resource(&response.resource_new.unwrap())
        .await
        .unwrap();
    for id in schema.definitions.keys() {
        assert!(sink.get_resource(&id.as_str().into()).await.is_ok());
    }
}

#[tokio::test]
async fn builder_authoring_and_authorized_get_retrieve_schemas_automatically() {
    use crate::{
        agents::ForAgent,
        commit::{Commit, CommitBuilder, CommitOpts},
        sync::{engine, protocol},
    };
    let source = Db::init_temp("schema-builder-source").await.unwrap();
    let (alice, drive) = source.setup("Alice").await.unwrap();
    let schema = audio();
    schema.register(&source).await.unwrap();
    let mut builder = CommitBuilder::new("placeholder".into());
    builder.set(
        crate::urls::IS_A.into(),
        Value::ResourceArray(vec![schema.class_id.clone().into()]),
    );
    builder.set(crate::urls::PARENT.into(), Value::AtomicUrl(drive.into()));
    builder.set(
        crate::urls::READ.into(),
        Value::ResourceArray(vec![alice.subject.to_string().into()]),
    );
    builder.set(schema.property("tune").unwrap().into(), Value::Float(0.));
    builder.set(
        schema.property("envelope").unwrap().into(),
        Value::Json(json!({"attack":0.01,"release":0.2})),
    );
    let commit = Commit::create_did(builder, &alice, &source).await.unwrap();
    let subject = commit.subject.to_string();
    crate::runtime::AtomicNode::from_db(source.clone())
        .apply_local_commit(
            commit,
            &CommitOpts {
                validate_signature: true,
                validate_schema: true,
                validate_rights: true,
                update_index: true,
                ..CommitOpts::no_validations_no_index()
            },
        )
        .await
        .unwrap();
    let frame = protocol::encode_get(1, &subject);
    let denied = engine::handle_frame_full(&frame, &source, &mut ForAgent::Public).await;
    assert_eq!(denied.frames[0][0], protocol::tag::ERROR);
    let answer = engine::handle_frame_full(&frame, &source, &mut ForAgent::from(alice)).await;
    assert_eq!(answer.frames[0][0], protocol::tag::UPDATE);
    let update = protocol::decode_update(&answer.frames[0][1..]).unwrap();
    let cold = Db::init_temp("schema-builder-recipient").await.unwrap();
    let mut resource = Resource::new(subject);
    resource
        .apply_state_doc(crate::loro::AtomicLoroDoc::from_snapshot(&update.loro_bytes).unwrap())
        .unwrap();
    cold.persist_replicated_resource(&resource).await.unwrap();
    assert!(cold
        .get_resource(&schema.class_id.as_str().into())
        .await
        .is_ok());
}
