//! Parsing / deserialization / decoding

use crate::{
    agents::ForAgent, commit::CommitOpts, datatype::DataType, errors::AtomicResult,
    resources::PropVals, urls, utils::check_valid_url, values::SubResource, AtomicError, Resource,
    Storelike, Value,
};

pub const JSON_AD_MIME: &str = "application/ad+json";

#[cfg(target_arch = "wasm32")]
type AsyncResult<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + 'a>>;
#[cfg(not(target_arch = "wasm32"))]
type AsyncResult<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

pub fn parse_json_array(string: &str) -> AtomicResult<Vec<String>> {
    let vector: Vec<String> = serde_json::from_str(string)?;
    Ok(vector)
}

use serde_json::Map;

/// Options for parsing (JSON-AD) resources.
/// Many of these are related to rights, as parsing often implies overwriting / setting resources.
#[derive(Debug, Clone)]
pub struct ParseOpts {
    /// Subject of the parent / Importer. This is where all the imported data will be placed under, hierarchically.
    /// If imported resources do not have an `@id`, we create new `@id` using the `localId` and the `parent`.
    /// If the importer resources already have a `parent` set, we'll use that one.
    pub importer: Option<crate::Subject>,
    /// Who's rights will be checked when creating the imported resources.
    /// Is only used when `save` is set to [SaveOpts::Commit].
    /// If [None] is passed, all resources will be
    pub for_agent: ForAgent,
    /// Who will perform the importing. If set to none, all possible commits will be signed by the default agent.
    /// Note that this Agent needs a private key to sign the commits.
    /// Is only used when `save` is set to `Commit`.
    pub signer: Option<crate::agents::Agent>,
    /// How you want to save the Resources, if you want to add Commits for every Resource.
    pub save: SaveOpts,
    /// Overwrites existing resources with the same `@id`, even if they are not children of the `importer`.
    /// This can be a dangerous value if true, because it can overwrite _all_ resources where the `for_agen` has write rights.
    /// Only parse items from sources that you trust!
    pub overwrite_outside: bool,
    /// If true, silently skip properties whose definition cannot be found in the store.
    /// The skipped properties will NOT be stored or indexed.
    /// Useful for client-side seeding where not all property definitions are available.
    pub skip_unknown_props: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SaveOpts {
    /// Don't save the parsed resources to the store.
    /// No authorization checks will be performed.
    DontSave,
    /// Save the parsed resources to the store, but don't create Commits for every change.
    /// Removes existing properties that are not present in the imported resource.
    /// Does not perform authorization checks.
    Save,
    /// Create Commits for every change.
    /// Does not remove existing properties.
    /// Performs authorization cheks (if enabled)
    Commit,
}

impl std::default::Default for ParseOpts {
    fn default() -> Self {
        Self {
            signer: None,
            importer: None,
            for_agent: ForAgent::Sudo,
            overwrite_outside: true,
            save: SaveOpts::Save,
            skip_unknown_props: false,
        }
    }
}

/// Parse a single Json AD string, convert to Atoms
/// WARNING: Does not match all props to datatypes (in Nested Resources),
/// so it could result in invalid data, if the input data does not match the required datatypes.
#[tracing::instrument(skip_all)]
pub async fn parse_json_ad_resource(
    string: &str,
    store: &impl crate::Storelike,
    parse_opts: &ParseOpts,
) -> AtomicResult<Resource> {
    let json: Map<String, serde_json::Value> = serde_json::from_str(string)?;
    parse_json_ad_map_to_resource(json, store, None, parse_opts).await
}

fn object_is_property(object: &serde_json::Value) -> bool {
    if let serde_json::Value::Object(map) = object {
        if let Some(serde_json::Value::Array(arr)) = map.get(urls::IS_A) {
            for item in arr {
                if let serde_json::Value::String(s) = item {
                    if s == urls::PROPERTY {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn get_parent_to_pull(value: &serde_json::Value) -> Option<String> {
    if let serde_json::Value::Object(map) = value {
        if let Some(serde_json::Value::String(s)) = map.get(urls::PARENT) {
            if check_valid_url(s).is_err() {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn find_parent_in_array(
    parent_subject: &str,
    array: &Vec<serde_json::Value>,
) -> Option<serde_json::Value> {
    for value in array {
        let serde_json::Value::Object(object) = value else {
            continue;
        };

        let Some(serde_json::Value::String(s)) = object.get(&urls::LOCAL_ID.to_string()) else {
            continue;
        };

        if s == parent_subject {
            return Some(value.clone());
        }
    }
    None
}

/// Loops over the array, for each property check if their parent is a local_id. If true find the parent and move it to the front of the array.
fn pull_parents_of_props_to_front(array: &Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut new_vec: Vec<serde_json::Value> = Vec::new();

    for value in array {
        if object_is_property(value) {
            if let Some(parent_subject) = get_parent_to_pull(value) {
                if let Some(parent) = find_parent_in_array(&parent_subject, array) {
                    new_vec.insert(0, parent);
                }
            }
        }

        if !new_vec.contains(value) {
            new_vec.push(value.clone());
        }
    }

    new_vec
}

/// Parses JSON-AD string.
/// Accepts an array containing multiple objects, or one single object.
#[tracing::instrument(skip_all)]
pub async fn parse_json_ad_string(
    string: &str,
    store: &impl Storelike,
    parse_opts: &ParseOpts,
) -> AtomicResult<Vec<Resource>> {
    let parsed: serde_json::Value = serde_json::from_str(string)
        .map_err(|e| AtomicError::parse_error(&format!("Invalid JSON: {}", e), None, None))?;
    let mut vec = Vec::new();
    match parsed {
        serde_json::Value::Array(mut arr) => {
            // Move all properties to the front of the array because some of the other resouces might use these properties.
            arr.sort_by(|a, b| {
                let a_is_prop = object_is_property(a);
                let b_is_prop = object_is_property(b);
                b_is_prop.cmp(&a_is_prop)
            });

            // Also move the parents of the properties to the front when they are included in the data.
            arr = pull_parents_of_props_to_front(&arr);

            for item in arr {
                match item {
                    serde_json::Value::Object(obj) => {
                        let resource = parse_json_ad_map_to_resource(obj, store, None, parse_opts)
                            .await
                            .map_err(|e| format!("Unable to process resource in array. {}", e))?;
                        vec.push(resource);
                    }
                    wrong => {
                        return Err(
                            format!("Wrong datatype, expected object, got: {:?}", wrong).into()
                        )
                    }
                }
            }
        }
        serde_json::Value::Object(obj) => vec.push(
            parse_json_ad_map_to_resource(obj, store, None, parse_opts)
                .await
                .map_err(|e| format!("Unable to parse object. {}", e))?,
        ),
        _other => return Err("Root JSON element must be an object or array.".into()),
    }

    Ok(vec)
}

/// Parse a single Json AD string that represents an incoming Commit.
/// WARNING: Does not match all props to datatypes (in Nested Resources), so it could result in invalid data,
/// if the input data does not match the required datatypes.
#[tracing::instrument(skip_all)]
pub async fn parse_json_ad_commit_resource(
    string: &str,
    store: &impl crate::Storelike,
) -> AtomicResult<Resource> {
    let mut json: Map<String, serde_json::Value> = serde_json::from_str(string)?;

    // Get the signature - this is required for all commits
    let signature = json
        .get(urls::SIGNATURE)
        .ok_or("No signature field in Commit.")?
        .as_str()
        .ok_or("Signature must be a string")?
        .to_string();

    // Get or derive the subject.
    // For genesis commits the client omits the subject; it is always derived
    // from the signature as `did:ad:<signature>`.
    let _target_subject = match json.get(urls::SUBJECT) {
        Some(subj) => subj.as_str().ok_or("Subject must be a string")?.to_string(),
        None => {
            let derived_subject = format!("did:ad:{}", signature);

            // Insert the derived subject into the JSON so it gets parsed correctly
            json.insert(
                urls::SUBJECT.to_string(),
                serde_json::Value::String(derived_subject.clone()),
            );

            derived_subject
        }
    };

    // The canonical commit subject is always derived from the signature.
    // Drop any client-supplied `@id` / `localId` first — `to_json_ad`
    // serialises commits with their `@id` filled in, but the inner parser
    // rejects an `@id` whenever an overwrite subject is also passed (it
    // would otherwise leave the on-disk subject ambiguous between the
    // two). Removing them here keeps the contract: signature-derived
    // subject wins, body's `@id` is informational only.
    json.remove("@id");
    json.remove(urls::LOCAL_ID);
    let commit_subject = format!("did:ad:commit:{}", signature);

    let resource =
        parse_json_ad_map_to_resource(json, store, Some(commit_subject), &ParseOpts::default())
            .await?;

    Ok(resource)
}

/// Converts a string to a URL (subject), check for localid.
/// For DID parents the synthesised subject doesn't exist, so we look up
/// an existing imported resource by (parent, localId).
async fn try_to_subject(
    subject: &str,
    prop: &str,
    store: &impl crate::Storelike,
    parse_opts: &ParseOpts,
) -> AtomicResult<String> {
    if check_valid_url(subject).is_ok() {
        Ok(subject.into())
    } else if let Some(importer) = &parse_opts.importer {
        if let Some(synth) = generate_id_from_local_id(importer, subject) {
            Ok(synth)
        } else if let Some(found) =
            find_existing_by_local_id(store, importer, subject).await?
        {
            Ok(found)
        } else {
            Err(AtomicError::parse_error(
                &format!(
                    "Cannot resolve `localId` cross-reference {subject:?} \
                     under DID parent {importer}: target must be imported \
                     first or referenced by full @id."
                ),
                None,
                Some(prop),
            ))
        }
    } else {
        Err(AtomicError::parse_error(
            &format!("Unable to parse string as URL: {}", subject),
            None,
            Some(prop),
        ))
    }
}

/// Looks up the subject of an already-imported resource matching
/// (parent, localId). Used for re-import idempotency under DID parents.
async fn find_existing_by_local_id(
    store: &impl crate::Storelike,
    parent: &crate::Subject,
    local_id: &str,
) -> AtomicResult<Option<String>> {
    let mut query = crate::storelike::Query::new_prop_val(urls::LOCAL_ID, local_id);
    query.for_agent = crate::agents::ForAgent::Sudo;
    let result = store.query(&query).await?;
    let parent_str = parent.as_str();
    for resource in result.resources {
        match resource.get(urls::PARENT) {
            Ok(crate::Value::AtomicUrl(p)) if p.as_str() == parent_str => {
                return Ok(Some(resource.get_subject().to_string()));
            }
            Ok(crate::Value::String(p)) if p == parent_str => {
                return Ok(Some(resource.get_subject().to_string()));
            }
            _ => {}
        }
    }
    Ok(None)
}

fn parse_anonymous_resource<'a>(
    map: &'a Map<String, serde_json::Value>,
    subject: Option<&'a str>,
    store: &'a impl crate::Storelike,
    parse_opts: &'a ParseOpts,
) -> AsyncResult<'a, AtomicResult<PropVals>> {
    Box::pin(async move {
        let mut propvals = PropVals::new();

        for (prop, val) in map {
            if prop == "@id" || prop == urls::LOCAL_ID {
                return Err(AtomicError::parse_error(
                    "`@id` and `localId` are not allowed in anonymous resources",
                    subject,
                    Some(prop),
                ));
            }

            let (updated_key, atomic_val) =
                parse_propval(prop, val, subject, store, parse_opts).await?;
            propvals.insert(updated_key.to_string(), atomic_val);
        }

        Ok(propvals)
    })
}

pub fn parse_propval<'a>(
    key: &'a str,
    val: &'a serde_json::Value,
    subject: Option<&'a str>,
    store: &'a impl crate::Storelike,
    parse_opts: &'a ParseOpts,
) -> AsyncResult<'a, AtomicResult<(String, Value)>> {
    Box::pin(async move {
        let prop = try_to_subject(key, key, store, parse_opts).await?;
        let property = store.get_property(&prop).await?;

        let atomic_val: Value = match property.data_type {
            DataType::AtomicUrl => {
                match val {
                    serde_json::Value::String(str) => {
                        // If the value is not a valid URL, and we have an importer, we can generate_id_from_local_id
                        let url = try_to_subject(str, &prop, store, parse_opts).await?;
                        Value::new(&url, &property.data_type)?
                    }
                    serde_json::Value::Object(map) => {
                        let propvals =
                            parse_anonymous_resource(map, subject, store, parse_opts).await?;
                        Value::NestedResource(SubResource::Nested(propvals))
                    }
                    _ => {
                        return Err(AtomicError::parse_error(
                            "Invalid value for AtomicUrl, not a string or object",
                            subject,
                            Some(&prop),
                        ));
                    }
                }
            }
            DataType::ResourceArray => {
                let serde_json::Value::Array(array) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for ResourceArray, not an array",
                        subject,
                        Some(&prop),
                    ));
                };

                let mut newvec: Vec<SubResource> = Vec::new();
                for item in array {
                    match item {
                        serde_json::Value::String(str) => {
                            let url = try_to_subject(str, &prop, store, parse_opts).await?;
                            newvec.push(SubResource::Subject(url.into()))
                        }
                        // If it's an Object, it can be either an anonymous or a full resource.
                        serde_json::Value::Object(map) => {
                            let propvals =
                                parse_anonymous_resource(map, subject, store, parse_opts).await?;
                            newvec.push(SubResource::Nested(propvals))
                        }
                        err => {
                            return Err(AtomicError::parse_error(
                                &format!("Found non-string item in resource array: {err}."),
                                subject,
                                Some(&prop),
                            ))
                        }
                    }
                }
                Value::ResourceArray(newvec)
            }
            DataType::String => {
                let serde_json::Value::String(str) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for String, not a string",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::String(str.clone())
            }
            DataType::Slug => {
                let serde_json::Value::String(str) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for Slug, not a string",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(str, &DataType::Slug)?
            }
            DataType::Markdown => {
                let serde_json::Value::String(str) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for Markdown, not a string",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(str, &DataType::Markdown)?
            }
            DataType::Uri => {
                let serde_json::Value::String(str) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for URI, not a string",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(str, &DataType::Uri)?
            }
            DataType::Date => {
                let serde_json::Value::String(str) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for Date, not a string",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(str, &DataType::Date)?
            }
            DataType::Boolean => {
                let serde_json::Value::Bool(bool) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for Boolean, not a boolean",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(&bool.to_string(), &DataType::Boolean)?
            }
            DataType::Integer => {
                let serde_json::Value::Number(num) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for Integer, not a number",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(&num.to_string(), &DataType::Integer)?
            }
            DataType::Float => {
                let serde_json::Value::Number(num) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for Float, not a number",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(&num.to_string(), &DataType::Float)?
            }
            DataType::Timestamp => {
                let serde_json::Value::Number(num) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for Timestamp, not a string",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(&num.to_string(), &DataType::Timestamp)?
            }
            DataType::Json => Value::Json(val.clone()),
            DataType::Unsupported(s) => {
                return Err(AtomicError::parse_error(
                    &format!("Unsupported datatype: {s}"),
                    subject,
                    Some(&prop),
                ));
            }
            DataType::YDoc => {
                let serde_json::Value::Object(map) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for YDoc, must be of shape { type: \"ydoc\", data: <base64 string> }",
                        subject,
                        Some(&prop),
                    ));
                };

                let Some(data) = map.get("data") else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for YDoc, no data field",
                        subject,
                        Some(&prop),
                    ));
                };

                let serde_json::Value::String(data) = data else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for YDoc, data field must be a string",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(data.as_str(), &DataType::YDoc)?
            }
            DataType::LoroDoc => {
                let serde_json::Value::String(data) = val else {
                    return Err(AtomicError::parse_error(
                        "Invalid value for LoroDoc, must be a base64 string",
                        subject,
                        Some(&prop),
                    ));
                };

                Value::new(data.as_str(), &DataType::LoroDoc)?
            }
            DataType::JsonArray => {
                match val {
                    serde_json::Value::Array(arr) => Value::JsonArray(arr.clone()),
                    _ => return Err(AtomicError::parse_error(
                        "Invalid value for JsonArray, must be a JSON array",
                        subject,
                        Some(&prop),
                    )),
                }
            }
        };

        Ok((prop, atomic_val))
    })
}

