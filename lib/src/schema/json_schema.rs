//! JSON Schema (draft 2020-12) into an Atomic ontology.
//!
//! The TypeScript twin is `browser/lib/src/schema-json-schema.ts` (and
//! `ontology-input.ts`, `plugin-schema.ts`); both run
//! `lib/tests/fixtures/json-schema-interop.json`, so change them together.
//! See `docs/src/schema/json-schema.md`.
//!
//! [`ontology_from_json_schema`] turns a schema into an [`OntologyPlan`]:
//! every object schema in `$defs` becomes a class, its `properties` become
//! properties, `required` becomes `requires` and the supported keywords become
//! class constraints. Anything Atomic cannot express is an error naming its
//! JSON pointer. [`ensure_ontology`] makes a plan real in a store.
//!
//! Only the import direction exists in Rust; export is TypeScript only.

use std::collections::BTreeMap;

use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::{Map, Number, Value as Json};

use crate::{
    agents::Agent,
    class_constraints::parse_constraint,
    commit::{Commit, CommitBuilder, CommitOpts},
    datatype::{match_datatype, DataType},
    errors::AtomicResult,
    identifiers::canonicalize_scheme,
    property_identity::property_id,
    storelike::Storelike,
    urls,
    values::SLUG_REGEX,
    Subject, Value,
};

pub const JSON_SCHEMA_DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";

