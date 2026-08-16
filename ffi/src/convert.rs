use atomic_lib::{urls, Value};

pub(crate) fn resolve_property(name: &str) -> String {
    if name.starts_with("https://") || name.starts_with("http://") || name.starts_with("did:") {
        return name.to_string();
    }
    match name {
        "name" => urls::NAME.to_string(),
        "description" => urls::DESCRIPTION.to_string(),
        "parent" => urls::PARENT.to_string(),
        "isA" | "is_a" | "isa" => urls::IS_A.to_string(),
        "shortname" => urls::SHORTNAME.to_string(),
        "datatype" => urls::DATATYPE_PROP.to_string(),
        "read" => urls::READ.to_string(),
        "write" => urls::WRITE.to_string(),
        "children" => urls::CHILDREN.to_string(),
        "drives" => urls::DRIVES.to_string(),
        other => format!("https://atomicdata.dev/properties/{other}"),
    }
}

pub(crate) fn string_to_value(s: &str) -> Value {
    if s.starts_with("https://") || s.starts_with("http://") || s.starts_with("did:") {
        Value::AtomicUrl(s.into())
    } else {
        Value::String(s.to_string())
    }
}
