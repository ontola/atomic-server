use atomic_plugin::{ClassExtender, Resource};
use serde::Deserialize;

struct TestPlugin;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    folder_prefix: String,
}

const FOLDER_CLASS: &str = "https://atomicdata.dev/classes/Folder";
const BIRD_CLASS: &str =
    "https://atomicdata.dev/01k10mtpp8fkkmsd6tkm9qrqyw/defaultontology/class/bird";
const NAME_PROP: &str = "https://atomicdata.dev/properties/name";

impl ClassExtender for TestPlugin {
    fn class_url() -> Vec<String> {
        vec![FOLDER_CLASS.to_string(), BIRD_CLASS.to_string()]
    }

    // Modify the response from the server every time a folder is fetched.
    // Appends a random number to the end of the folder name.
    fn on_resource_get(resource: &mut Resource) -> Result<Option<&Resource>, String> {
        let config = atomic_plugin::get_config::<Config>()?;

        let base_name = resource
            .props
            .get(NAME_PROP)
            .and_then(|val| val.as_str())
            .unwrap_or("Folder");

        let updated_name = format!("{} {}", config.folder_prefix, base_name.trim_start());

        resource
            .props
            .insert(NAME_PROP.to_string(), updated_name.into());

        Ok(Some(resource))
    }
}

atomic_plugin::export_plugin!(TestPlugin);