/// The input of [`ensure_ontology`], and what [`ontology_from_json_schema`]
/// produces. The JSON form is the `plan` of the interop fixture.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct OntologyPlan {
    pub shortname: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Properties that no single class owns.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub properties: Vec<PropertyPlan>,
    pub classes: Vec<ClassPlan>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PropertyPlan {
    /// A slug. With the ontology and the datatype it is the property's identity.
    pub shortname: String,
    /// A Datatype subject.
    pub datatype: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classtype: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ClassPlan {
    pub shortname: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Properties this class uses, declared in place. Equal declarations (same
    /// shortname and datatype) in several classes are one Property.
    #[serde(default)]
    pub properties: Vec<PropertyPlan>,
    /// Shortnames. JSON Schema `required`.
    #[serde(default)]
    pub requires: Vec<String>,
    /// Shortnames. Declared properties in neither list are recommended.
    #[serde(default)]
    pub recommends: Vec<String>,
    /// Property shortname to constraint keywords. A `class` keyword holding a
    /// bare shortname (no `:`) names a class of this ontology. `None` leaves
    /// the class's constraints alone, an empty map clears them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub constraints: Option<BTreeMap<String, Map<String, Json>>>,
}

#[derive(Clone, Debug, Default)]
pub struct ImportOptions {
    /// The ontology's shortname. Defaults to `x-atomic-ontology`, then the
    /// slugified `title`.
    pub shortname: Option<String>,
}

/// What [`ensure_ontology`] made or found. Shortname to subject.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EnsuredOntology {
    pub ontology: String,
    pub classes: BTreeMap<String, String>,
    pub properties: BTreeMap<String, String>,
}

// ---------------------------------------------------------------------------
// Ordered JSON
// ---------------------------------------------------------------------------

/// JSON that keeps the order of object keys, which `serde_json::Value` does
/// not: the order of `properties` is the order a class lists them in.
#[derive(Clone, Debug, PartialEq)]
pub enum Node {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

impl Node {
    /// From a parsed value. Its keys are already sorted, so their order is alphabetical.
    pub fn from_json(json: &Json) -> Node {
        match json {
            Json::Null => Node::Null,
            Json::Bool(b) => Node::Bool(*b),
            Json::Number(n) => Node::Number(n.clone()),
            Json::String(s) => Node::String(s.clone()),
            Json::Array(a) => Node::Array(a.iter().map(Node::from_json).collect()),
            Json::Object(o) => Node::Object(
                o.iter()
                    .map(|(k, v)| (k.clone(), Node::from_json(v)))
                    .collect(),
            ),
        }
    }

    pub fn to_json(&self) -> Json {
        match self {
            Node::Null => Json::Null,
            Node::Bool(b) => Json::Bool(*b),
            Node::Number(n) => Json::Number(n.clone()),
            Node::String(s) => Json::String(s.clone()),
            Node::Array(a) => Json::Array(a.iter().map(Node::to_json).collect()),
            Node::Object(o) => Json::Object(
                o.iter()
                    .map(|(k, v)| (k.clone(), v.to_json()))
                    .collect::<Map<_, _>>(),
            ),
        }
    }

    fn get(&self, key: &str) -> Option<&Node> {
        match self {
            Node::Object(o) => o.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    fn keys(&self) -> Vec<&str> {
        match self {
            Node::Object(o) => o.iter().map(|(k, _)| k.as_str()).collect(),
            _ => Vec::new(),
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Node::String(s) => Some(s),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NodeVisitor;

        impl<'de> Visitor<'de> for NodeVisitor {
            type Value = Node;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any JSON value")
            }

            fn visit_bool<E>(self, v: bool) -> Result<Node, E> {
                Ok(Node::Bool(v))
            }

            fn visit_i64<E>(self, v: i64) -> Result<Node, E> {
                Ok(Node::Number(v.into()))
            }

            fn visit_u64<E>(self, v: u64) -> Result<Node, E> {
                Ok(Node::Number(v.into()))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Node, E> {
                Number::from_f64(v)
                    .map(Node::Number)
                    .ok_or_else(|| E::custom("numbers must be finite"))
            }

            fn visit_str<E>(self, v: &str) -> Result<Node, E> {
                Ok(Node::String(v.to_string()))
            }

            fn visit_unit<E>(self) -> Result<Node, E> {
                Ok(Node::Null)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Node::Array(items))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
                let mut entries: Vec<(String, Node)> = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, Node>()? {
                    // As in JSON.parse, the last of two equal keys wins.
                    match entries.iter_mut().find(|(k, _)| *k == key) {
                        Some(slot) => slot.1 = value,
                        None => entries.push((key, value)),
                    }
                }
                Ok(Node::Object(entries))
            }
        }

        deserializer.deserialize_any(NodeVisitor)
    }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Annotations that change no validation result. Read and dropped.
const ANNOTATIONS: [&str; 6] = [
    "$comment",
    "examples",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
];

/// Atomic identity, written on export for readers. Never trusted on import.
const INFORMATIONAL: [&str; 2] = ["x-atomic-subject", "x-atomic-property"];

const CONSTRAINT_PASSTHROUGH: [&str; 9] = [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "pattern",
];

fn allowed(own: &[&'static str]) -> Vec<&'static str> {
    let mut all: Vec<&'static str> = own.to_vec();
    all.extend(ANNOTATIONS);
    all.extend(INFORMATIONAL);
    all
}

fn root_keys() -> Vec<&'static str> {
    allowed(&[
        "$schema",
        "$id",
        "$defs",
        "title",
        "description",
        "type",
        "properties",
        "required",
        "additionalProperties",
        "x-atomic-ontology",
    ])
}

fn class_keys() -> Vec<&'static str> {
    allowed(&[
        "type",
        "title",
        "description",
        "properties",
        "required",
        "additionalProperties",
    ])
}

fn property_keys() -> Vec<&'static str> {
    let mut keys = allowed(&[
        "type",
        "format",
        "enum",
        "const",
        "items",
        "$ref",
        "title",
        "description",
        "x-atomic-datatype",
        "x-atomic-class",
    ]);
    keys.extend(CONSTRAINT_PASSTHROUGH);
    keys
}

fn ref_keys() -> Vec<&'static str> {
    allowed(&["$ref", "title", "description", "enum", "const"])
}

const ITEM_KEYS: [&str; 6] = ["type", "format", "$ref", "enum", "const", "x-atomic-class"];

fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn child(pointer: &str, key: &str) -> String {
    format!("{pointer}/{}", escape_pointer(key))
}

fn fail<T>(pointer: &str, message: impl AsRef<str>) -> AtomicResult<T> {
    Err(format!(
        "JSON Schema at {}: {}",
        if pointer.is_empty() { "/" } else { pointer },
        message.as_ref()
    )
    .into())
}

fn as_object<'a>(node: &'a Node, pointer: &str) -> AtomicResult<&'a Node> {
    match node {
        Node::Object(_) => Ok(node),
        _ => fail(
            pointer,
            "expected a schema object (boolean schemas are unsupported)",
        ),
    }
}

fn check_keys(schema: &Node, pointer: &str, allowed: &[&str]) -> AtomicResult<()> {
    for key in schema.keys() {
        if allowed.contains(&key) {
            continue;
        }
        let kind = if key.starts_with("x-") {
            "unknown extension keyword"
        } else {
            "unsupported keyword"
        };
        return fail(
            &child(pointer, key),
            format!(
                "{kind} '{key}'. Atomic classes cannot express it, so it is rejected instead of dropped"
            ),
        );
    }
    Ok(())
}

fn optional_string(schema: &Node, key: &str, pointer: &str) -> AtomicResult<Option<String>> {
    match schema.get(key) {
        None => Ok(None),
        Some(Node::String(s)) => Ok(Some(s.clone())),
        Some(_) => fail(&child(pointer, key), "expected a string"),
    }
}

/// `LineItem`, `line_item` and `line item` all become `line-item`. Anything
/// that is not an ASCII letter or digit separates words. `None` when nothing is
/// left. Same algorithm as `slugify` in `browser/lib/src/ontology-input.ts`.
pub fn slugify(raw: &str) -> Option<String> {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::new();
    let mut prev: Option<char> = None;

    for (i, &c) in chars.iter().enumerate() {
        if c.is_ascii_alphanumeric() {
            let next = chars.get(i + 1).copied();
            let boundary = c.is_ascii_uppercase()
                && (prev.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
                    || (prev.is_some_and(|p| p.is_ascii_uppercase())
                        && next.is_some_and(|n| n.is_ascii_lowercase())));
            if boundary && !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
            out.push(c.to_ascii_lowercase());
            prev = Some(c);
        } else {
            if !out.is_empty() && !out.ends_with('-') {
                out.push('-');
            }
            prev = None;
        }
    }

    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn is_known_datatype(datatype: &str) -> bool {
    !matches!(match_datatype(datatype), DataType::Unsupported(_))
}

struct ImportContext {
    /// `$defs` key to the shortname of its class.
    classes: Vec<(String, String)>,
}

fn resolve_ref(reference: &Node, pointer: &str, ctx: &ImportContext) -> AtomicResult<String> {
    let Node::String(reference) = reference else {
        return fail(pointer, "$ref must be a string");
    };
    let Some(key) = reference
        .strip_prefix("#/$defs/")
        .filter(|k| !k.is_empty() && !k.contains('/'))
    else {
        return fail(
            pointer,
            format!("only local '#/$defs/Name' references are supported, got '{reference}'"),
        );
    };
    let key = key.replace("~1", "/").replace("~0", "~");
    match ctx.classes.iter().find(|(k, _)| *k == key) {
        Some((_, shortname)) => Ok(shortname.clone()),
        None => fail(
            pointer,
            format!("'{reference}' does not name an object schema in $defs"),
        ),
    }
}

struct ReadProperty {
    datatype: String,
    name: Option<String>,
    description: Option<String>,
    constraint: Map<String, Json>,
}

/// Datatype from a bare `enum` or `const`, the way a JSON Schema author means it.
fn datatype_of_values(values: &[Json], pointer: &str) -> AtomicResult<String> {
    if values.iter().all(Json::is_string) {
        Ok(urls::STRING.into())
    } else if values.iter().all(Json::is_boolean) {
        Ok(urls::BOOLEAN.into())
    } else if values.iter().all(|v| v.is_i64() || v.is_u64()) {
        Ok(urls::INTEGER.into())
    } else if values.iter().all(Json::is_number) {
        Ok(urls::FLOAT.into())
    } else {
        fail(
            pointer,
            "enum values of mixed types need an explicit type or x-atomic-datatype",
        )
    }
}

/// `enum` and `const` as one list, `None` when neither is set.
fn enum_of(schema: &Node, pointer: &str) -> AtomicResult<Option<Vec<Json>>> {
    if schema.has("enum") && schema.has("const") {
        return fail(pointer, "'enum' and 'const' cannot be combined");
    }
    match schema.get("enum") {
        Some(Node::Array(values)) => return Ok(Some(values.iter().map(Node::to_json).collect())),
        Some(_) => return fail(&child(pointer, "enum"), "expected an array"),
        None => {}
    }
    Ok(schema.get("const").map(|value| vec![value.to_json()]))
}

fn read_property(schema: &Node, pointer: &str, ctx: &ImportContext) -> AtomicResult<ReadProperty> {
    let s = as_object(schema, pointer)?;
    let has_ref = s.has("$ref");

    check_keys(
        s,
        pointer,
        &if has_ref { ref_keys() } else { property_keys() },
    )?;

    let name = optional_string(s, "title", pointer)?;
    let description = optional_string(s, "description", pointer)?;
    let mut constraint = Map::new();

    let type_name = match s.get("type") {
        None => None,
        Some(Node::String(t)) => Some(t.as_str()),
        Some(Node::Array(_)) => {
            return fail(
                &child(pointer, "type"),
                "type arrays (such as nullable types) are not supported. Atomic has no null: leave the property out of the value instead",
            )
        }
        Some(_) => return fail(&child(pointer, "type"), "expected a string"),
    };

    let mut inferred: Option<String> = None;
    let mut values: Option<Vec<Json>> = None;
    let mut link_class: Option<Json> = None;

    let is_array = type_name == Some("array") || (type_name.is_none() && s.has("items"));

    if has_ref {
        inferred = Some(urls::ATOMIC_URL.into());
        let target = resolve_ref(
            s.get("$ref").unwrap_or(&Node::Null),
            &child(pointer, "$ref"),
            ctx,
        )?;
        link_class = Some(Json::String(target));
        values = enum_of(s, pointer)?;
    } else if is_array {
        if type_name.is_some_and(|t| t != "array") {
            return fail(&child(pointer, "type"), "'items' only applies to arrays");
        }
        for key in ["enum", "const"] {
            if s.has(key) {
                return fail(
                    &child(pointer, key),
                    format!("'{key}' on an array constrains the whole array. Put it on 'items' to constrain every item"),
                );
            }
        }
        if s.has("format") {
            return fail(&child(pointer, "format"), "format only applies to strings");
        }
        if s.has("x-atomic-class") {
            return fail(
                &child(pointer, "x-atomic-class"),
                "put 'x-atomic-class' on 'items' for an array",
            );
        }
        inferred = Some(urls::JSON.into());

        if let Some(items) = s.get("items") {
            let items_pointer = child(pointer, "items");
            let items = as_object(items, &items_pointer)?;
            check_keys(items, &items_pointer, &ITEM_KEYS)?;

            if items.has("$ref") {
                for key in items.keys() {
                    if !["$ref", "enum", "const"].contains(&key) {
                        return fail(&child(&items_pointer, key), "not supported next to '$ref'");
                    }
                }
                inferred = Some(urls::RESOURCE_ARRAY.into());
                let target = resolve_ref(
                    items.get("$ref").unwrap_or(&Node::Null),
                    &child(&items_pointer, "$ref"),
                    ctx,
                )?;
                link_class = Some(Json::String(target));
            } else if items.get("type").and_then(Node::as_str) == Some("string")
                && items.get("format").and_then(Node::as_str) == Some("uri")
            {
                inferred = Some(urls::RESOURCE_ARRAY.into());
                link_class = items.get("x-atomic-class").map(Node::to_json);
            }
            values = enum_of(items, &items_pointer)?;
        }
    } else {
        link_class = s.get("x-atomic-class").map(Node::to_json);
        values = enum_of(s, pointer)?;

        match type_name {
            Some("string") => {
                inferred = Some(
                    match s.get("format") {
                        None => urls::STRING,
                        Some(Node::String(f)) if f == "date-time" => urls::TIMESTAMP,
                        Some(Node::String(f)) if f == "date" => urls::DATE,
                        Some(Node::String(f)) if f == "uri" => urls::ATOMIC_URL,
                        Some(other) => {
                            return fail(
                                &child(pointer, "format"),
                                format!(
                                    "unsupported format {}. Supported: date-time, date, uri",
                                    other.to_json()
                                ),
                            )
                        }
                    }
                    .into(),
                )
            }
            Some("integer") => inferred = Some(urls::INTEGER.into()),
            Some("number") => inferred = Some(urls::FLOAT.into()),
            Some("boolean") => inferred = Some(urls::BOOLEAN.into()),
            Some("object") => inferred = Some(urls::JSON.into()),
            None => {
                if let Some(values) = &values {
                    inferred = Some(datatype_of_values(values, pointer)?);
                }
            }
            Some(other) => {
                return fail(
                    &child(pointer, "type"),
                    format!("unsupported type '{other}'. Supported: string, integer, number, boolean, array, object"),
                )
            }
        }

        if type_name != Some("string") && s.has("format") {
            return fail(&child(pointer, "format"), "format only applies to strings");
        }
    }

    for key in CONSTRAINT_PASSTHROUGH {
        if let Some(value) = s.get(key) {
            constraint.insert(key.to_string(), value.to_json());
        }
    }
    if let Some(values) = values {
        constraint.insert("enum".into(), Json::Array(values));
    }
    if let Some(class) = link_class {
        if !class.is_string() {
            return fail(&child(pointer, "x-atomic-class"), "expected a string");
        }
        constraint.insert("class".into(), class);
    }

    if let Err(e) = parse_constraint(&Json::Object(constraint.clone())) {
        return fail(pointer, e.to_string());
    }

    let override_datatype = match s.get("x-atomic-datatype") {
        None => None,
        Some(Node::String(d)) if is_known_datatype(d) => Some(d.clone()),
        Some(other) => {
            return fail(
                &child(pointer, "x-atomic-datatype"),
                format!("unknown Atomic datatype {}", other.to_json()),
            )
        }
    };

    let Some(datatype) = override_datatype.or(inferred) else {
        return fail(
            pointer,
            "cannot tell the datatype: add 'type', '$ref' or 'x-atomic-datatype'",
        );
    };

    Ok(ReadProperty {
        datatype,
        name,
        description,
        constraint,
    })
}

struct ClassSource<'a> {
    pointer: String,
    schema: &'a Node,
    shortname: String,
    /// The name when there is no title.
    key: Option<String>,
}

/// Property shortname to where it was first seen and with which datatype.
type SeenProperties = BTreeMap<String, (String, String)>;

fn read_class(
    source: &ClassSource,
    ctx: &ImportContext,
    seen: &mut SeenProperties,
) -> AtomicResult<ClassPlan> {
    let pointer = source.pointer.as_str();
    let schema = source.schema;

    if schema
        .get("type")
        .is_some_and(|t| t.as_str() != Some("object"))
    {
        return fail(&child(pointer, "type"), "a class must be an object schema");
    }
    if schema
        .get("additionalProperties")
        .is_some_and(|a| !matches!(a, Node::Bool(_)))
    {
        return fail(
            &child(pointer, "additionalProperties"),
            "only a boolean is supported. Atomic classes are open and never reject extra properties",
        );
    }

    let title = optional_string(schema, "title", pointer)?;
    let description = optional_string(schema, "description", pointer)?;
    let props = match schema.get("properties") {
        Some(p) => Some(as_object(p, &child(pointer, "properties"))?),
        None => None,
    };

    // The shortname of each property key, and the key it came from.
    let mut shortnames: Vec<(String, String)> = Vec::new();
    let mut properties: Vec<PropertyPlan> = Vec::new();
    let mut constraints: BTreeMap<String, Map<String, Json>> = BTreeMap::new();

    if let Some(Node::Object(entries)) = props {
        for (key, value) in entries {
            let prop_pointer = child(&child(pointer, "properties"), key);
            let Some(shortname) = slugify(key) else {
                return fail(
                    &prop_pointer,
                    format!("cannot turn '{key}' into a shortname"),
                );
            };
            if let Some((_, clash)) = shortnames.iter().find(|(s, _)| *s == shortname) {
                return fail(
                    &prop_pointer,
                    format!("'{key}' and '{clash}' both become the shortname '{shortname}'"),
                );
            }
            shortnames.push((shortname.clone(), key.clone()));

            let read = read_property(value, &prop_pointer, ctx)?;
            match seen.get(&shortname) {
                Some((at, datatype)) if *datatype != read.datatype => {
                    return fail(
                        &prop_pointer,
                        format!(
                            "'{shortname}' is {} here but {datatype} at {at}. An ontology cannot hold two properties with one shortname, so rename one",
                            read.datatype
                        ),
                    )
                }
                Some(_) => {}
                None => {
                    seen.insert(
                        shortname.clone(),
                        (prop_pointer.clone(), read.datatype.clone()),
                    );
                }
            }

            properties.push(PropertyPlan {
                shortname: shortname.clone(),
                datatype: read.datatype,
                name: read.name,
                description: read.description,
                classtype: None,
            });
            if !read.constraint.is_empty() {
                constraints.insert(shortname, read.constraint);
            }
        }
    }

    let mut requires: Vec<String> = Vec::new();
    match schema.get("required") {
        None => {}
        Some(Node::Array(required)) => {
            for (index, key) in required.iter().enumerate() {
                let at = child(&child(pointer, "required"), &index.to_string());
                let Node::String(key) = key else {
                    return fail(&at, "expected a property name");
                };
                let in_properties = props.is_some_and(|p| p.has(key));
                let shortname = slugify(key).filter(|_| in_properties);
                let Some(shortname) = shortname else {
                    return fail(&at, format!("'{key}' is required but not in properties"));
                };
                if requires.contains(&shortname) {
                    return fail(&at, format!("'{key}' is listed twice"));
                }
                requires.push(shortname);
            }
        }
        Some(_) => {
            return fail(
                &child(pointer, "required"),
                "expected an array of property names",
            )
        }
    }

    let recommends = properties
        .iter()
        .map(|p| p.shortname.clone())
        .filter(|s| !requires.contains(s))
        .collect();

    Ok(ClassPlan {
        shortname: source.shortname.clone(),
        name: title.or_else(|| source.key.clone()),
        description,
        properties,
        requires,
        recommends,
        constraints: Some(constraints),
    })
}

/// Reads a JSON Schema into an [`OntologyPlan`], keeping the order of keys.
/// `json` is the text of the schema.
pub fn ontology_from_json_schema_str(
    json: &str,
    options: &ImportOptions,
) -> AtomicResult<OntologyPlan> {
    let node: Node = serde_json::from_str(json).map_err(|e| format!("Not valid JSON: {e}"))?;
    ontology_from_node(&node, options)
}

/// Reads a parsed JSON Schema. A `serde_json::Value` has lost the order of its
/// keys (they are alphabetical), so classes and properties come out in that
/// order. Use [`ontology_from_json_schema_str`] to keep the order of the text.
pub fn ontology_from_json_schema(
    schema: &Json,
    options: &ImportOptions,
) -> AtomicResult<OntologyPlan> {
    ontology_from_node(&Node::from_json(schema), options)
}

fn ontology_from_node(root: &Node, options: &ImportOptions) -> AtomicResult<OntologyPlan> {
    let root = as_object(root, "")?;
    check_keys(root, "", &root_keys())?;

    if let Some(schema) = root.get("$schema") {
        if schema.as_str() != Some(JSON_SCHEMA_DIALECT) {
            return fail(
                "/$schema",
                format!("only {JSON_SCHEMA_DIALECT} is supported"),
            );
        }
    }

    let title = optional_string(root, "title", "")?;
    let description = optional_string(root, "description", "")?;
    let declared = optional_string(root, "x-atomic-ontology", "")?;
    let shortname = options
        .shortname
        .clone()
        .or(declared)
        .or_else(|| title.as_deref().and_then(slugify));
    let Some(shortname) = shortname.filter(|s| !s.is_empty()) else {
        return fail(
            "",
            "cannot tell the ontology's shortname: set 'x-atomic-ontology' or 'title', or pass one",
        );
    };

    let empty = Node::Object(Vec::new());
    let defs = match root.get("$defs") {
        Some(defs) => as_object(defs, "/$defs")?,
        None => &empty,
    };

    let mut sources: Vec<ClassSource> = Vec::new();
    let mut ctx = ImportContext {
        classes: Vec::new(),
    };
    let mut taken: Vec<(String, String)> = Vec::new();

    let mut claim = |name: &str, pointer: &str| -> AtomicResult<()> {
        if let Some((_, clash)) = taken.iter().find(|(n, _)| n == name) {
            return fail(
                pointer,
                format!("becomes the class shortname '{name}', like {clash}"),
            );
        }
        taken.push((
            name.to_string(),
            if pointer.is_empty() { "/" } else { pointer }.to_string(),
        ));
        Ok(())
    };

    if root.has("properties") {
        let name = title
            .as_deref()
            .and_then(slugify)
            .unwrap_or_else(|| shortname.clone());
        claim(&name, "")?;
        sources.push(ClassSource {
            pointer: String::new(),
            schema: root,
            shortname: name,
            key: None,
        });
    } else if root.has("required") {
        return fail(
            "/required",
            "required names a property, but the root has none",
        );
    }

    if let Node::Object(entries) = defs {
        for (key, def) in entries {
            let pointer = child("/$defs", key);
            let schema = as_object(def, &pointer)?;

            if schema.get("type").and_then(Node::as_str) != Some("object")
                && !schema.has("properties")
            {
                return fail(
                    &pointer,
                    "only object schemas can become classes. Inline other definitions where they are used",
                );
            }
            check_keys(schema, &pointer, &class_keys())?;

            let Some(class_shortname) = slugify(key) else {
                return fail(
                    &pointer,
                    format!("cannot turn '{key}' into a class shortname"),
                );
            };
            claim(&class_shortname, &pointer)?;
            ctx.classes.push((key.clone(), class_shortname.clone()));
            sources.push(ClassSource {
                pointer,
                schema,
                shortname: class_shortname,
                key: Some(key.clone()),
            });
        }
    }

    let mut seen = SeenProperties::new();
    let mut classes = Vec::new();
    for source in &sources {
        classes.push(read_class(source, &ctx, &mut seen)?);
    }

    Ok(OntologyPlan {
        shortname,
        name: title,
        description,
        properties: Vec::new(),
        classes,
    })
}

// ---------------------------------------------------------------------------
// Checking a plan
// ---------------------------------------------------------------------------

struct CheckedClass {
    shortname: String,
    name: String,
    description: String,
    requires: Vec<String>,
    recommends: Vec<String>,
    /// `None`: leave the class's constraints alone.
    constraints: Option<BTreeMap<String, Map<String, Json>>>,
}

struct CheckedPlan {
    properties: Vec<PropertyPlan>,
    classes: Vec<CheckedClass>,
}

fn unique(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        if !out.contains(name) {
            out.push(name.clone());
        }
    }
    out
}

