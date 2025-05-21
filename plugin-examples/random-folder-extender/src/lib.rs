use atomic_plugin::{ClassExtender, Commit, Resource};
use rand::Rng;
use serde::Serialize;
use waki::Client;

struct RandomFolderExtender;

#[derive(Serialize)]
struct DiscordWebhookBody {
    content: String,
}

const FOLDER_CLASS: &str = "https://atomicdata.dev/classes/Folder";
const NAME_PROP: &str = "https://atomicdata.dev/properties/name";
const IS_A: &str = "https://atomicdata.dev/properties/isA";
const DISCORD_WEBHOOK_URL: &str = "<YOUR DISCORD WEBHOOK URL>";

fn get_name_from_folder(folder: &Resource) -> Result<&str, String> {
    let name = folder
        .props
        .get(NAME_PROP)
        .and_then(|val| val.as_str())
        .ok_or("Folder name not found")?;

    Ok(name)
}

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

    // Enforce that folder names are unique. It looks up all folders and checks if any of them have the same name.
    fn before_commit(commit: &Commit, _snapshot: Option<&Resource>) -> Result<(), String> {
        let Some(set) = &commit.set else {
            return Ok(());
        };

        let Some(name) = set.get(NAME_PROP).and_then(|val| val.as_str()) else {
            return Ok(());
        };

        let all_folders = atomic_plugin::query(IS_A.to_string(), FOLDER_CLASS.to_string(), None)?;
        let all_names: Vec<&str> = all_folders
            .iter()
            .filter_map(|folder| get_name_from_folder(folder).ok())
            .collect();

        if all_names.contains(&name) {
            return Err("Folder name must be unique".into());
        }

        Ok(())
    }

    // Send a message to a Discord webhook when a folder is updated.
    fn after_commit(_commit: &Commit, resource: Option<&Resource>) -> Result<(), String> {
        let Some(resource) = resource else {
            return Ok(());
        };

        let name = get_name_from_folder(resource)?;
        let client = Client::new();

        let body = DiscordWebhookBody {
            content: format!("📁 [Folder]({}) updated: {}", resource.subject, name),
        };

        let res = client
            .post(DISCORD_WEBHOOK_URL)
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
            .send()
            .map_err(|e| e.to_string())?;

        println!("Response: {:?}", res.status_code());
        Ok(())
    }
}

atomic_plugin::export_plugin!(RandomFolderExtender);
