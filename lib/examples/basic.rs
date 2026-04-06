//! Basic example: create an agent, a drive, a resource, and edit it.
//!
//! Requires AtomicServer running at localhost:9883.
//!
//! Run with: cargo run --example basic -p atomic_lib

use atomic_lib::client::connected::Client;
use atomic_lib::errors::AtomicResult;

#[tokio::main]
async fn main() -> AtomicResult<()> {
    let client = Client::new("http://localhost:9883").await?;
    let agent = client.new_agent("Alice").await?;
    println!("Agent: {}", agent.subject);

    let drive = client.new_drive(&agent, "Alice's Drive").await?;
    println!("Drive: {}", drive);

    let mut resource = client.new_resource(&drive);
    resource.set_name("My first resource");
    resource.set_unsafe(
        "https://atomicdata.dev/properties/description".into(),
        atomic_lib::Value::String("Created with atomic_lib".into()),
    );
    resource.set_unsafe(
        atomic_lib::urls::IS_A.into(),
        atomic_lib::Value::ResourceArray(vec![
            atomic_lib::urls::CLASS.into(),
        ]),
    );
    resource.set_unsafe(
        atomic_lib::urls::SHORTNAME.into(),
        atomic_lib::Value::Slug("my-resource".into()),
    );

    let subject = resource.save_remote(client.store()).await?;
    println!("Created: {}", subject);
    println!("  name: {}", resource.get_name().unwrap_or_default());

    // Edit
    resource.set_name("Updated name");
    resource.save_remote(client.store()).await?;
    println!("  name (after edit): {}", resource.get_name().unwrap_or_default());

    // Fetch from server
    let fetched = client.get_resource(&subject).await?;
    println!("  name (fetched): {}", fetched.get_name().unwrap_or_default());

    println!("Done!");
    Ok(())
}
