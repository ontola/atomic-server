use atomic_plugin::AtomicPlugin;
use rand::Rng;
use serde_json::{json, Value as JsonValue};

struct RandomFolderExtender;

const FOLDER_CLASS: &str = "https://atomicdata.dev/classes/Folder";
const NAME_PROP: &str = "https://atomicdata.dev/properties/name";

impl AtomicPlugin for RandomFolderExtender {
    fn class_url() -> String {
        FOLDER_CLASS.to_string()
    }

    fn on_resource_get(
        _subject: &str,
        resource: &mut JsonValue,
    ) -> Result<Option<JsonValue>, String> {
        let Some(obj) = resource.as_object_mut() else {
            return Err("Resource is not a JSON object".into());
        };

        let base_name = obj
            .get(NAME_PROP)
            .and_then(|val| val.as_str())
            .unwrap_or("Folder");

        let random_suffix = rand::thread_rng().gen_range(0..=9999);
        let updated_name = format!("{} {}", base_name.trim_end(), random_suffix);

        obj.insert(NAME_PROP.to_string(), json!(updated_name));
        Ok(Some(resource.clone()))
    }
}

atomic_plugin::export_plugin!(RandomFolderExtender);
