/*!
`atomic_lib` helps you to get, store, serialize, parse and validate Atomic Data.

See the [Atomic Data Docs](https://docs.atomicdata.dev) for more information.

## Features

- Two stores for Atomic Data:
  - **In-memory** [Store] for getting / setting data. Useful for client applications.
  - **On disk** [Db], powered by Sled. Useful for applications that persist Atomic Data, such as [`atomic-server`](https://crates.io/crates/atomic-server).
- [serialize] and [parse] tools for [JSON-AD](https://docs.atomicdata.dev/core/json-ad.html), plain JSON, RDF, Turtle, N-Triples and JSON-LD.
- [Resource] with getters, setters and a `.save` function that creates Commits.
- [Value] converts Atomic Data to Rust native types
- Validate [Atomic Schema](https://docs.atomicdata.dev/schema/intro.html)
- [Commit]s (transactions / delta's / changes / updates / versioning / history).
- [plugins] system (although not very mature)
- [collections] (pagination, sorting, filtering)
- Querying (using triple pattern fragments) (see [storelike::Query])
- [plugins::invite] for sharing
- [hierarchy] for authorization
- [crate::endpoints::Endpoint] for custom API endpoints
- [config::Config] files.

## Getting started

```
// Import the `Storelike` trait to get access to most functions
use atomic_lib::Storelike;

tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
    // Start with initializing the in-memory store
    let store = atomic_lib::Store::init().await.unwrap();
    store.set_base_url("http://localhost");
    // Pre-load the default Atomic Data Atoms (from atomicdata.dev),
    // this is not necessary, but will probably make your project a bit faster
    store.populate().await.unwrap();
    // We can create a new Resource, linked to the store.
    // Note that since this store only exists in memory, it's data cannot be accessed from the internet.
    // Let's make a new Property instance! Let's create "age".
    let mut new_property = atomic_lib::Resource::new_instance("https://atomicdata.dev/classes/Property", &store).await.unwrap();
    // And add a description for that Property
    new_property.set_shortname("description", "the age of a person", &store).await.unwrap();
    // A subject URL for the new resource has been created automatically.
    let subject = new_property.get_subject().clone();
    // Now we need to make sure these changes are also applied to the store.
    // In order to change things in the store, we should use Commits,
    // which are signed pieces of data that contain state changes.
    // Because these are signed, we need an Agent, which has a private key to sign Commits.
    let agent = store.create_agent(Some("my_agent")).await.unwrap();
    store.set_default_agent(agent);
    let _fails   = new_property.save_locally(&store).await;
    // But.. when we commit, we get an error!
    // Because we haven't set all the properties required for the Property class.
    // We still need to set `shortname` and `datatype`.
    new_property.set_shortname("shortname", "age", &store).await.unwrap()
      .set_shortname("datatype", atomic_lib::urls::INTEGER, &store).await.unwrap()
      .save_locally(&store).await.unwrap();
    // Now the changes to the resource applied to the store, and we can fetch the newly created resource!
    let fetched_new_resource = store.get_resource(&subject).await.unwrap();
    assert!(fetched_new_resource.get_shortname("description", &store).await.unwrap().to_string() == "the age of a person");
});
```
*/

pub mod agents;
pub mod atoms;
pub mod authentication;
#[cfg(feature = "db")]
pub mod class_extender;
pub mod client;
pub mod collections;
pub mod commit;
#[cfg(feature = "config")]
pub mod config;
pub mod datatype;
#[cfg(feature = "db")]
pub mod db;
pub mod dht;
#[cfg(feature = "db")]
pub mod endpoints;
pub mod errors;
pub mod hierarchy;
pub mod loro;
pub mod mapping;
pub mod metrics;
pub mod parse;

pub mod populate;
pub mod resources;
pub mod schema;
pub mod serialize;
pub mod store;
pub mod storelike;
#[cfg(feature = "db")]
pub mod sync;
pub mod subject;
pub mod test_utils;
pub mod urls;
pub mod utils;
pub mod validate;
pub mod values;

pub use atoms::Atom;
pub use commit::Commit;
#[cfg(feature = "db")]
pub use db::Db;
pub use errors::AtomicError;
pub use errors::AtomicErrorType;
pub use resources::Resource;
pub use store::Store;
pub use storelike::Storelike;
pub use subject::Subject;
pub use values::Value;
