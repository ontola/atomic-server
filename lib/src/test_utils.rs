/// Creates a populated Store with an agent (testman) and one test resource (_:test)
#[cfg(test)]
pub async fn init_store() -> crate::Store {
    use crate::Storelike;

    let store = crate::Store::init().await.unwrap();
    store.populate().await.unwrap();
    store.set_base_url("https://localhost");
    let agent = store.create_agent(None).await.unwrap();
    store.set_default_agent(agent);
    store
}
