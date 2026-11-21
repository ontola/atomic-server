use std::path::PathBuf;

use actix_web::{http::header, web, HttpResponse};
use atomic_lib::{
    agents::ForAgent,
    db::plugin_meta::{validate_plugin_identifiers, PluginMetaKey},
    urls, Storelike, Value,
};
use base64::{engine::general_purpose, Engine as _};

use crate::{appstate::AppState, errors::AtomicServerResult, helpers::get_client_agent};

#[derive(serde::Deserialize, Debug)]
pub struct PluginUiQuery {
    pub drive: String,
    pub plugin: String,
    pub format: String,
}

#[derive(serde::Deserialize, Debug)]
pub struct UIPluginListQuery {
    pub drive: String,
}

#[derive(serde::Serialize, Debug)]
pub struct PluginUIManifest {
    pub css: bool,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UIPluginListItem {
    pub plugin: String,
    pub classes: Vec<String>,
    pub ui_manifest: PluginUIManifest,
    pub resource: String,
}

fn plugin_key(drive: &str, plugin: &str) -> AtomicServerResult<PluginMetaKey> {
    let (namespace, name) = plugin.split_once('.').ok_or("Expected namespace.name")?;
    validate_plugin_identifiers(namespace, name)?;
    Ok(PluginMetaKey::new(drive, namespace, name))
}

fn get_plugin_file_path(
    appstate: &AppState,
    drive_subject: &str,
    plugin_name: &str,
    format: &str,
) -> AtomicServerResult<PathBuf> {
    let encoded_drive = general_purpose::URL_SAFE.encode(drive_subject);

    let plugin_dir = appstate
        .config
        .plugin_path
        .join("class-extenders")
        .join("scoped")
        .join(encoded_drive);

    let extension = match format {
        "js" => "js",
        "css" => "css",
        _ => return Err("Invalid format".into()),
    };

    let file_name = format!("{}.ui.{}", plugin_name, extension);
    let file_path = plugin_dir.join(file_name);

    Ok(file_path)
}

/// The frame has a separate CSP from the application. Its HTTP sandbox also
/// applies when the document is opened directly. Only the parent fetches assets.
fn plugin_frame() -> AtomicServerResult<HttpResponse> {
    let nonce = super::single_page_app::generate_nonce().map_err(|_| "Failed to generate nonce")?;
    let policy = format!(
        "sandbox allow-scripts allow-downloads allow-pointer-lock allow-presentation; \
         default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; \
         img-src * data:; connect-src *; font-src *; base-uri 'none'; object-src 'none'"
    );
    Ok(HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .insert_header((header::CONTENT_SECURITY_POLICY, policy))
        .insert_header((header::CACHE_CONTROL, "no-store"))
        .body(include_str!("plugin_frame.html").replace("ATOMIC_FRAME_NONCE", &nonce)))
}

async fn plugin_request_agent(
    req: &actix_web::HttpRequest,
    appstate: &AppState,
) -> AtomicServerResult<ForAgent> {
    let url = format!("{}{}", appstate.store.get_server_url()?, req.uri());
    get_client_agent(req.headers(), appstate, url).await
}

/// Serves the empty sandbox shell or one asset of a readable plugin.
#[tracing::instrument(skip(appstate, req))]
pub async fn handle_plugin_ui(
    _path: Option<web::Path<String>>,
    appstate: web::Data<AppState>,
    query: web::Query<PluginUiQuery>,
    req: actix_web::HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let drive_subject = &query.drive;
    let plugin_name = &query.plugin;
    let format = &query.format;

    let Ok(key) = plugin_key(drive_subject, plugin_name) else {
        return Ok(HttpResponse::BadRequest().body("Expected plugin identifier namespace.name"));
    };
    let content_type = match format.as_str() {
        "html" => return plugin_frame(),
        "js" => "application/javascript",
        "css" => "text/css",
        _ => return Ok(HttpResponse::BadRequest().body("Invalid plugin format")),
    };
    let agent = plugin_request_agent(&req, &appstate).await?;
    let Some(meta) = appstate.store.get_plugin_meta(&key)? else {
        return Ok(HttpResponse::NotFound().finish());
    };
    let resource = appstate.store.get_resource(&meta.subject).await?;
    atomic_lib::hierarchy::check_read(&appstate.store, &resource, &agent).await?;
    let file_path = get_plugin_file_path(&appstate, drive_subject, plugin_name, format)?;

    let content = match std::fs::read_to_string(file_path) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HttpResponse::NotFound().finish())
        }
        Err(err) => return Err(format!("Failed to read plugin UI: {err}").into()),
    };

    Ok(HttpResponse::Ok()
        .content_type(content_type)
        .insert_header((header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"))
        .insert_header((header::CACHE_CONTROL, "private, no-store"))
        .body(content))
}

pub async fn handle_plugin_list(
    _path: Option<web::Path<String>>,
    appstate: web::Data<AppState>,
    query: web::Query<UIPluginListQuery>,
    req: actix_web::HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let store = &appstate.store;
    let drive_subject = &query.drive;

    let agent = plugin_request_agent(&req, &appstate).await?;
    let plugins = store.get_class_extenders_on_drive(drive_subject);
    let mut plugin_list: Vec<UIPluginListItem> = vec![];

    for plugin in plugins {
        let Some(subject) = plugin.subject else {
            continue;
        };

        let resource = store.get_resource(&subject).await?;
        if atomic_lib::hierarchy::check_read(store, &resource, &agent)
            .await
            .is_err()
        {
            continue;
        }

        let Ok(Value::String(name)) = resource.get(urls::NAME) else {
            continue;
        };

        let Ok(Value::String(namespace)) = resource.get(urls::NAMESPACE) else {
            continue;
        };

        if validate_plugin_identifiers(namespace, name).is_err() {
            continue;
        }
        let plugin_name = format!("{}.{}", namespace, name);
        let js_file_path = get_plugin_file_path(&appstate, drive_subject, &plugin_name, "js")?;
        let css_file_path = get_plugin_file_path(&appstate, drive_subject, &plugin_name, "css")?;

        let Some(meta) =
            store.get_plugin_meta(&PluginMetaKey::new(drive_subject, &namespace, &name))?
        else {
            tracing::warn!("Plugin {} has no metadata", plugin_name);
            continue;
        };

        if meta.subject != subject || !js_file_path.exists() {
            continue;
        }

        plugin_list.push(UIPluginListItem {
            plugin: plugin_name,
            classes: plugin.classes,
            ui_manifest: PluginUIManifest {
                css: css_file_path.exists(),
            },
            resource: meta.subject,
        });
    }

    Ok(HttpResponse::Ok()
        .insert_header((header::CACHE_CONTROL, "private, no-store"))
        .json(plugin_list))
}

#[cfg(test)]
mod tests {
    use super::plugin_frame;
    use actix_web::{body::to_bytes, http::header};

    #[actix_web::test]
    async fn plugin_frame_has_an_opaque_origin_and_its_own_nonce() {
        let response = plugin_frame().unwrap();
        let other = plugin_frame().unwrap();
        let policy = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        let second = other
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert_ne!(policy, second);
        let sandbox = policy
            .split(';')
            .find(|d| d.trim().starts_with("sandbox "))
            .unwrap();
        assert!(sandbox.split_whitespace().any(|p| p == "allow-scripts"));
        assert!(!sandbox.split_whitespace().any(|p| p == "allow-same-origin"));
        let nonce = policy
            .split("script-src 'nonce-")
            .nth(1)
            .unwrap()
            .split('\'')
            .next()
            .unwrap();
        let script_open = format!(r#"<script nonce="{nonce}">"#);
        let html = to_bytes(response.into_body()).await.unwrap();
        assert!(std::str::from_utf8(&html).unwrap().contains(&script_open));
    }
}