/// Parse a single Json AD string, convert to Atoms
/// Adds to the store if `add` is true.
#[tracing::instrument(skip_all)]
async fn parse_json_ad_map_to_resource(
    json: Map<String, serde_json::Value>,
    store: &impl crate::Storelike,
    overwrite_subject: Option<String>,
    parse_opts: &ParseOpts,
) -> AtomicResult<Resource> {
    let mut propvals = PropVals::new();
    let mut subject = overwrite_subject.clone();

    for (prop, val) in json {
        if prop == "@id" {
            if overwrite_subject.is_some() {
                return Err(AtomicError::parse_error(
                    "`@id` is not allowed in a resource with server generated subject.",
                    subject.as_deref(),
                    Some(&prop),
                ));
            }

            subject = if let serde_json::Value::String(s) = val {
                check_valid_url(&s).map_err(|e| {
                    AtomicError::parse_error(
                        &format!("Unable to parse @id {s}: {e}"),
                        subject.as_deref(),
                        Some(&prop),
                    )
                })?;
                Some(s)
            } else {
                return Err(AtomicError::parse_error(
                    "@id must be a string",
                    subject.as_deref(),
                    Some(&prop),
                ));
            };
            continue;
        } else if prop == urls::LOCAL_ID && parse_opts.importer.is_some() {
            if overwrite_subject.is_some() {
                return Err(AtomicError::parse_error(
                    "`@id` is not allowed in a resource with server generated subject.",
                    subject.as_deref(),
                    Some(&prop),
                ));
            }

            // If the property is a localId we need to set to generate a subject and update the subject value.
            let serde_json::Value::String(local_id) = val else {
                return Err(AtomicError::parse_error(
                    "`localId` must be a string",
                    Some(&val.to_string()),
                    Some(&prop),
                ));
            };

            let parent = parse_opts.importer.as_ref().ok_or_else(|| {
                AtomicError::parse_error(
                    "Encountered `localId`, which means we need a `parent` in the parsing options.",
                    subject.as_deref(),
                    Some(&prop),
                )
            })?;

            // For HTTP parents the synthesised `<parent>/<localId>` URL is
            // deterministic and idempotent. For DID parents we can't forge
            // a DID (it must equal the genesis-commit signature), so we
            // look up an existing resource matching (parent, localId) — if
            // one is found we re-use its subject, otherwise we leave
            // `subject = None` and the signing path generates a fresh DID.
            // Either way the localId is preserved as a property below so
            // future imports can re-find it.
            subject = if let Some(synth) = generate_id_from_local_id(parent, &local_id) {
                Some(synth)
            } else {
                find_existing_by_local_id(store, parent, &local_id).await?
            };

            propvals.insert(urls::LOCAL_ID.into(), Value::String(local_id.clone()));

            continue;
        }

        let result = parse_propval(&prop, &val, subject.as_deref(), store, parse_opts).await;

        match result {
            Ok((new_key, atomic_val)) => {
                // Some of these values are _not correctly matched_ to the datatype.
                propvals.insert(new_key, atomic_val);
            }
            Err(_) if parse_opts.skip_unknown_props => {
                // Silently skip properties we can't parse (e.g. unknown property definitions)
                continue;
            }
            Err(e) => return Err(e),
        }
    }
    // if there is no parent set, we set it to the Importer
    if let Some(importer) = &parse_opts.importer {
        if !propvals.contains_key(urls::PARENT) {
            propvals.insert(urls::PARENT.into(), Value::AtomicUrl(importer.clone()));
        }
    }

    // For DID-parent imports with a localId we may have no subject yet —
    // the import flow generates a fresh DID via genesis signing in the
    // SaveOpts::Commit branch below. For DontSave / Save we still need a
    // concrete subject, so error there.
    let r = match &parse_opts.save {
        SaveOpts::DontSave => {
            let subj = subject.ok_or_else(|| {
                AtomicError::parse_error(
                    "No @id or localId found in resource",
                    None,
                    None,
                )
            })?;
            let mut r = Resource::new(subj);
            r.set_propvals_unsafe(propvals);
            r
        }
        SaveOpts::Save => {
            let subj = subject.ok_or_else(|| {
                AtomicError::parse_error(
                    "No @id or localId found in resource",
                    None,
                    None,
                )
            })?;
            let mut r = Resource::new(subj);
            r.set_propvals_unsafe(propvals);
            store.add_resource(&r).await?;
            r
        }
        SaveOpts::Commit => {
            let signer = parse_opts
                .signer
                .clone()
                .ok_or("No agent to sign Commit with. Either pass a `for_agent` or ")?;

            // Fresh-DID path: no subject (DID parent + localId, no existing
            // match). Mint a DID by genesis-signing this resource.
            let Some(subj) = subject else {
                let mut r = Resource::new("did:ad:placeholder".to_string());
                for (prop, val) in propvals {
                    r.set(prop, val, store).await?;
                }
                let mut commit_builder = r.get_commit_builder().clone();
                commit_builder.is_genesis = true;
                let commit = commit_builder.sign(&signer, store, &r).await?;
                let signature = commit
                    .signature
                    .as_ref()
                    .ok_or("No signature generated for genesis commit")?;
                let did_subject =
                    crate::Subject::from_raw(&format!("did:ad:{}", signature), None);
                r.set_subject(did_subject.to_string());
                let mut final_commit = commit;
                final_commit.subject = did_subject;
                let opts = CommitOpts {
                    validate_schema: true,
                    validate_signature: true,
                    validate_timestamp: false,
                    validate_rights: parse_opts.for_agent != ForAgent::Sudo,
                    validate_previous_commit: false,
                    validate_loro_causality: false,
                    validate_for_agent: Some(parse_opts.for_agent.to_string()),
                    update_index: true,
                };
                let response = store
                    .apply_commit(final_commit, &opts)
                    .await
                    .map_err(|e| format!("Failed to save {}: {}", r.get_subject(), e))?;
                return Ok(response.resource_new.unwrap());
            };

            let mut is_new = false;
            let mut r = if let Ok(orig) = store.get_resource(&subj.as_str().into()).await {
                // If the resource already exists, and overwrites outside are not permitted, and it does not have the importer as parent...
                // Then we throw!
                // Because this would enable malicious users to overwrite resources that they shouldn't.
                if !parse_opts.overwrite_outside {
                    let importer = parse_opts.importer.as_ref().unwrap();
                    if !orig.has_parent(store, importer.as_str()).await {
                        Err(
                            format!("Cannot overwrite {subj} outside of importer! Enable `overwrite_outside`"),
                        )?
                    }
                };
                orig
            } else {
                is_new = true;
                Resource::new(subj)
            };
            for (prop, val) in propvals {
                r.set(prop, val, store).await?;
            }
            let mut commit_builder = r.get_commit_builder().clone();
            // For brand-new resources whose subject is a non-agent DID
            // (`did:ad:<folder>/<localId>` is the importer pattern when the
            // parent folder is itself DID-subjected), the signing path
            // requires `is_genesis=true` because there's no `previous_commit`
            // to anchor the chain. Without this flag, `sign()` rejects with
            // "DID genesis commits must explicitly set is_genesis=true" and
            // the import endpoint returns 500. Edits to existing resources
            // already have a `previous_commit` and don't need the flag.
            if is_new
                && r.get_subject().is_did()
                && !r.get_subject().is_agent_did()
            {
                commit_builder.is_genesis = true;
            }
            let commit = commit_builder.sign(&signer, store, &r).await?;

            let opts = CommitOpts {
                validate_schema: true,
                validate_signature: true,
                validate_timestamp: false,
                validate_rights: parse_opts.for_agent != ForAgent::Sudo,
                validate_previous_commit: false,
                validate_loro_causality: false,
                validate_for_agent: Some(parse_opts.for_agent.to_string()),
                update_index: true,
            };

            store
                .apply_commit(commit, &opts)
                .await
                .map_err(|e| format!("Failed to save {}: {}", r.get_subject(), e))?
                .resource_new
                .unwrap()
        }
    };
    Ok(r)
}

