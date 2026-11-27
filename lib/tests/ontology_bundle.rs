//! `install_ontology_bundle`: an app's ontology is stored locally at its fixed
//! subjects, as if fetched, and `import` publishes it on the node that owns the
//! address.
//! Run: cargo test -p atomic_lib --features db-redb --test ontology_bundle
#![cfg(feature = "db-redb")]

use atomic_lib::{
    agents::ForAgent,
    ontology_bundle::install_ontology_bundle,
    parse::{ParseOpts, SaveOpts},
    urls, Db, Storelike, Subject,
};
use std::time::{Duration, Instant};

const BUNDLE: &str = include_str!("fixtures/ontology-bundle.json");
const ONTOLOGY: &str = "https://atomicdata.dev/medical/v1";
const CLASS: &str = "https://atomicdata.dev/medical/v1/class/lab-result";
const PROP: &str = "https://atomicdata.dev/medical/v1/property/med-value";

#[tokio::test]
async fn stores_at_fixed_subjects_offline_and_is_idempotent() {
    let db = Db::init_temp("ontology_bundle_install").await.unwrap();

    let started = Instant::now();
    let report = install_ontology_bundle(&db, BUNDLE).await.unwrap();
    // No network: a fetch attempt would take far longer than this.
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(report.created.len(), 26);
    assert!(report.unchanged.is_empty());

    let class = db.get_resource(&CLASS.into()).await.unwrap();
    assert_eq!(
        class.get(urls::SHORTNAME).unwrap().to_string(),
        "lab-result"
    );
    // The bundle is stored as written: no parent rewriting.
    assert_eq!(class.get(urls::PARENT).unwrap().to_string(), ONTOLOGY);
    assert!(db
        .get_resource(&ONTOLOGY.into())
        .await
        .unwrap()
        .get(urls::PARENT)
        .is_err());
    assert_eq!(db.get_property(PROP).await.unwrap().shortname, "med-value");

    let again = install_ontology_bundle(&db, BUNDLE).await.unwrap();
    assert!(again.created.is_empty() && again.updated.is_empty());
    assert_eq!(again.unchanged.len(), 26);
}

#[tokio::test]
async fn refuses_a_changed_meaning_but_takes_a_new_label() {
    let db = Db::init_temp("ontology_bundle_conflict").await.unwrap();
    install_ontology_bundle(&db, BUNDLE).await.unwrap();

    let mut changed: serde_json::Value = serde_json::from_str(BUNDLE).unwrap();
    for r in changed.as_array_mut().unwrap() {
        if r["@id"] == PROP {
            r[urls::DATATYPE_PROP] = "https://atomicdata.dev/datatypes/boolean".into();
        }
    }
    let err = install_ontology_bundle(&db, &changed.to_string())
        .await
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("different") && err.contains(urls::DATATYPE_PROP),
        "{err}"
    );

    let mut relabeled: serde_json::Value = serde_json::from_str(BUNDLE).unwrap();
    for r in relabeled.as_array_mut().unwrap() {
        if r["@id"] == PROP {
            r[urls::DESCRIPTION] = "A new description".into();
        }
    }
    let report = install_ontology_bundle(&db, &relabeled.to_string())
        .await
        .unwrap();
    assert_eq!(report.updated, vec![PROP.to_string()]);
    let prop = db.get_resource(&PROP.into()).await.unwrap();
    assert_eq!(
        prop.get(urls::DESCRIPTION).unwrap().to_string(),
        "A new description"
    );
}

#[tokio::test]
async fn refuses_a_bundle_that_is_not_schema_and_writes_nothing() {
    let db = Db::init_temp("ontology_bundle_shape").await.unwrap();
    let mut bundle: serde_json::Value = serde_json::from_str(BUNDLE).unwrap();
    bundle.as_array_mut().unwrap().push(serde_json::json!({
        "@id": "https://atomicdata.dev/medical/v1/other",
        urls::IS_A: [urls::FOLDER],
        urls::NAME: "x",
    }));
    let err = install_ontology_bundle(&db, &bundle.to_string())
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("not an Ontology"), "{err}");

    // An unknown Ontology class is refused, not rewritten.
    let legacy = BUNDLE.replace(urls::ONTOLOGY, "https://atomicdata.dev/classes/Ontology");
    let err = install_ontology_bundle(&db, &legacy)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("exactly one Ontology"), "{err}");

    // A reserved vocabulary namespace is refused.
    let reserved = BUNDLE.replace(
        "atomicdata.dev/medical/v1/class",
        "atomicdata.dev/classes/med",
    );
    let err = install_ontology_bundle(&db, &reserved)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("shared vocabulary"), "{err}");

    assert!(!db.has_stored_resource(&Subject::from(ONTOLOGY)));
}

/// The publishing path: the node whose own domain is the bundle's host imports
/// the bundle, then serves every term at its subject.
#[tokio::test]
async fn the_node_that_owns_the_address_publishes_by_importing() {
    let path = ".temp/db/ontology_bundle_publish";
    let _ = std::fs::remove_dir_all(path);
    std::fs::create_dir_all(format!("{path}/uploads")).unwrap();
    // The default vocabulary is seeded under a neutral host (seeding it on
    // `atomicdata.dev` itself is how the real store was built long ago), then the
    // store is reopened as the node that owns the address.
    let open = |domain: &str| {
        let domain = domain.to_string();
        async move {
            Db::init_redb_file(
                std::path::Path::new(path),
                Some(domain),
                std::path::Path::new(&format!("{path}/uploads")),
            )
            .await
            .unwrap()
        }
    };
    let seed = open("https://localhost").await;
    seed.set_default_agent(seed.create_agent(None).await.unwrap());
    seed.populate().await.unwrap();
    drop(seed);
    let db = open("https://atomicdata.dev").await;
    let (agent, drive) = db.setup("Operator").await.unwrap();

    // Priming is for nodes that do not own the address.
    let err = install_ontology_bundle(&db, BUNDLE)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("served by this store itself"), "{err}");

    let opts = ParseOpts {
        importer: Some(Subject::from_raw(&drive, None)),
        for_agent: ForAgent::AgentSubject(agent.subject.clone()),
        signer: Some(agent),
        save: SaveOpts::Commit,
        overwrite_outside: false,
        ..ParseOpts::default()
    };
    // `import` sorts Properties first, and a term needs its parent stored
    // before it, so the Ontology goes in on its own first.
    let all: Vec<serde_json::Value> = serde_json::from_str(BUNDLE).unwrap();
    let (ontology, terms): (Vec<_>, Vec<_>) = all.into_iter().partition(|r| r["@id"] == ONTOLOGY);
    db.import(&serde_json::to_string(&ontology).unwrap(), &opts)
        .await
        .unwrap();
    db.import(&serde_json::to_string(&terms).unwrap(), &opts)
        .await
        .unwrap();

    let started = Instant::now();
    for subject in [ONTOLOGY, CLASS, PROP] {
        let served = db.get_resource(&subject.into()).await.unwrap();
        assert!(served.get(urls::SHORTNAME).is_ok(), "{subject}");
        // Localized on this host, not stored as a foreign address.
        assert!(
            db.normalize_subject(&subject.into()).is_local(),
            "{subject}"
        );
    }
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(db.get_property(PROP).await.unwrap().shortname, "med-value");
}