/// Checks a plan and fills in what it leaves out: one entry per property
/// (identified by shortname), names and descriptions, and every class's
/// `requires` and `recommends` complete. Errors before anything is written.
fn check_plan(plan: &OntologyPlan) -> AtomicResult<CheckedPlan> {
    let slug = regex::Regex::new(SLUG_REGEX).map_err(|e| e.to_string())?;
    let mut properties: Vec<PropertyPlan> = Vec::new();

    let mut declare = |property: &PropertyPlan, place: &str| -> AtomicResult<()> {
        if !slug.is_match(&property.shortname) {
            return Err(format!(
                "{place}: invalid property shortname '{}'",
                property.shortname
            )
            .into());
        }
        if !is_known_datatype(&property.datatype) {
            return Err(format!(
                "{place}: unknown datatype '{}' for property '{}'",
                property.datatype, property.shortname
            )
            .into());
        }
        if let Some(previous) = properties
            .iter()
            .find(|p| p.shortname == property.shortname)
        {
            if previous.datatype != property.datatype {
                return Err(format!(
                    "{place}: property '{}' is declared as {} but elsewhere as {}. A property is identified by its shortname and datatype, and an ontology cannot hold two properties with one shortname",
                    property.shortname, property.datatype, previous.datatype
                )
                .into());
            }
            return Ok(());
        }
        let name = property
            .name
            .clone()
            .unwrap_or_else(|| property.shortname.clone());
        properties.push(PropertyPlan {
            shortname: property.shortname.clone(),
            datatype: property.datatype.clone(),
            description: Some(property.description.clone().unwrap_or_else(|| name.clone())),
            name: Some(name),
            classtype: property.classtype.clone().filter(|c| !c.is_empty()),
        });
        Ok(())
    };

    for property in &plan.properties {
        declare(property, "ontology")?;
    }

    let mut class_names: Vec<&str> = Vec::new();
    for class in &plan.classes {
        if class.shortname.is_empty() {
            return Err("every class needs a shortname".into());
        }
        if class_names.contains(&class.shortname.as_str()) {
            return Err(format!("duplicate class shortname '{}'", class.shortname).into());
        }
        class_names.push(&class.shortname);
        for property in &class.properties {
            declare(property, &format!("class '{}'", class.shortname))?;
        }
    }

    let mut classes = Vec::new();
    for class in &plan.classes {
        let place = format!("class '{}'", class.shortname);
        let requires = unique(&class.requires);
        let explicit = unique(&class.recommends);

        for name in requires.iter().chain(explicit.iter()) {
            if !properties.iter().any(|p| &p.shortname == name) {
                return Err(format!("{place}: '{name}' is not a declared property").into());
            }
        }
        for name in &requires {
            if explicit.contains(name) {
                return Err(format!("{place}: '{name}' is both required and recommended").into());
            }
        }

        let mut recommends = explicit.clone();
        for property in &class.properties {
            if !requires.contains(&property.shortname) && !recommends.contains(&property.shortname)
            {
                recommends.push(property.shortname.clone());
            }
        }

        let name = class
            .name
            .clone()
            .unwrap_or_else(|| class.shortname.clone());

        let mut constraints = None;
        if let Some(given) = &class.constraints {
            let mut own = BTreeMap::new();
            for (property, keywords) in given {
                if !requires.contains(property) && !recommends.contains(property) {
                    return Err(format!(
                        "{place}: constraint on '{property}', which the class neither requires nor recommends"
                    )
                    .into());
                }
                parse_constraint(&Json::Object(keywords.clone()))
                    .map_err(|e| format!("{place}: constraint on '{property}': {e}"))?;
                if let Some(Json::String(target)) = keywords.get("class") {
                    if !target.contains(':') && !class_names.contains(&target.as_str()) {
                        return Err(format!(
                            "{place}: constraint on '{property}' names class '{target}', which is not in this ontology"
                        )
                        .into());
                    }
                }
                own.insert(property.clone(), keywords.clone());
            }
            constraints = Some(own);
        }

        classes.push(CheckedClass {
            shortname: class.shortname.clone(),
            description: class.description.clone().unwrap_or_else(|| name.clone()),
            name,
            requires,
            recommends,
            constraints,
        });
    }

    Ok(CheckedPlan {
        properties,
        classes,
    })
}

