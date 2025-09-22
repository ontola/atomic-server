use atomic_lib::errors::AtomicResult;
use atomic_lib::{agents::ForAgent, Store, Storelike};

fn main() -> AtomicResult<()> {
    // Initialize a new store and populate with default data
    let store = Store::init()?;
    store.populate()?;

    // Example paths to query
    let paths = vec![
        // Get a Class and its description
        "https://atomicdata.dev/classes/Agent description",
        // Get all required properties for the Agent class
        "https://atomicdata.dev/classes/Agent requires",
        // Get the shortname of a Property
        "https://atomicdata.dev/properties/description shortname",
    ];

    println!("Querying paths in Atomic Data store:\n");

    for path_str in paths {
        println!("Path: {}", path_str);

        // Get the path result
        match store.get_path(
            path_str,
            None,            // No mapping needed for these examples
            &ForAgent::Sudo, // Using sudo rights for this example
        )? {
            atomic_lib::storelike::PathReturn::Subject(subject) => {
                // If the path returns a full resource
                let resource = store.get_resource_extended(&subject, false, &ForAgent::Sudo)?;
                println!("Found resource: {}", resource.get_subject());

                // Print some basic properties if they exist
                if let Ok(shortname) = resource.get_shortname("shortname", &store) {
                    println!("Shortname: {}", shortname);
                }
                if let Ok(description) = resource.get_shortname("description", &store) {
                    println!("Description: {}", description);
                }
            }
            atomic_lib::storelike::PathReturn::Atom(atom) => {
                // If the path returns a single value
                println!("Found value: {}", atom.value);
            }
        }
        println!("\n---\n");
    }

    // Example of using paths to traverse nested data
    let nested_path = "https://atomicdata.dev/classes/Class requires 0 shortname";
    println!("Querying nested path: {}", nested_path);

    match store.get_path(nested_path, None, &ForAgent::Sudo)? {
        atomic_lib::storelike::PathReturn::Atom(atom) => {
            println!("First required property shortname: {}", atom.value);
        }
        _ => println!("Unexpected return type"),
    }

    Ok(())
}
