mod bindings;

use bindings::example::random_folder_extender::types::ResourceJson;
use bindings::{CommitContext, GetContext, Guest, ResourceResponse};
use rand::Rng;
use serde_json::{json, Value as JsonValue};

bindings::__export_world_folder_extender_cabi!(RandomFolderExtender with_types_in bindings);

struct RandomFolderExtender;

const FOLDER_CLASS: &str = "https://atomicdata.dev/classes/Folder";
const NAME_PROP: &str = "https://atomicdata.dev/properties/name";

impl Guest for RandomFolderExtender {
    fn class_url() -> String {
        FOLDER_CLASS.to_string()
    }

    fn on_resource_get(ctx: GetContext) -> Result<Option<ResourceResponse>, String> {
        let mut json_value: JsonValue =
            serde_json::from_str(&ctx.snapshot.json_ad).map_err(|e| e.to_string())?;
        let Some(obj) = json_value.as_object_mut() else {
            return Err("Snapshot is not a JSON object".into());
        };

        let base_name = obj
            .get(NAME_PROP)
            .and_then(|val| val.as_str())
            .unwrap_or("Folder");

        let random_suffix = rand::thread_rng().gen_range(0..=9999);
        let updated_name = format!("{} {}", base_name.trim_end(), random_suffix);

        obj.insert(NAME_PROP.to_string(), json!(updated_name));
        let updated_payload =
            serde_json::to_string(&json_value).map_err(|e| format!("Serialize error: {e}"))?;

        Ok(Some(ResourceResponse {
            primary: ResourceJson {
                subject: ctx.snapshot.subject,
                json_ad: updated_payload,
            },
            referenced: Vec::new(),
        }))
    }

    fn before_commit(_ctx: CommitContext) -> Result<(), String> {
        Ok(())
    }

    fn after_commit(_ctx: CommitContext) -> Result<(), String> {
        Ok(())
    }
}