// ---------------------------------------------------------------------------
// Ensure
// ---------------------------------------------------------------------------

fn commit_opts(agent: &Agent) -> CommitOpts {
    CommitOpts {
        validate_schema: true,
        validate_constraints: true,
        validate_signature: true,
        validate_timestamp: false,
        validate_rights: false,
        validate_loro_causality: false,
        update_index: true,
        validate_for_agent: Some(agent.subject.to_string()),
        source_id: None,
    }
}

fn subjects_value(subjects: &[String]) -> Value {
    Value::ResourceArray(subjects.iter().map(|s| s.as_str().into()).collect())
}

/// Creates a resource with a `did:ad:` subject, returning the subject.
async fn create_did(
    store: &impl Storelike,
    agent: &Agent,
    set: Vec<(&str, Value)>,
) -> AtomicResult<String> {
    let mut builder = CommitBuilder::new("placeholder".into());
    for (property, value) in set {
        builder.set(property.into(), value);
    }
    let commit = Commit::create_did(builder, agent, store).await?;
    let response = store.apply_commit(commit, &commit_opts(agent)).await?;
    Ok(response
        .resource_new
        .ok_or("The commit created no resource")?
        .get_subject()
        .to_string())
}

/// Changes properties of an existing resource.
async fn edit(
    store: &impl Storelike,
    agent: &Agent,
    subject: &str,
    set: Vec<(&str, Value)>,
) -> AtomicResult<()> {
    let mut builder = CommitBuilder::new(subject.into());
    for (property, value) in set {
        builder.set(property.into(), value);
    }
    let existing = store.get_resource(&subject.into()).await?;
    let commit = builder.sign(agent, store, &existing).await?;
    store.apply_commit(commit, &commit_opts(agent)).await?;
    Ok(())
}

