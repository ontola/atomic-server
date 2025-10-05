//! Creating a new resource. Provides prompting logic
use crate::{CLIResult, Context};
use atomic_lib::mapping;
use atomic_lib::utils::{check_valid_json, check_valid_uri};
use atomic_lib::{
    datatype::DataType,
    errors::AtomicResult,
    schema::{Class, Property},
    Resource, Storelike, Value,
};
use colored::Colorize;
use promptly::prompt_opt;
use regex::Regex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Create a new instance of some class through a series of prompts, adds it to the store
pub fn new(context: &mut Context, class_input: &str) -> AtomicResult<()> {
    let class_url = context
        .mapping
        .lock()
        .try_mapping_or_url(class_input)
        .unwrap();
    let class = context.store.get_class(&class_url)?;
    println!("Enter a new {}: {}", class.shortname, class.description);
    let (resource, _bookmark) = prompt_instance(context, &class, None)?;
    println!(
        "Succesfully created a new {}: subject: {}",
        class.shortname,
        resource.get_subject()
    );
    Ok(())
}

/// Lets the user enter an instance of an Atomic Class through multiple prompts.
/// Adds the Resource to the store, and writes to disk.
/// Returns the Resource, its URL and its Bookmark.
fn prompt_instance(
    context: &Context,
    class: &Class,
    preferred_shortname: Option<String>,
) -> CLIResult<(Resource, Option<String>)> {
    // Not sure about the best way t
    // The Path is the thing at the end of the URL, from the domain
    // Here I set some (kind of) random numbers.
    // I think URL generation could be better, though. Perhaps use a
    let path = SystemTime::now().duration_since(UNIX_EPOCH)?.subsec_nanos();

    let config = context.read_config();

    let Some(client_config) = config.client else {
        return Err("No client config found".into());
    };

    let mut subject = format!("{}/{}", client_config.server_url, path);
    if let Some(sn) = &preferred_shortname {
        subject = format!("{}/{}-{}", client_config.server_url, path, sn);
    }

    let mut new_resource: Resource = Resource::new(subject.clone());

    new_resource.set(
        "https://atomicdata.dev/properties/isA".into(),
        Value::from(vec![class.subject.clone()]),
        &context.store,
    )?;

    for prop_subject in &class.requires {
        let field = context.store.get_property(prop_subject)?;
        if field.subject == atomic_lib::urls::SHORTNAME && preferred_shortname.clone().is_some() {
            new_resource.set_string(
                field.subject.clone(),
                &preferred_shortname.clone().unwrap(),
                &context.store,
            )?;
            println!(
                "Shortname set to {}",
                preferred_shortname.clone().unwrap().bold().green()
            );
            continue;
        }
        println!("{}: {}", field.shortname.bold().blue(), field.description);
        // In multiple Properties, the shortname field is required.
        // A preferred shortname can be passed into this function
        let mut input = prompt_field(&field, false, context)?;
        loop {
            if let Some(i) = input {
                new_resource.set_string(field.subject.clone(), &i, &context.store)?;
                break;
            } else {
                println!("Required field, please enter a value.");
                input = prompt_field(&field, false, context)?;
            }
        }
    }

    for prop_subject in &class.recommends {
        let field = context.store.get_property(prop_subject)?;
        println!("{}: {}", field.shortname.bold().blue(), field.description);
        let input = prompt_field(&field, true, context)?;
        if let Some(i) = input {
            new_resource.set_string(field.subject.clone(), &i, &context.store)?;
        }
    }

    new_resource.save(&context.store)?;

    println!("{} created with URL: {}", &class.shortname, &subject);

    let map = prompt_bookmark(&mut context.mapping.lock(), &subject);

    context
        .mapping
        .lock()
        .write_mapping_to_disk(&context.user_mapping_path);
    Ok((new_resource, map))
}

