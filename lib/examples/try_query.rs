use atomic_lib::errors::AtomicResult;
use atomic_lib::{storelike::Query, Store, Storelike};

fn main() -> AtomicResult<()> {
    // Initialize a new store
    let store = Store::init()?;
    // Populate it with some default data
    store.populate()?;

    // Create a query for all resources that are instances of the Class class
    let mut query = Query::new_class("https://atomicdata.dev/classes/Class");
    // Include resources from other servers as well
    query.include_external = true;

    // Execute the query
    let result = store.query(&query)?;

    println!("Found {} instances of Class:", result.subjects.len());

    // Iterate through all found resources
    for subject in result.subjects {
        // Get the full resource
        match store.get_resource(&subject) {
            Ok(resource) => {
                // Try to get the shortname and description
                let shortname = resource
                    .get_shortname("shortname", &store)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| "No shortname".to_string());

                let description = resource
                    .get_shortname("description", &store)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|_| "No description".to_string());

                println!("\nClass: {}", shortname);
                println!("Subject: {}", subject);
                println!("Description: {}", description);
            }
            Err(e) => eprintln!("Error fetching resource {}: {}", subject, e),
        }
    }

    Ok(())
}
