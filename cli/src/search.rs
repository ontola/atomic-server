use atomic_lib::{errors::AtomicResult, Storelike};

use crate::print::print_resource;

pub fn search(
    context: &crate::Context,
    query: String,
    parent: Option<String>,
    serialize: &crate::SerializeOptions,
) -> AtomicResult<()> {
    context.read_config();
    let opts = atomic_lib::client::search::SearchOpts {
        limit: Some(10),
        include: Some(true),
        parents: Some(vec![parent.unwrap_or_default()]),
        ..Default::default()
    };
    let resources = context.store.search(&query, opts)?;
    if resources.is_empty() {
        println!("No results found for query: {}", query);
        return Ok(());
    } else {
        for member in resources {
            print_resource(context, &member, serialize)?;
        }
    }
    Ok(())
}