/// Builds a synthesised subject for an imported resource.
/// HTTP parents get a deterministic `<parent>/<localId>` URL.
/// For DID parents this returns `None`: the import flow generates a fresh
/// DID via genesis commit signing instead, and idempotency is achieved by
/// looking up existing resources by (parent, localId) before signing.
fn generate_id_from_local_id(
    importer: &crate::Subject,
    local_id: &str,
) -> Option<String> {
    if importer.is_did() {
        None
    } else {
        Some(format!("{}/{}", importer.as_str(), local_id))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::Storelike;

    #[tokio::test]
    async fn parse_and_serialize_json_ad() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let json_input = r#"{
            "@id": "https://atomicdata.dev/classes/Agent",
            "https://atomicdata.dev/properties/description": "An Agent is a user that can create or modify data. It has two keys: a private and a public one. The private key should be kept secret. The publik key is for proving that the ",
            "https://atomicdata.dev/properties/isA": [
               "https://atomicdata.dev/classes/Class"
            ],
            "https://atomicdata.dev/properties/recommends": [
              "https://atomicdata.dev/properties/description",
              "https://atomicdata.dev/properties/remove",
              "https://atomicdata.dev/properties/destroy"
            ],
              "https://atomicdata.dev/properties/requires": [
              "https://atomicdata.dev/properties/createdAt",
              "https://atomicdata.dev/properties/name",
              "https://atomicdata.dev/properties/publicKey"
            ],
            "https://atomicdata.dev/properties/shortname": "agent"
          }"#;
        let resource = parse_json_ad_resource(json_input, &store, &ParseOpts::default())
            .await
            .unwrap();
        let json_output = resource.to_json_ad(None).unwrap();
        let in_value: serde_json::Value = serde_json::from_str(json_input).unwrap();
        let out_value: serde_json::Value = serde_json::from_str(&json_output).unwrap();
        assert_eq!(in_value, out_value);
    }

    #[tokio::test]
    #[should_panic(expected = "@id must be a strin")]
    async fn parse_and_serialize_json_ad_wrong_id() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let json_input = r#"{"@id": 5}"#;
        parse_json_ad_resource(json_input, &store, &ParseOpts::default())
            .await
            .unwrap();
    }

    #[tokio::test]
    // This test should actually fail, I think, because the datatype should match the property.
    #[should_panic(expected = "Invalid value for Markdown")]
    async fn parse_and_serialize_json_ad_wrong_datatype_int_to_str() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let json_input = r#"{
            "@id": "https://atomicdata.dev/classes/Agent",
            "https://atomicdata.dev/properties/description": 1
          }"#;
        parse_json_ad_resource(json_input, &store, &ParseOpts::default())
            .await
            .unwrap();
    }

    #[tokio::test]
    #[should_panic(expected = "Not a valid Timestamp: 1.124. invalid digit found in string")]
    async fn parse_and_serialize_json_ad_wrong_datatype_float() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let json_input = r#"{
            "@id": "https://atomicdata.dev/classes/Agent",
            "https://atomicdata.dev/properties/createdAt": 1.124
          }"#;
        parse_json_ad_resource(json_input, &store, &ParseOpts::default())
            .await
            .unwrap();
    }

    // Roundtrip test requires fixing, because the order of imports can get problematic.
    // We should first import all Properties, then Classes, then other things.
    // See https://github.com/atomicdata-dev/atomic-server/issues/614
    #[ignore]
    #[tokio::test]
    async fn serialize_parse_roundtrip() {
        use crate::Storelike;
        let store1 = crate::Store::init().await.unwrap();
        store1.populate().await.unwrap();
        let store2 = crate::Store::init().await.unwrap();
        let all1: Vec<Resource> = store1.all_resources(true).collect();
        let serialized =
            crate::serialize::resources_to_json_ad(&all1, "https://atomicdata.dev", true).unwrap();

        store2
            .import(&serialized, &ParseOpts::default())
            .await
            .expect("import failed");
        let all2_count = store2.all_resources(true).count();

        assert_eq!(all1.len(), all2_count);
        let found_shortname = store2
            .get_resource(&urls::CLASS.into())
            .await
            .unwrap()
            .get(urls::SHORTNAME)
            .unwrap()
            .clone();
        assert_eq!(found_shortname.to_string(), "class");
    }

    #[tokio::test]
    async fn parser_should_error_when_encountering_nested_resource() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();

        let json = r#"{
            "@id": "https://atomicdata.dev/classes",
            "https://atomicdata.dev/properties/collection/members": [
              {
                "@id": "https://atomicdata.dev/classes/FirstThing",
                "https://atomicdata.dev/properties/description": "Named nested resource"
              },
              {
                "https://atomicdata.dev/properties/description": "Anonymous nested resource"
              },
              "https://atomicdata.dev/classes/ThirdThing"
            ]
          }"#;
        let binding = ParseOpts::default();
        let parsed = parse_json_ad_resource(json, &store, &binding);
        assert!(
            parsed.await.is_err(),
            "Subresource with @id should have errored"
        );
    }

    async fn create_store_and_importer() -> (crate::Store, crate::Subject) {
        let store = crate::Store::init().await.unwrap();
        store.set_base_url("http://localhost:9883");
        store.populate().await.unwrap();
        let agent = store.create_agent(None).await.unwrap();
        store.set_default_agent(agent);
        let mut importer = Resource::new_instance(urls::IMPORTER, &store)
            .await
            .unwrap();
        importer.save_locally(&store).await.unwrap();
        (store, importer.get_subject().clone())
    }

    #[tokio::test]
    async fn import_resource_with_localid() {
        let (store, importer) = create_store_and_importer().await;

        let local_id = "my-local-id";

        let json = r#"{
            "https://atomicdata.dev/properties/localId": "my-local-id",
            "https://atomicdata.dev/properties/name": "My resource"
          }"#;

        let parse_opts = ParseOpts {
            save: SaveOpts::Commit,
            signer: Some(store.get_default_agent().unwrap()),
            for_agent: ForAgent::Sudo,
            overwrite_outside: false,
            importer: Some(importer.clone()),
            ..Default::default()
        };

        store.import(json, &parse_opts).await.unwrap();

        // For HTTP parents (this test creates an internal:/ importer) the
        // synthesised subject is `<parent>/<localId>`. For DID parents we'd
        // need to look up by (parent, localId) instead.
        let imported_subject = generate_id_from_local_id(&importer, local_id)
            .expect("HTTP-style importer should yield a synthesised subject");

        let found = store
            .get_resource(&imported_subject.as_str().into())
            .await
            .unwrap();
        println!("{:?}", found);
        assert_eq!(found.get(urls::NAME).unwrap().to_string(), "My resource");

        // localId is now preserved on the resource so re-imports under DID
        // parents can dedupe via (parent, localId) lookup.
        assert_eq!(
            found.get(urls::LOCAL_ID).unwrap().to_string(),
            local_id
        );
    }
    #[tokio::test]
    async fn import_resource_with_json() {
        let (store, importer) = create_store_and_importer().await;

        let local_id = "my-local-id";

        let json = r#"
        [
        {
            "@id": "http://localhost:9883/01k06n9cz8r8vsdehh4btz8tdk",
            "https://atomicdata.dev/properties/datatype": "https://atomicdata.dev/datatypes/json",
            "https://atomicdata.dev/properties/description": "Een prop met een json value",
            "https://atomicdata.dev/properties/isA": [
                "https://atomicdata.dev/classes/Property"
            ],
            "https://atomicdata.dev/properties/shortname": "nieuwe-json-prop"
        }, {
            "https://atomicdata.dev/properties/localId": "my-local-id",
            "https://atomicdata.dev/properties/name": "My resource",
            "http://localhost:9883/01k06n9cz8r8vsdehh4btz8tdk": {
                "wat": "patat"
            }
        }
        ]"#;

        let parse_opts = ParseOpts {
            save: SaveOpts::Commit,
            signer: Some(store.get_default_agent().unwrap()),
            for_agent: ForAgent::Sudo,
            overwrite_outside: false,
            importer: Some(importer.clone()),
            ..Default::default()
        };

        store.import(json, &parse_opts).await.unwrap();

        let imported_subject = generate_id_from_local_id(&importer, local_id)
            .expect("HTTP-style importer should yield a synthesised subject");

        let found = store
            .get_resource(&imported_subject.as_str().into())
            .await
            .unwrap();
        assert_eq!(found.get(urls::NAME).unwrap().to_string(), "My resource");

        assert_eq!(
            found.get(urls::LOCAL_ID).unwrap().to_string(),
            local_id
        );
    }

    #[tokio::test]
    async fn import_resources_localid_references() {
        let (store, importer) = create_store_and_importer().await;

        let parse_opts = ParseOpts {
            save: SaveOpts::Commit,
            for_agent: ForAgent::Sudo,
            signer: Some(store.get_default_agent().unwrap()),
            overwrite_outside: false,
            importer: Some(importer.clone()),
            ..Default::default()
        };

        store
            .import(include_str!("../test_files/local_id.json"), &parse_opts)
            .await
            .unwrap();

        let reference_subject = generate_id_from_local_id(&importer, "reference")
            .expect("HTTP-style importer should yield a synthesised subject");
        let my_subject = generate_id_from_local_id(&importer, "my-local-id")
            .expect("HTTP-style importer should yield a synthesised subject");
        let found = store
            .get_resource(&my_subject.as_str().into())
            .await
            .unwrap();
        let found_ref = store
            .get_resource(&reference_subject.as_str().into())
            .await
            .unwrap();

        assert_eq!(
            found.get(urls::PARENT).unwrap().to_string(),
            reference_subject
        );
        assert_eq!(
            &found_ref.get(urls::PARENT).unwrap().to_string(),
            importer.as_str()
        );
        assert_eq!(
            found
                .get(urls::WRITE)
                .unwrap()
                .to_subjects(None)
                .unwrap()
                .first()
                .unwrap(),
            &reference_subject
        );
    }

    #[tokio::test]
    async fn import_resource_malicious() {
        let (store, importer) = create_store_and_importer().await;
        store.set_base_url("http://localhost:9883");

        // Try to overwrite the main drive with some malicious data
        let agent = store.get_default_agent().unwrap();
        let mut resource = Resource::new_generate_subject(&store).unwrap();
        resource
            .set(
                urls::WRITE.into(),
                vec![agent.subject.clone()].into(),
                &store,
            )
            .await
            .unwrap();
        resource.save_locally(&store).await.unwrap();

        let json = format!(
            r#"{{
            "@id": "{}",
            "https://atomicdata.dev/properties/write": ["https://some-malicious-actor"]
        }}"#,
            resource.get_subject()
        );

        let mut parse_opts = ParseOpts {
            save: SaveOpts::Commit,
            signer: Some(agent.clone()),
            for_agent: agent.subject.into(),
            overwrite_outside: false,
            importer: Some(importer),
            ..Default::default()
        };

        // We can't allow this to happen, so we expect an error
        store.import(&json, &parse_opts).await.unwrap_err();

        // If we explicitly allow overwriting resources outside scope, we should be able to import it
        parse_opts.overwrite_outside = true;
        store.import(&json, &parse_opts).await.unwrap();
    }

    #[test]
    fn is_property() {
        let json = r#"
        {
    "https://atomicdata.dev/properties/localId": "newprop",
    "https://atomicdata.dev/properties/datatype": "https://atomicdata.dev/datatypes/string",
    "https://atomicdata.dev/properties/description": "test property",
    "https://atomicdata.dev/properties/isA": [
      "https://atomicdata.dev/classes/Property"
    ],
    "https://atomicdata.dev/properties/shortname": "homepage"
}
        "#;

        let object: serde_json::Value = serde_json::from_str(json).unwrap();

        assert!(
            object_is_property(&object),
            "This JSON should be parsed as a property"
        )
    }

    #[tokio::test]
    /// The importer should import properties first
    async fn parse_sorted_properties() {
        let (store, importer) = create_store_and_importer().await;
        store.populate().await.unwrap();

        let json = r#"[
{
    "https://atomicdata.dev/properties/localId": "test1",
    "https://atomicdata.dev/properties/name": "val"
},
{
"https://atomicdata.dev/properties/localId": "test2"
},
  {
    "https://atomicdata.dev/properties/localId": "newprop",
    "https://atomicdata.dev/properties/datatype": "https://atomicdata.dev/datatypes/string",
    "https://atomicdata.dev/properties/description": "test property",
    "https://atomicdata.dev/properties/isA": [
      "https://atomicdata.dev/classes/Property"
    ],
    "https://atomicdata.dev/properties/parent": "test2",
    "https://atomicdata.dev/properties/shortname": "homepage"
}]"#;

        let parse_opts = crate::parse::ParseOpts {
            for_agent: ForAgent::AgentSubject(store.get_default_agent().unwrap().subject),
            importer: Some(importer.clone()),
            overwrite_outside: false,
            // We sign the importer Commits with the default agent,
            // not the one performing the import, because we don't have their private key.
            signer: Some(store.get_default_agent().unwrap()),
            save: crate::parse::SaveOpts::Commit,
            ..Default::default()
        };

        store.import(json, &parse_opts).await.unwrap();

        let parent_subject = generate_id_from_local_id(&importer, "test1")
            .expect("HTTP-style importer should yield a synthesised subject");
        let found = store
            .get_resource(&parent_subject.as_str().into())
            .await
            .unwrap();
        assert_eq!(
            found.get(urls::PARENT).unwrap().to_string(),
            importer.as_str()
        );

        let newprop_subject = format!("{}/newprop", importer.as_str());
        let _prop = store
            .get_resource(&newprop_subject.as_str().into())
            .await
            .unwrap();
    }

    // TODO: Add support for parent sorting in the parser.

    // #[test]
    // fn import_parent_chain() {
    //     let (store, importer) = create_store_and_importer();

    //     let json = r#"[
    // {
    // "https://atomicdata.dev/properties/localId": "test2",
    // "https://atomicdata.dev/properties/parent": "test1"
    // },
    // {
    // "https://atomicdata.dev/properties/localId": "test1"
    // }
    //     ]"#;

    //     let parse_opts = crate::parse::ParseOpts {
    //         for_agent: ForAgent::AgentSubject(store.get_default_agent().unwrap().subject),
    //         importer: Some(importer.clone()),
    //         overwrite_outside: false,
    //         signer: Some(store.get_default_agent().unwrap()),
    //         save: crate::parse::SaveOpts::Commit,
    //     };

    //     store.import(json, &parse_opts).unwrap();

    //     let _test2_resource = store.get_resource(&format!("{importer}/test2")).unwrap();
    // }
}
