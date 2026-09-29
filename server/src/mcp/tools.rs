//! The read-only tools of the hosted MCP endpoint. They run as the issued
//! agent behind the bearer token, through the same rights checks as any read.

use atomic_lib::{agents::ForAgent, client::search::SearchOpts, urls, Storelike, Subject};
use serde_json::{json, Value};

use super::document_text::document_text;
use crate::appstate::AppState;

const MAX_SUBJECTS: usize = 20;

pub const INSTRUCTIONS: &str = "Tools for reading Atomic Data (a graph of resources, each with a subject such as did:ad:… and properties). This connection is read-only: it can find and read what the person approved, and cannot change it. Start with list_drives or search, then read resources with get_resource.";

pub fn list() -> Value {
    let subjects = json!({
        "type": "array",
        "items": {"type": "string"},
        "minItems": 1,
        "maxItems": MAX_SUBJECTS,
        "description": "Subjects (URLs or did:ad:…) of the resources to read."
    });

    json!([
        {
            "name": "list_drives",
            "title": "List drives",
            "description": "The drives and folders the person shared with this connection.",
            "inputSchema": {"type": "object", "properties": {}},
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "get_resource",
            "title": "Read resources",
            "description": "Read one or more resources by subject. Returns JSON with property shortnames as keys; documents and meetings include their text as `_documentText`. Children of a folder or drive can be found with search (parents) .",
            "inputSchema": {
                "type": "object",
                "properties": {"subjects": subjects},
                "required": ["subjects"]
            },
            "annotations": {"readOnlyHint": true}
        },
        {
            "name": "search",
            "title": "Search",
            "description": "Full-text search for resources by words in their name, description or other text. Matches whole words. Give `parents` (drive or folder subjects) to search inside them; with an empty query it lists everything inside `parents`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Words to search for."},
                    "parents": {"type": "array", "items": {"type": "string"}},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                },
                "required": ["query"]
            },
            "annotations": {"readOnlyHint": true}
        }
    ])
}

/// Runs a tool. `Err` becomes a tool error the model reads.
pub async fn call(
    appstate: &AppState,
    origin: &str,
    agent: &str,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
    let for_agent = ForAgent::AgentSubject(Subject::from_raw(agent, None));

    match name {
        "list_drives" => list_drives(appstate, &for_agent, agent).await,
        "get_resource" => get_resource(appstate, origin, &for_agent, args).await,
        "search" => search(appstate, &for_agent, args).await,
        other => Err(format!("Unknown tool {other}")),
    }
}

async fn title(appstate: &AppState, subject: &str, for_agent: &ForAgent) -> Option<String> {
    let resource = appstate
        .store
        .get_resource_extended(&subject.into(), true, for_agent)
        .await
        .ok()?
        .to_single();

    resource.get(urls::NAME).ok().map(|v| v.to_string())
}

/// What the person shared: resources whose `read` (or `write`) lists this agent.
async fn list_drives(
    appstate: &AppState,
    for_agent: &ForAgent,
    agent: &str,
) -> Result<Value, String> {
    let mut found = Vec::new();

    for (property, editable) in [(urls::READ, false), (urls::WRITE, true)] {
        let opts = SearchOpts {
            limit: Some(100),
            filter_pairs: Some(vec![(property.to_string(), agent.to_string())]),
            ..Default::default()
        };
        for hit in
            atomic_lib::search::query(&appstate.store, "", &opts).map_err(|e| e.to_string())?
        {
            found.push((hit.subject.to_string(), editable));
        }
    }

    let mut out: Vec<Value> = Vec::new();
    for (subject, editable) in found {
        if let Some(existing) = out.iter_mut().find(|v| v["subject"] == subject) {
            if editable {
                existing["canEdit"] = json!(true);
            }
            continue;
        }
        let Some(name) = title(appstate, &subject, for_agent).await else {
            continue;
        };
        out.push(json!({"subject": subject, "name": name, "canEdit": editable}));
    }

    Ok(json!(out))
}

async fn get_resource(
    appstate: &AppState,
    origin: &str,
    for_agent: &ForAgent,
    args: &Value,
) -> Result<Value, String> {
    let subjects: Vec<&str> = args
        .get("subjects")
        .and_then(Value::as_array)
        .ok_or("subjects must be an array")?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if subjects.is_empty() || subjects.len() > MAX_SUBJECTS {
        return Err(format!("Give between 1 and {MAX_SUBJECTS} subjects"));
    }

    let store = appstate.store.clone_with_url(origin.to_string());
    let mut result = serde_json::Map::new();

    for subject in subjects {
        let entry = match store
            .get_resource_extended(&subject.into(), true, for_agent)
            .await
        {
            Ok(response) => {
                let resource = response.to_single();
                let mut json: Value = resource
                    .to_json(&store, Some(origin))
                    .await
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or(Value::Null);

                let is_document = resource.get_classes(&store).await.is_ok_and(|classes| {
                    classes.iter().any(|c| {
                        c.subject.as_str() == "https://atomicdata.dev/classes/DocumentV2"
                            || c.subject.as_str() == "https://atomicdata.dev/classes/Meeting"
                    })
                });
                if is_document {
                    if let (Some(object), Ok(state)) =
                        (json.as_object_mut(), resource.build_state_doc())
                    {
                        let body =
                            serde_json::to_value(state.doc().get_map("doc").get_deep_value())
                                .unwrap_or(Value::Null);
                        object.insert("_documentText".into(), json!(document_text(&body)));
                    }
                }
                json
            }
            // The message is the rights check's or the store's; it says
            // "unauthorized" or "not found" without leaking either way.
            Err(e) => json!(format!("Error: {e}")),
        };
        result.insert(subject.to_string(), entry);
    }

    Ok(Value::Object(result))
}

async fn search(appstate: &AppState, for_agent: &ForAgent, args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .ok_or("query must be a string")?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(10)
        .clamp(1, 50) as usize;
    let parents = args.get("parents").and_then(Value::as_array).map(|list| {
        list.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>()
    });

    // More than asked for: the agent may not read some of what matches.
    let opts = SearchOpts {
        limit: Some((limit * 3) as u32),
        parents,
        ..Default::default()
    };
    let hits =
        atomic_lib::search::query(&appstate.store, query, &opts).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for hit in hits {
        if out.len() >= limit {
            break;
        }
        let subject = hit.subject.to_string();
        let Ok(response) = appstate
            .store
            .get_resource_extended(&subject.as_str().into(), true, for_agent)
            .await
        else {
            continue;
        };
        let resource = response.to_single();
        out.push(json!({
            "subject": subject,
            "name": resource.get(urls::NAME).ok().map(|v| v.to_string()),
        }));
    }

    Ok(json!(out))
}
