//! Basic example: create an agent, a drive, a resource, and edit it.
//!
//! Requires AtomicServer running at localhost:9883.
//!
//! Run with: cargo run --example basic -p atomic_lib

use atomic_lib::client::connected::Client;
use atomic_lib::errors::AtomicResult;

#[tokio::main]
async fn main() -> AtomicResult<()> {
    // Connect to the server
    let client = Client::new("http://localhost:9883").await?;

    // Create a new agent identity
    let agent = client.new_agent("Alice").await?;
    println!("Agent: {}", agent.subject);

    // Create a drive (owned by this agent)
    let drive = client.new_drive(&agent, "Alice's Drive").await?;
    println!("Drive: {}", drive);

    // Create a new resource in the drive
    let mut resource = client.new_resource(&drive);
    resource.set_name("My first resource")?;
    resource.set_string(
        "https://atomicdata.dev/properties/description",
        "Created with atomic_lib",
    )?;
    resource.set(
        "https://atomicdata.dev/properties/isA",
        &atomic_lib::Value::ResourceArray(vec![
            "https://atomicdata.dev/classes/Thing".into(),
        ]),
    )?;

    // Save to the server (this creates a genesis commit)
    let subject = resource.save(&client, &agent).await?;
    println!("Created: {}", subject);
    println!("  name: {}", resource.get_name().unwrap_or_default());

    // Edit the resource
    resource.set_name("Updated name")?;
    resource.save(&client, &agent).await?;
    println!("  name (after edit): {}", resource.get_name().unwrap_or_default());

    // Fetch it back from the server to verify persistence
    let fetched = client.get_resource(&subject).await?;
    println!("  name (fetched): {}", fetched.get_name().unwrap_or_default());

    println!("Done!");
    Ok(())
}
