use atomic_plugin::{ClassExtender, Commit, CommitBuilder, Resource};
use serde::Deserialize;
use serde_json::Value as JsonValue;

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

    fn after_commit(commit: &Commit, resource: &Resource, _is_new: bool) -> Result<(), String> {
        if !resource.is_a(FOLDER_CLASS) {
            return Ok(());
        }
        let config = atomic_plugin::get_config::<Config>()?;
        let prefix = config.folder_prefix.trim();
        if prefix.is_empty() {
            return Ok(());
        }
        let current_name = resource
            .props
            .get(NAME_PROP)
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let prefix_with_space = format!("{} ", prefix);
        if current_name.starts_with(&prefix_with_space) {
            return Ok(());
        }
        let target = format!("{} {}", prefix, current_name.trim_start());
        let mut builder = CommitBuilder::new(commit.subject.clone());
        builder.set(NAME_PROP.to_string(), JsonValue::String(target));
        atomic_plugin::commit(&builder)?;
        Ok(())
    }
}

atomic_plugin::export_plugin!(TestPlugin);
