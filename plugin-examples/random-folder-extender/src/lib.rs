use atomic_plugin::{ClassExtender, Commit, Resource};
use rand::Rng;

struct RandomFolderExtender;

const FOLDER_CLASS: &str = "https://atomicdata.dev/classes/Folder";
const NAME_PROP: &str = "https://atomicdata.dev/properties/name";

impl ClassExtender for RandomFolderExtender {
    fn class_url() -> String {
        FOLDER_CLASS.to_string()
    }

    // Modify the response from the server every time a folder is fetched.
    // Appends a random number to the end of the folder name.
    fn on_resource_get(resource: &mut Resource) -> Result<Option<&Resource>, String> {
        let base_name = resource
            .props
            .get(NAME_PROP)
            .and_then(|val| val.as_str())
            .unwrap_or("Folder");

        let random_suffix = rand::thread_rng().gen_range(0..=9999);
        let updated_name = format!("{} {}", base_name.trim_end(), random_suffix);

        resource
            .props
            .insert(NAME_PROP.to_string(), updated_name.into());

        Ok(Some(resource))
    }

    // Prevent commits if the folder name contains uppercase letters.
    fn before_commit(commit: &Commit, _snapshot: Option<&Resource>) -> Result<(), String> {
        let Some(set) = &commit.set else {
            return Ok(());
        };

        let Some(name) = set.get(NAME_PROP).and_then(|val| val.as_str()) else {
            return Ok(());
        };

        if name.chars().any(|c| c.is_uppercase()) {
            return Err("Folder name cannot contain uppercase letters".into());
        }

        Ok(())
    }
}

atomic_plugin::export_plugin!(RandomFolderExtender);
