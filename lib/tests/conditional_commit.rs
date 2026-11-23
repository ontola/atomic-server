//! Host preconditions must use the state protected by the subject write lock.
#![cfg(feature = "db-redb")]
use atomic_lib::{urls, Db, Resource, Storelike, Value};

async fn seeded(name: &str) -> (Db, String) {
    let store = Db::init_temp(name).await.unwrap();
    let (_, drive) = store.setup("Conditional test").await.unwrap();
    let subject = "https://example.test/conditional-file".to_string();
    let mut resource = Resource::new(subject.clone());
    resource
        .set_unsafe(urls::PARENT.into(), Value::AtomicUrl(drive.into()))
        .unwrap();
    resource
        .set_unsafe(urls::NAME.into(), Value::String("initial".into()))
        .unwrap();
    resource.save_locally(&store).await.unwrap();
    (store, subject)
}

fn expecting_initial(store: &Db) -> Db {
    store.with_commit_check(|_, current| {
        let name = current
            .as_ref()
            .and_then(|resource| resource.get(urls::NAME).ok());
        if !matches!(name, Some(Value::String(value)) if value == "initial") {
            return Err("precondition failed".into());
        }
        Ok(())
    })
}

#[tokio::test]
async fn concurrent_conditional_commits_have_one_winner() {
    let (store, subject) = seeded("conditional_one_winner").await;
    let guarded = expecting_initial(&store);
    let mut first = store.get_resource(&subject.as_str().into()).await.unwrap();
    let mut second = first.clone();
    first
        .set_unsafe(urls::NAME.into(), Value::String("first".into()))
        .unwrap();
    second
        .set_unsafe(urls::NAME.into(), Value::String("second".into()))
        .unwrap();
    let (a, b) = tokio::join!(first.save_locally(&guarded), second.save_locally(&guarded));
    assert_ne!(
        a.is_ok(),
        b.is_ok(),
        "exactly one mutation may pass the same precondition"
    );
    assert!(a
        .as_ref()
        .err()
        .or(b.as_ref().err())
        .unwrap()
        .to_string()
        .contains("precondition"));
    let stored = store.get_resource(&subject.as_str().into()).await.unwrap();
    assert_eq!(
        stored.get(urls::NAME).unwrap().to_string(),
        String::from(if a.is_ok() { "first" } else { "second" })
    );
}

#[tokio::test]
async fn an_ordinary_writer_invalidates_a_guarded_store_view() {
    let (store, subject) = seeded("conditional_native_writer").await;
    let guarded = expecting_initial(&store);
    let mut native = store.get_resource(&subject.as_str().into()).await.unwrap();
    native
        .set_unsafe(urls::NAME.into(), Value::String("native".into()))
        .unwrap();
    native.save_locally(&store).await.unwrap();
    let mut stale = store.get_resource(&subject.as_str().into()).await.unwrap();
    stale
        .set_unsafe(urls::NAME.into(), Value::String("must not land".into()))
        .unwrap();
    assert!(stale
        .save_locally(&guarded)
        .await
        .unwrap_err()
        .to_string()
        .contains("precondition"));
    assert_eq!(
        store
            .get_resource(&subject.as_str().into())
            .await
            .unwrap()
            .get(urls::NAME)
            .unwrap()
            .to_string(),
        "native"
    );
}