fn subjects_of(resource: &crate::Resource, property: &str) -> Vec<String> {
    resource
        .get(property)
        .ok()
        .and_then(|v| v.to_subjects(None).ok())
        .unwrap_or_default()
}

fn same_subjects(a: &[String], b: &[String]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| canonicalize_scheme(x) == canonicalize_scheme(y))
}

/// A listed class of the ontology with this shortname, else one saved with this localId.
async fn find_class(
    store: &impl Storelike,
    ontology: &crate::Resource,
    shortname: &str,
) -> AtomicResult<Option<String>> {
    let mut found: Option<String> = None;
    for subject in subjects_of(ontology, urls::CLASSES) {
        let resource = store.get_resource(&subject.as_str().into()).await?;
        let listed = resource.get(urls::SHORTNAME).map(|v| v.to_string()).ok();
        if listed.as_deref() == Some(shortname) {
            if found.as_ref().is_some_and(|f| *f != subject) {
                return Err(format!("ambiguous schema shortname: {shortname}").into());
            }
            found = Some(subject);
        }
    }
    if found.is_some() {
        return Ok(found);
    }
    crate::import_identity::find_existing(
        store,
        ontology.get_subject(),
        &format!("schema:class:{shortname}"),
    )
    .await
}

/// Makes an [`OntologyPlan`] real under `parent`: the Ontology resource, its
/// content-addressed Properties (`atomic:prop:` subjects from
/// [`property_id`]) and its Classes with `requires`, `recommends` and
/// `constraints`. All commits are signed by `agent`.
///
/// Idempotent, like `ensureOntology` in `@tomic/lib`: the Ontology is found
/// again by its shortname under `parent`, a Property by its subject, a Class by
/// its shortname in the ontology. On an existing class `requires`, `recommends`
/// and (when the plan has `constraints`) the constraints are brought back in
/// line; names and descriptions are left alone. Errors before writing anything
/// when the plan is inconsistent.
pub async fn ensure_ontology(
    store: &impl Storelike,
    parent: &Subject,
    plan: &OntologyPlan,
    agent: &Agent,
) -> AtomicResult<EnsuredOntology> {
    let checked = check_plan(plan)?;

    // The ontology.
    let local_id = format!("schema:ontology:{}", plan.shortname);
    let ontology = match crate::import_identity::find_existing(store, parent, &local_id).await? {
        Some(subject) => subject,
        None => {
            let name = plan.name.clone().unwrap_or_else(|| plan.shortname.clone());
            create_did(
                store,
                agent,
                vec![
                    (
                        urls::IS_A,
                        Value::ResourceArray(vec![urls::ONTOLOGY.into()]),
                    ),
                    (urls::PARENT, Value::AtomicUrl(parent.clone())),
                    (urls::SHORTNAME, Value::Slug(plan.shortname.clone())),
                    (
                        urls::DESCRIPTION,
                        Value::Markdown(plan.description.clone().unwrap_or_else(|| name.clone())),
                    ),
                    (urls::NAME, Value::String(name)),
                    (urls::LOCAL_ID, Value::String(local_id)),
                ],
            )
            .await?
        }
    };
    let ontology_resource = store.get_resource(&ontology.as_str().into()).await?;
    let drive = ontology_resource
        .get(urls::DRIVE_PROP)
        .map(|v| v.to_string())
        .unwrap_or_else(|_| ontology.clone());

    // The properties: their subject follows from ontology, shortname and datatype.
    let mut properties = BTreeMap::new();
    for property in &checked.properties {
        let id = property_id(&ontology, &property.shortname, &property.datatype)?;
        if store.get_resource(&id.as_str().into()).await.is_err() {
            let mut builder = CommitBuilder::new(id.as_str().into());
            builder.is_genesis = true;
            let mut set = vec![
                (
                    urls::IS_A,
                    Value::ResourceArray(vec![urls::PROPERTY.into()]),
                ),
                (urls::PARENT, Value::AtomicUrl(ontology.as_str().into())),
                (urls::DRIVE_PROP, Value::AtomicUrl(drive.as_str().into())),
                (urls::SHORTNAME, Value::Slug(property.shortname.clone())),
                (
                    urls::DATATYPE_PROP,
                    Value::AtomicUrl(property.datatype.as_str().into()),
                ),
                (
                    urls::NAME,
                    Value::String(property.name.clone().unwrap_or_default()),
                ),
                (
                    urls::DESCRIPTION,
                    Value::Markdown(property.description.clone().unwrap_or_default()),
                ),
                (
                    urls::LOCAL_ID,
                    Value::String(format!("schema:property:{}", property.shortname)),
                ),
            ];
            if let Some(classtype) = &property.classtype {
                set.push((
                    urls::CLASSTYPE_PROP,
                    Value::AtomicUrl(classtype.as_str().into()),
                ));
            }
            for (key, value) in set {
                builder.set(key.into(), value);
            }
            let commit = builder
                .sign(agent, store, &crate::Resource::new(id.clone()))
                .await?;
            if let Err(error) = store.apply_commit(commit, &commit_opts(agent)).await {
                // Another device may have made the same property meanwhile.
                if store.get_resource(&id.as_str().into()).await.is_err() {
                    return Err(error);
                }
            }
        }
        properties.insert(property.shortname.clone(), id);
    }

    // The classes, without constraints: those may point at any other class.
    let mut classes = BTreeMap::new();
    for class in &checked.classes {
        let requires: Vec<String> = class
            .requires
            .iter()
            .map(|n| properties[n].clone())
            .collect();
        let recommends: Vec<String> = class
            .recommends
            .iter()
            .map(|n| properties[n].clone())
            .collect();

        let subject = match find_class(store, &ontology_resource, &class.shortname).await? {
            Some(subject) => {
                let existing = store.get_resource(&subject.as_str().into()).await?;
                let mut set = Vec::new();
                if !same_subjects(&subjects_of(&existing, urls::REQUIRES), &requires) {
                    set.push((urls::REQUIRES, subjects_value(&requires)));
                }
                if !same_subjects(&subjects_of(&existing, urls::RECOMMENDS), &recommends) {
                    set.push((urls::RECOMMENDS, subjects_value(&recommends)));
                }
                if !set.is_empty() {
                    edit(store, agent, &subject, set).await?;
                }
                subject
            }
            None => {
                create_did(
                    store,
                    agent,
                    vec![
                        (urls::IS_A, Value::ResourceArray(vec![urls::CLASS.into()])),
                        (urls::PARENT, Value::AtomicUrl(ontology.as_str().into())),
                        (urls::SHORTNAME, Value::Slug(class.shortname.clone())),
                        (urls::NAME, Value::String(class.name.clone())),
                        (
                            urls::DESCRIPTION,
                            Value::Markdown(class.description.clone()),
                        ),
                        (urls::REQUIRES, subjects_value(&requires)),
                        (urls::RECOMMENDS, subjects_value(&recommends)),
                        (
                            urls::LOCAL_ID,
                            Value::String(format!("schema:class:{}", class.shortname)),
                        ),
                    ],
                )
                .await?
            }
        };
        classes.insert(class.shortname.clone(), subject);
    }

    // The constraints, now that every class has a subject.
    for class in &checked.classes {
        let Some(own) = &class.constraints else {
            continue;
        };
        let mut desired = Map::new();
        for (property, keywords) in own {
            let mut resolved = keywords.clone();
            if let Some(Json::String(target)) = keywords.get("class") {
                if !target.contains(':') {
                    resolved.insert(
                        "class".into(),
                        Json::String(canonicalize_scheme(&classes[target])),
                    );
                }
            }
            desired.insert(
                canonicalize_scheme(&properties[property]),
                Json::Object(resolved),
            );
        }
        let desired = Json::Object(desired);

        let subject = &classes[&class.shortname];
        let resource = store.get_resource(&subject.as_str().into()).await?;
        let current = match resource.get(urls::CONSTRAINTS) {
            Ok(Value::Json(json)) => Some(json.clone()),
            Ok(Value::String(s)) | Ok(Value::Markdown(s)) => serde_json::from_str(s).ok(),
            _ => None,
        };
        let same = match &current {
            Some(current) => *current == desired,
            None => desired.as_object().is_some_and(Map::is_empty),
        };
        if !same {
            edit(
                store,
                agent,
                subject,
                vec![(urls::CONSTRAINTS, Value::Json(desired))],
            )
            .await?;
        }
    }

    // List the terms on the ontology, in plan order.
    let mut set = Vec::new();
    for (property, wanted) in [
        (
            urls::PROPERTIES,
            checked
                .properties
                .iter()
                .map(|p| properties[&p.shortname].clone())
                .collect::<Vec<_>>(),
        ),
        (
            urls::CLASSES,
            checked
                .classes
                .iter()
                .map(|c| classes[&c.shortname].clone())
                .collect::<Vec<_>>(),
        ),
    ] {
        let mut listed = subjects_of(&ontology_resource, property);
        let before = listed.len();
        for subject in wanted {
            if !listed
                .iter()
                .any(|s| canonicalize_scheme(s) == canonicalize_scheme(&subject))
            {
                listed.push(subject);
            }
        }
        if listed.len() != before {
            set.push((property, subjects_value(&listed)));
        }
    }
    if !set.is_empty() {
        edit(store, agent, &ontology, set).await?;
    }

    Ok(EnsuredOntology {
        ontology,
        classes,
        properties,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/json-schema-interop.json");

    /// The fixture as ordered JSON: the order of properties is part of the plan.
    fn fixture() -> Node {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn cases(kind: &str) -> Vec<Node> {
        match fixture().get(kind) {
            Some(Node::Array(cases)) => cases.clone(),
            _ => panic!("no {kind} in the fixture"),
        }
    }

    fn options(case: &Node) -> ImportOptions {
        ImportOptions {
            shortname: case
                .get("options")
                .and_then(|o| o.get("shortname"))
                .and_then(Node::as_str)
                .map(String::from),
        }
    }

    fn text(case: &Node, key: &str) -> String {
        case.get(key)
            .and_then(Node::as_str)
            .unwrap_or("")
            .to_string()
    }

    fn import(case: &Node) -> AtomicResult<OntologyPlan> {
        ontology_from_node(case.get("schema").unwrap(), &options(case))
    }

    #[test]
    fn slugify_cases() {
        for (raw, slug) in [
            ("LineItem", Some("line-item")),
            ("line_item", Some("line-item")),
            ("line item", Some("line-item")),
            ("HTMLParser", Some("html-parser")),
            ("unitPrice", Some("unit-price")),
            ("abc123Def", Some("abc123-def")),
            ("--a--b--", Some("a-b")),
            ("Task list", Some("task-list")),
            ("***", None),
            ("", None),
        ] {
            assert_eq!(slugify(raw).as_deref(), slug, "{raw}");
        }
    }

    #[test]
    fn fixture_imports_to_the_plan() {
        let cases = cases("cases");
        assert!(cases.len() > 5);
        for case in &cases {
            let name = text(case, "name");
            let plan = import(case).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(
                serde_json::to_value(&plan).unwrap(),
                case.get("plan").unwrap().to_json(),
                "{name}"
            );
        }
    }

    #[test]
    fn fixture_rejects_with_the_pointer() {
        let rejected = cases("rejected");
        assert!(rejected.len() > 20);
        for case in &rejected {
            let name = text(case, "name");
            let error = import(case).expect_err(&name).to_string();
            let pointer = text(case, "pointer");
            let pointer = if pointer.is_empty() { "/" } else { &pointer };
            assert!(
                error.contains(&format!("JSON Schema at {pointer}:")),
                "{name}: {error}"
            );
            assert!(error.contains(&text(case, "message")), "{name}: {error}");
        }
    }

    #[test]
    fn a_parsed_value_imports_in_alphabetical_order() {
        let schema = serde_json::json!({
            "x-atomic-ontology": "o",
            "$defs": { "a": { "type": "object", "properties": {
                "zed": { "type": "string" }, "alpha": { "type": "string" } } } }
        });
        let plan = ontology_from_json_schema(&schema, &ImportOptions::default()).unwrap();
        let names: Vec<_> = plan.classes[0]
            .properties
            .iter()
            .map(|p| p.shortname.as_str())
            .collect();
        assert_eq!(names, ["alpha", "zed"]);
    }

    #[test]
    fn a_plan_must_be_consistent() {
        let prop = |shortname: &str, datatype: &str| PropertyPlan {
            shortname: shortname.into(),
            datatype: datatype.into(),
            ..Default::default()
        };
        let class = |shortname: &str, properties: Vec<PropertyPlan>| ClassPlan {
            shortname: shortname.into(),
            properties,
            ..Default::default()
        };
        let plan = |classes: Vec<ClassPlan>| OntologyPlan {
            shortname: "o".into(),
            classes,
            ..Default::default()
        };

        let two_datatypes = plan(vec![
            class("a", vec![prop("id", urls::STRING)]),
            class("b", vec![prop("id", urls::INTEGER)]),
        ]);
        assert!(check_plan(&two_datatypes)
            .err()
            .unwrap()
            .to_string()
            .contains("cannot hold two properties"));

        let mut missing = class("a", vec![]);
        missing.requires = vec!["nope".into()];
        assert!(check_plan(&plan(vec![missing]))
            .err()
            .unwrap()
            .to_string()
            .contains("not a declared property"));

        let mut typo = class("a", vec![prop("x", urls::STRING)]);
        typo.constraints = Some(BTreeMap::from([(
            "x".to_string(),
            serde_json::from_str(r#"{"minimun": 1}"#).unwrap(),
        )]));
        assert!(check_plan(&plan(vec![typo]))
            .err()
            .unwrap()
            .to_string()
            .contains("Unknown constraint keyword"));

        let mut no_class = class("a", vec![prop("x", urls::ATOMIC_URL)]);
        no_class.constraints = Some(BTreeMap::from([(
            "x".to_string(),
            serde_json::from_str(r#"{"class": "nope"}"#).unwrap(),
        )]));
        assert!(check_plan(&plan(vec![no_class]))
            .err()
            .unwrap()
            .to_string()
            .contains("not in this ontology"));
    }

    #[cfg(feature = "db")]
    mod ensure {
        use super::*;

        const SHOP: usize = 0;

        async fn setup() -> (crate::Db, Subject, Agent) {
            let store = crate::test_utils::init_store().await;
            let parent = crate::test_utils::create_test_drive(&store).await.unwrap();
            let agent = store.get_default_agent().unwrap();
            (store, parent, agent)
        }

        fn shop_plan() -> OntologyPlan {
            import(&cases("cases")[SHOP]).unwrap()
        }

        #[tokio::test]
        async fn creates_the_ontology_with_content_addressed_properties() {
            let (store, parent, agent) = setup().await;
            let ensured = ensure_ontology(&store, &parent, &shop_plan(), &agent)
                .await
                .unwrap();

            assert_eq!(
                ensured
                    .classes
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                ["customer", "invoice", "line-item"]
            );
            assert_eq!(
                ensured.properties["number"],
                property_id(&ensured.ontology, "number", urls::STRING).unwrap()
            );
            assert_eq!(
                ensured.properties["amount"],
                property_id(&ensured.ontology, "amount", urls::FLOAT).unwrap()
            );

            let property = store
                .get_property(&ensured.properties["number"])
                .await
                .unwrap();
            assert_eq!(property.shortname, "number");
            assert_eq!(property.data_type, DataType::String);

            let ontology = store
                .get_resource(&ensured.ontology.as_str().into())
                .await
                .unwrap();
            assert_eq!(subjects_of(&ontology, urls::CLASSES).len(), 3);
            // `notes` is declared by two classes and is one property.
            assert_eq!(subjects_of(&ontology, urls::PROPERTIES).len(), 15);
        }

        #[tokio::test]
        async fn requires_recommends_and_constraints_land_on_the_class() {
            let (store, parent, agent) = setup().await;
            let ensured = ensure_ontology(&store, &parent, &shop_plan(), &agent)
                .await
                .unwrap();

            let invoice = store
                .get_resource(&ensured.classes["invoice"].as_str().into())
                .await
                .unwrap();
            assert_eq!(
                subjects_of(&invoice, urls::REQUIRES),
                [
                    ensured.properties["number"].clone(),
                    ensured.properties["customer"].clone()
                ]
            );

            let constraints = crate::class_constraints::constraints_of(&invoice)
                .unwrap()
                .unwrap();
            let amount = &constraints[&ensured.properties["amount"]];
            assert_eq!(amount.minimum, Some(0.0));
            assert_eq!(amount.exclusive_maximum, Some(100000.0));
            assert_eq!(
                constraints[&ensured.properties["customer"]]
                    .class
                    .as_deref(),
                Some(canonicalize_scheme(&ensured.classes["customer"]).as_str())
            );

            // The class enforces what it holds.
            let mut bad = crate::Resource::new_generate_subject(&store).unwrap();
            bad.set_unsafe(
                urls::IS_A.into(),
                Value::ResourceArray(vec![ensured.classes["customer"].as_str().into()]),
            )
            .unwrap();
            bad.set_unsafe(
                ensured.properties["name"].clone(),
                Value::String(String::new()),
            )
            .unwrap();
            let error = bad.save_locally(&store).await.unwrap_err().to_string();
            assert!(error.contains("minLength"), "{error}");
        }

        #[tokio::test]
        async fn a_second_run_changes_nothing() {
            let (store, parent, agent) = setup().await;
            let plan = shop_plan();
            let first = ensure_ontology(&store, &parent, &plan, &agent)
                .await
                .unwrap();

            let snapshot = |store: &crate::Db, subjects: Vec<String>| {
                let store = store.clone();
                async move {
                    let mut out = Vec::new();
                    for subject in subjects {
                        let resource = store.get_resource(&subject.as_str().into()).await.unwrap();
                        out.push(resource.get(urls::LAST_COMMIT).unwrap().to_string());
                    }
                    out
                }
            };
            let mut subjects: Vec<String> = vec![first.ontology.clone()];
            subjects.extend(first.classes.values().cloned());
            subjects.extend(first.properties.values().cloned());
            let before = snapshot(&store, subjects.clone()).await;

            let second = ensure_ontology(&store, &parent, &plan, &agent)
                .await
                .unwrap();
            assert_eq!(second, first);
            assert_eq!(snapshot(&store, subjects).await, before);
        }

        #[tokio::test]
        async fn an_existing_class_is_brought_back_in_line() {
            let (store, parent, agent) = setup().await;
            let mut plan = shop_plan();
            let first = ensure_ontology(&store, &parent, &plan, &agent)
                .await
                .unwrap();

            let customer = &mut plan.classes[0];
            customer.requires.push("email".into());
            customer.recommends.retain(|r| r != "email");
            customer.constraints = Some(BTreeMap::new());
            let second = ensure_ontology(&store, &parent, &plan, &agent)
                .await
                .unwrap();
            assert_eq!(second, first);

            let customer = store
                .get_resource(&first.classes["customer"].as_str().into())
                .await
                .unwrap();
            assert_eq!(subjects_of(&customer, urls::REQUIRES).len(), 2);
            let constraints = crate::class_constraints::constraints_of(&customer)
                .unwrap()
                .unwrap();
            assert!(constraints.is_empty());
        }
    }
}
