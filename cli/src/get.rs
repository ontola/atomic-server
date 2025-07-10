use crate::{print::print_resource, Context, SerializeOptions};
use atomic_lib::{errors::AtomicResult, Storelike};

pub fn get_resource(
    context: &mut Context,
    subject: &str,
    serialize: &SerializeOptions,
) -> AtomicResult<()> {
    context.read_config();

    let store = &mut context.store;
    let fetched = store.fetch_resource(subject, store.get_default_agent().ok().as_ref())?;
    print_resource(context, &fetched, serialize)?;

    Ok(())
}