// Checks the property and its datatype, and issues a prompt that performs validation.
fn prompt_field(
    property: &Property,
    optional: bool,
    context: &Context,
) -> CLIResult<Option<String>> {
    let msg_appendix: &str = if optional {
        " (optional)"
    } else {
        " (required)"
    };
    match &property.data_type {
        DataType::String | DataType::Markdown => {
            let msg = format!("string{}", msg_appendix);
            Ok(prompt_opt(msg)?)
        }
        DataType::Slug => {
            let msg = format!("slug{}", msg_appendix);
            let input: Option<String> = prompt_opt(msg)?;
            let re = Regex::new(atomic_lib::values::SLUG_REGEX)?;
            match input {
                Some(slug) => {
                    if re.is_match(&slug) {
                        return Ok(Some(slug));
                    }
                    println!("Only letters, numbers and dashes - no spaces or special characters.");
                    Ok(None)
                }
                None => Ok(None),
            }
        }
        DataType::Uri => {
            let msg = format!("URI{}", msg_appendix);

            let input: Option<String> = prompt_opt(msg)?;
            let Some(uri) = input else {
                return Ok(None);
            };

            check_valid_uri(&uri).unwrap();
            Ok(Some(uri))
        }
        DataType::JSON => {
            let msg = format!("JSON{}", msg_appendix);
            let Some(json) = prompt_opt::<String, String>(msg)? else {
                return Ok(None);
            };

            check_valid_json(&json).unwrap();
            Ok(Some(json))
        }
        DataType::Integer => {
            let msg = format!("integer{}", msg_appendix);
            let number: Option<u32> = prompt_opt(msg)?;
            match number {
                Some(nr) => Ok(Some(nr.to_string())),
                None => Ok(None),
            }
        }
        DataType::Float => {
            let msg = format!("float{}", msg_appendix);
            let number: Option<f64> = prompt_opt(msg)?;
            match number {
                Some(nr) => Ok(Some(nr.to_string())),
                None => Ok(None),
            }
        }
        DataType::Date => {
            let msg = format!("date YYYY-MM-DD{}", msg_appendix);
            let date: Option<String> = prompt_opt(msg).unwrap();
            let re = Regex::new(atomic_lib::values::DATE_REGEX).unwrap();
            match date {
                Some(date_val) => {
                    if re.is_match(&date_val) {
                        return Ok(Some(date_val));
                    }
                    println!("Not a valid date.");
                    Ok(None)
                }
                None => Ok(None),
            }
        }
        DataType::AtomicUrl => loop {
            let msg = format!("URL{}", msg_appendix);
            let classtype = &property.class_type;
            if classtype.is_some() {
                let class = context
                    .store
                    .get_class(&String::from(classtype.as_ref().unwrap()))?;
                println!(
                    "Enter the URL of a {} (an instance of a {})",
                    class.shortname, class.subject
                )
            }
            let url: Option<String> = prompt_opt(msg).unwrap();
            // If a classtype is present, the given URL must be an instance of that Class
            if let Some(u) = url {
                // TODO: Check if string or if map
                match context.mapping.lock().try_mapping_or_url(&u) {
                    Some(url) => return Ok(Some(url)),
                    None => {
                        println!("Shortname not found, try again.");
                        return Ok(None);
                    }
                }
            }
        },
        DataType::ResourceArray => loop {
            let msg = format!(
                "resource array - Add the URLs or Shortnames, separated by spaces{}",
                msg_appendix
            );
            let option_string: Option<String> = prompt_opt(msg).unwrap();
            match option_string {
                Some(string) => {
                    let string_items = string.split(' ');
                    let mut urls: Vec<String> = Vec::new();
                    let length = string_items.clone().count();
                    for item in string_items {
                        let mapping_match = context.mapping.lock().try_mapping_or_url(item).clone();
                        match mapping_match {
                            Some(url) => {
                                urls.push(url);
                            }
                            None => {
                                let class = &context.store.get_class(&property.class_type.clone().expect("At this moment, this CLI only supports Properties that have a class-type."))?.clone();
                                println!(
                                    "Define the {} named {}",
                                    class.shortname,
                                    item.bold().green(),
                                );
                                let (resource, _shortname) =
                                    prompt_instance(context, class, Some(item.into()))?;
                                urls.push(resource.get_subject().clone());
                                continue;
                            }
                        }
                    }
                    if length == urls.len() {
                        return Ok(Some(
                            atomic_lib::serialize::serialize_json_array(&urls).unwrap(),
                        ));
                    }
                }
                None => return Ok(None),
            }
        },
        DataType::Timestamp => {
            let msg = format!("timestamp{}", msg_appendix);
            let number: Option<u64> = prompt_opt(msg)?;
            match number {
                Some(nr) => Ok(Some(nr.to_string())),
                None => Ok(None),
            }
        }
        DataType::Unsupported(unsup) => {
            let msg = format!(
                "unsupported datatype {}, defaulting to string{}",
                unsup, msg_appendix
            );
            let string: Option<String> = prompt_opt(msg)?;
            match string {
                Some(nr) => Ok(Some(nr.to_string())),
                None => Ok(None),
            }
        }
        DataType::Boolean => {
            let msg = format!("boolean{}", msg_appendix);
            let number: Option<bool> = prompt_opt(msg)?;
            match number {
                Some(nr) => {
                    if nr {
                        return Ok(Some("true".to_string()));
                    }
                    Ok(Some("false".to_string()))
                }
                None => Ok(None),
            }
        }
    }
}

// Asks for and saves the bookmark. Returns the shortname.
fn prompt_bookmark(mapping: &mut mapping::Mapping, subject: &str) -> Option<String> {
    let re = Regex::new(atomic_lib::values::SLUG_REGEX).unwrap();
    let mut shortname: Option<String> = prompt_opt("Local Bookmark (optional)").unwrap();
    loop {
        match shortname.as_ref() {
            Some(sn) => {
                if mapping.contains_key(sn) {
                    let msg = format!(
                        "You're already using that shortname for {:?}, try something else",
                        mapping.get(sn).unwrap()
                    );
                    shortname = prompt_opt(msg).unwrap();
                } else if re.is_match(sn.as_str()) {
                    mapping.insert(sn.into(), subject.into());
                    return Some(String::from(sn));
                } else {
                    shortname =
                        prompt_opt("Not a valid bookmark, only use letters, numbers, and '-'")
                            .unwrap();
                }
            }
            None => return None,
        }
    }
}
