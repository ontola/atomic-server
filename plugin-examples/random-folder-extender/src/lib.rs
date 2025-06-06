use atomic_plugin::{ClassExtender, Commit, CommitBuilder, Resource};
use rand::seq::SliceRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};
use waki::Client;

struct RandomFolderExtender;

#[derive(Serialize)]
struct DiscordWebhookBody {
    content: String,
}

#[derive(Deserialize)]
struct Config {
    #[serde(rename = "discordWebhookUrl")]
    discord_webhook_url: String,
    #[serde(rename = "updateMessage")]
    update_message: String,
    #[serde(rename = "blacklistedFolderNames")]
    blacklisted_folder_names: Option<Vec<String>>,
}

const FOLDER_CLASS: &str = "https://atomicdata.dev/classes/Folder";
const NAME_PROP: &str = "https://atomicdata.dev/properties/name";
const IS_A: &str = "https://atomicdata.dev/properties/isA";

fn get_name_from_folder(folder: &Resource) -> Result<&str, String> {
    let name = folder
        .props
        .get(NAME_PROP)
        .and_then(|val| val.as_str())
        .ok_or("Folder name not found")?;

    Ok(name)
}

impl ClassExtender for RandomFolderExtender {
    fn class_url() -> Vec<String> {
        vec![FOLDER_CLASS.to_string()]
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
    fn before_commit(commit: &Commit, _snapshot: &Resource) -> Result<(), String> {
        let Some(set) = &commit.set else {
            return Ok(());
        };

        let Some(name) = set.get(NAME_PROP).and_then(|val| val.as_str()) else {
            return Ok(());
        };

        let all_folders = atomic_plugin::query(IS_A.to_string(), FOLDER_CLASS.to_string())?;
        let all_names: Vec<&str> = all_folders
            .iter()
            .filter_map(|folder| get_name_from_folder(folder).ok())
            .collect();

        if all_names.contains(&name) {
            return Err("Folder name must be unique".into());
        }

        let config = atomic_plugin::get_config::<Config>()
            .map_err(|_| "Could not parse plugin config".to_string())?;

        // Check if the folder name is in the blacklist.
        if config.blacklisted_folder_names.is_some()
            && config
                .blacklisted_folder_names
                .unwrap()
                .contains(&name.to_string())
        {
            return Err("Folder name is not allowed".into());
        }

        Ok(())
    }

    // Send a message to a Discord webhook when a folder is updated.
    fn after_commit(_commit: &Commit, resource: &Resource) -> Result<(), String> {
        // Shuffle the name of the folder
        let name = get_name_from_folder(resource)?;
        let shuffled_name = shuffle_string(name);

        // Commit the shuffled name to persist the change.
        let mut commit_builder = CommitBuilder::new(resource.subject.clone());
        commit_builder.set(NAME_PROP.to_string(), shuffled_name.clone().into());

        atomic_plugin::commit(&commit_builder)?;

        // Announce the update to a Discord server.
        let config = atomic_plugin::get_config::<Config>()
            .map_err(|_| "Could not parse plugin config".to_string())?;
        let client = Client::new();

        let body = DiscordWebhookBody {
            content: config
                .update_message
                .replace("{{name}}", &shuffled_name)
                .replace("{{subject}}", &resource.subject),
        };

        let res = client
            .post(&config.discord_webhook_url)
            .header("Content-Type", "application/json")
            .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
            .send()
            .map_err(|e| e.to_string())?;

        println!("Response: {:?}", res.status_code());
        Ok(())
    }
}

fn shuffle_string(string: &str) -> String {
    let mut chars = string.chars().collect::<Vec<char>>();
    let mut rng = rand::thread_rng();
    chars.shuffle(&mut rng);
    chars.into_iter().collect()
}

atomic_plugin::export_plugin!(RandomFolderExtender);
