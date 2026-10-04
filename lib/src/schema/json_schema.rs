//! Bounded JSON Schema 2020-12 interchange. Never fetches references or runs code.
use super::{
    app::{AppSchema, Field, SHAPE},
    shape::Shape,
};
use crate::errors::AtomicResult;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as Json};
use std::collections::BTreeMap;

pub const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";
pub const LINK_PATTERN: &str = "^(atomic:(?!//)|did:ad:|https?://)";
const SAFE: f64 = 9007199254740991.;
const MAX_BYTES: usize = 1024 * 1024;
fn fail(path: &str, message: &str) -> crate::errors::AtomicError {
    format!(
        "JSON Schema at {}: {message}",
        if path.is_empty() { "/" } else { path }
    )
    .into()
}
fn child(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}
fn bound(value: &Json) -> AtomicResult<()> {
    fn visit(
        value: &Json,
        depth: usize,
        budget: &mut usize,
        bytes: &mut usize,
    ) -> AtomicResult<()> {
        if depth > 64 || *budget == 0 {
            return Err(fail("", "document exceeds depth/node budget"));
        }
        *budget -= 1;
        if let Json::String(s) = value {
            *bytes = bytes
                .checked_sub(s.len())
                .ok_or_else(|| fail("", "document exceeds 1 MiB"))?;
        }
        match value {
            Json::Array(a) => {
                for v in a {
                    visit(v, depth + 1, budget, bytes)?;
                }
            }
            Json::Object(m) => {
                for (k, v) in m {
                    *bytes = bytes
                        .checked_sub(k.len())
                        .ok_or_else(|| fail("", "document exceeds 1 MiB"))?;
                    visit(v, depth + 1, budget, bytes)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut bytes = MAX_BYTES;
    visit(value, 0, &mut 32768, &mut bytes)?;
    if serde_json::to_vec(value)?.len() > MAX_BYTES {
        return Err(fail("", "document exceeds 1 MiB"));
    }
    Ok(())
}
struct Reader<'a> {
    root: &'a Json,
    nodes: usize,
    refs: Vec<String>,
}
impl Reader<'_> {
    fn read(&mut self, value: &Json, path: &str, depth: usize) -> AtomicResult<Shape> {
        if depth > 16 || self.nodes == 0 {
            return Err(fail(path, "expanded schema exceeds depth/node budget"));
        }
        self.nodes -= 1;
        let m = value.as_object().ok_or_else(|| {
            fail(
                path,
                "expected a schema object; boolean schemas are unsupported",
            )
        })?;
        for (key, value) in m {
            if ![
                "$schema",
                "$id",
                "$defs",
                "title",
                "description",
                "$comment",
                "default",
                "examples",
                "$ref",
                "anyOf",
                "type",
                "enum",
                "const",
                "properties",
                "required",
                "additionalProperties",
                "items",
                "maxItems",
                "maxLength",
                "minimum",
                "maximum",
                "format",
                "pattern",
                "x-atomic-link",
            ]
            .contains(&key.as_str())
            {
                return Err(fail(&child(path, key), "unsupported keyword"));
            }
            if matches!(key.as_str(), "title" | "description" | "$comment") && !value.is_string() {
                return Err(fail(&child(path, key), "expected annotation string"));
            }
            if key == "examples" && !value.is_array() {
                return Err(fail(&child(path, key), "expected examples array"));
            }
            if key == "$schema" && (!path.is_empty() || value != DIALECT) {
                return Err(fail(
                    &child(path, key),
                    "only root JSON Schema 2020-12 is supported",
                ));
            }
            if key == "$id"
                && (!path.is_empty()
                    || !value.is_string()
                    || url::Url::parse(value.as_str().unwrap_or_default()).is_err())
            {
                return Err(fail(
                    &child(path, key),
                    "only an absolute root $id is supported",
                ));
            }
            if key == "$defs" && (!path.is_empty() || !value.is_object()) {
                return Err(fail(&child(path, key), "only root $defs are supported"));
            }
        }
        let allowed = |extra: &[&str]| -> AtomicResult<()> {
            for key in m.keys() {
                if ![
                    "$schema",
                    "$id",
                    "$defs",
                    "title",
                    "description",
                    "$comment",
                    "default",
                    "examples",
                ]
                .contains(&key.as_str())
                    && !extra.contains(&key.as_str())
                {
                    return Err(fail(
                        &child(path, key),
                        "unsupported keyword or keyword combination",
                    ));
                }
            }
            Ok(())
        };
        if let Some(reference) = m.get("$ref") {
            allowed(&["$ref"])?;
            let reference = reference
                .as_str()
                .ok_or_else(|| fail(path, "$ref must be a string"))?;
            let token = reference
                .strip_prefix("#/$defs/")
                .filter(|v| !v.is_empty() && !v.contains('/') && !v.contains('%'))
                .ok_or_else(|| fail(path, "only local #/$defs/name references are supported"))?;
            let mut name = String::new();
            let mut chars = token.chars();
            while let Some(c) = chars.next() {
                if c == '~' {
                    name.push(match chars.next() {
                        Some('0') => '~',
                        Some('1') => '/',
                        _ => return Err(fail(path, "invalid JSON Pointer escape")),
                    });
                } else {
                    name.push(c);
                }
            }
            if self.refs.iter().any(|r| r == reference) {
                return Err(fail(path, "recursive references are unsupported"));
            }
            let target = self
                .root
                .get("$defs")
                .and_then(|d| d.get(&name))
                .ok_or_else(|| fail(path, "unresolved local reference"))?;
            self.refs.push(reference.into());
            let result = self.read(target, &format!("/$defs/{token}"), depth + 1);
            self.refs.pop();
            return result;
        }
        if let Some(variants) = m.get("anyOf") {
            allowed(&["anyOf"])?;
            let variants = variants
                .as_array()
                .filter(|v| (2..=8).contains(&v.len()))
                .ok_or_else(|| fail(path, "anyOf needs 2-8 alternatives"))?;
            return Ok(Shape::Union {
                variants: variants
                    .iter()
                    .enumerate()
                    .map(|(i, v)| self.read(v, &format!("{path}/anyOf/{i}"), depth + 1))
                    .collect::<AtomicResult<_>>()?,
            });
        }
        if let Some(types) = m.get("type").and_then(Json::as_array) {
            if m.contains_key("enum") || m.contains_key("const") {
                return Err(fail(
                    path,
                    "type arrays combined with enum/const are unsupported",
                ));
            }
            if types.len() != 2 || types.iter().filter(|v| **v == "null").count() != 1 {
                return Err(fail(
                    path,
                    "type arrays must contain one type and null; use anyOf for other unions",
                ));
            }
            let base = types.iter().find(|v| **v != "null").unwrap();
            if !base.is_string() {
                return Err(fail(path, "type must be a string"));
            }
            let mut inner = m.clone();
            inner.insert("type".into(), base.clone());
            // Metadata belongs to the original root, not a synthetic child.
            for key in ["$schema", "$id", "$defs"] {
                inner.remove(key);
            }
            return Ok(Shape::Nullable {
                inner: Box::new(self.read(
                    &Json::Object(inner),
                    &child(path, "type"),
                    depth + 1,
                )?),
            });
        }
        if m.contains_key("enum") || m.contains_key("const") {
            allowed(&["type", "enum", "const"])?;
            if m.contains_key("enum") && m.contains_key("const")
                || m.get("type").is_some_and(|t| t != "string")
            {
                return Err(fail(path, "only string enum or string const is supported"));
            }
            let values = if let Some(v) = m.get("enum") {
                v.as_array()
                    .ok_or_else(|| fail(path, "enum must be an array"))?
                    .clone()
            } else {
                vec![m["const"].clone()]
            };
            let shape = Shape::Enum {
                values: values
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(String::from)
                            .ok_or_else(|| fail(path, "only string enum values are supported"))
                    })
                    .collect::<AtomicResult<_>>()?,
            };
            shape.check().map_err(|e| fail(path, &e.to_string()))?;
            return Ok(shape);
        }
        let kind = m
            .get("type")
            .and_then(Json::as_str)
            .ok_or_else(|| fail(path, "explicit type is required"))?;
        let shape = match kind {
            "object" => {
                allowed(&["type", "properties", "required", "additionalProperties"])?;
                let props = match m.get("properties") {
                    None => Map::new(),
                    Some(v) => v
                        .as_object()
                        .ok_or_else(|| fail(path, "properties must be an object"))?
                        .clone(),
                };
                let required = match m.get("required") {
                    None => vec![],
                    Some(v) => v
                        .as_array()
                        .ok_or_else(|| fail(path, "required must be an array"))?
                        .iter()
                        .map(|v| {
                            v.as_str()
                                .map(String::from)
                                .ok_or_else(|| fail(path, "required names must be strings"))
                        })
                        .collect::<AtomicResult<Vec<_>>>()?,
                };
                if required
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    != required.len()
                {
                    return Err(fail(path, "required names must be unique"));
                }
                let additional_properties = match m.get("additionalProperties") {
                    None => true,
                    Some(v) => v.as_bool().ok_or_else(|| {
                        fail(path, "schema-valued additionalProperties is unsupported")
                    })?,
                };
                Shape::Object {
                    properties: props
                        .iter()
                        .map(|(k, v)| {
                            Ok((
                                k.clone(),
                                self.read(v, &child(&child(path, "properties"), k), depth + 1)?,
                            ))
                        })
                        .collect::<AtomicResult<_>>()?,
                    required,
                    additional_properties,
                }
            }
            "array" => {
                allowed(&["type", "items", "maxItems"])?;
                Shape::Array {
                    items: Box::new(
                        self.read(
                            m.get("items")
                                .ok_or_else(|| fail(path, "items is required"))?,
                            &child(path, "items"),
                            depth + 1,
                        )?,
                    ),
                    max_items: m
                        .get("maxItems")
                        .and_then(Json::as_f64)
                        .filter(|n| *n >= 0. && *n <= 16384. && n.fract() == 0.)
                        .ok_or_else(|| {
                            fail(
                                &child(path, "maxItems"),
                                "an explicit integer maxItems between 0 and 16384 is required",
                            )
                        })? as usize,
                }
            }
            "string" => {
                if m.get("x-atomic-link") == Some(&json!(true)) {
                    allowed(&["type", "format", "pattern", "x-atomic-link"])?;
                    if m.get("format") != Some(&json!("uri"))
                        || m.get("pattern") != Some(&json!(LINK_PATTERN))
                    {
                        return Err(fail(
                            path,
                            "Atomic links require format uri and the Atomic URI pattern",
                        ));
                    }
                    Shape::Reference
                } else {
                    allowed(&["type", "maxLength"])?;
                    Shape::String {
                        max_length: match m.get("maxLength") {
                            None => None,
                            Some(v) => Some(
                                v.as_f64()
                                    .filter(|n| *n >= 0. && *n <= SAFE && n.fract() == 0.)
                                    .ok_or_else(|| {
                                        fail(path, "maxLength must be a nonnegative safe integer")
                                    })? as usize,
                            ),
                        },
                    }
                }
            }
            "integer" | "number" => {
                allowed(&["type", "minimum", "maximum"])?;
                let number = |key: &str| -> AtomicResult<Option<f64>> {
                    m.get(key)
                        .map(|v| {
                            v.as_f64()
                                .filter(|n| n.is_finite())
                                .ok_or_else(|| fail(&child(path, key), "expected finite number"))
                        })
                        .transpose()
                };
                let minimum = number("minimum")?;
                let maximum = number("maximum")?;
                if kind == "integer" {
                    if minimum.is_none_or(|n| n < -SAFE) || maximum.is_none_or(|n| n > SAFE) {
                        return Err(fail(path,"integer requires explicit minimum/maximum within JavaScript's safe range"));
                    }
                    Shape::Integer { minimum, maximum }
                } else {
                    Shape::Number { minimum, maximum }
                }
            }
            "boolean" => {
                allowed(&["type"])?;
                Shape::Boolean
            }
            "null" => {
                allowed(&["type"])?;
                Shape::Null
            }
            _ => return Err(fail(&child(path, "type"), "unsupported type")),
        };
        shape.check().map_err(|e| fail(path, &e.to_string()))?;
        Ok(shape)
    }
}
impl Shape {
    pub fn from_json_schema(schema: &Json) -> AtomicResult<Self> {
        bound(schema)?;
        let mut reader = Reader {
            root: schema,
            nodes: 2048,
            refs: vec![],
        };
        let shape = reader.read(schema, "", 0)?;
        if let Some(defs) = schema.get("$defs").and_then(Json::as_object) {
            for (name, value) in defs {
                reader.read(value, &child("/$defs", name), 1)?;
            }
        }
        shape.check()?;
        Ok(shape)
    }
    pub fn to_json_schema(&self) -> AtomicResult<Json> {
        self.check()?;
        Ok(match self {
            Shape::String {
                max_length: Some(n),
            } if *n as u128 > 9007199254740991 => {
                return Err(fail(
                    "/maxLength",
                    "maxLength exceeds the safe integer range",
                ));
            }
            Shape::Enum { values } => json!({"type":"string","enum":values}),
            Shape::Nullable { inner } => json!({"anyOf":[inner.to_json_schema()?,{"type":"null"}]}),
            Shape::Union { variants } => {
                json!({"anyOf":variants.iter().map(Shape::to_json_schema).collect::<AtomicResult<Vec<_>>>()?})
            }
            Shape::Reference => {
                json!({"type":"string","format":"uri","pattern":LINK_PATTERN,"x-atomic-link":true})
            }
            Shape::Object {
                properties,
                required,
                additional_properties,
            } => {
                json!({"type":"object","properties":properties.iter().map(|(k,v)|Ok((k.clone(),v.to_json_schema()?))).collect::<AtomicResult<BTreeMap<_,_>>>()?,"required":required,"additionalProperties":additional_properties})
            }
            Shape::Array { items, max_items } => {
                json!({"type":"array","items":items.to_json_schema()?,"maxItems":max_items})
            }
            Shape::Integer { minimum, maximum } => {
                json!({"type":"integer","minimum":minimum.unwrap_or(-SAFE).max(-SAFE),"maximum":maximum.unwrap_or(SAFE).min(SAFE)})
            }
            other => serde_json::to_value(other)?,
        })
    }
}
/// Standard JSON Schema and a separate verified identity sidecar. Import retains
/// original bundles only when the schema's normalized constraints still match.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JsonSchemaDocument {
    pub schema: Json,
    pub atomic: AppSchema,
}
impl AppSchema {
    pub fn from_json_schema(name: &str, schema: &Json) -> AtomicResult<Self> {
        let Shape::Object {
            properties,
            required,
            additional_properties,
        } = Shape::from_json_schema(schema)?
        else {
            return Err(fail("", "app schema root must be an object"));
        };
        if additional_properties {
            return Err(fail(
                "/additionalProperties",
                "app roots require explicit false; open nested objects are supported",
            ));
        }
        Self::define(
            name,
            properties
                .into_iter()
                .map(|(name, shape)| {
                    let is_required = required.contains(&name);
                    (
                        name,
                        Field {
                            shape,
                            required: is_required,
                        },
                    )
                })
                .collect(),
        )
    }
    pub fn to_json_schema(&self) -> AtomicResult<Json> {
        self.check()?;
        let mut properties = BTreeMap::new();
        let mut required = vec![];
        for (alias, id) in &self.fields {
            properties.insert(
                alias.clone(),
                serde_json::from_value(self.definitions[id][SHAPE].clone())?,
            );
            if self.binding(alias)?.required {
                required.push(alias.clone());
            }
        }
        let mut schema = Shape::Object {
            properties,
            required,
            additional_properties: false,
        }
        .to_json_schema()?;
        schema
            .as_object_mut()
            .unwrap()
            .insert("$schema".into(), json!(DIALECT));
        bound(&schema)?;
        Ok(schema)
    }
    pub fn export_json_schema(&self) -> AtomicResult<JsonSchemaDocument> {
        let document = JsonSchemaDocument {
            schema: self.to_json_schema()?,
            atomic: self.clone(),
        };
        bound(&serde_json::to_value(&document)?)?;
        Ok(document)
    }
}
impl JsonSchemaDocument {
    pub fn import(&self) -> AtomicResult<AppSchema> {
        bound(&serde_json::to_value(self)?)?;
        self.atomic.check()?;
        let expected = Shape::from_json_schema(&self.atomic.to_json_schema()?)?.to_json_schema()?;
        let actual = Shape::from_json_schema(&self.schema)?.to_json_schema()?;
        if normalized_constraints(expected) != normalized_constraints(actual) {
            return Err(fail("","schema constraints do not match the immutable Atomic bindings; define a new schema version"));
        }
        Ok(self.atomic.clone())
    }
}

fn normalized_constraints(value: Json) -> Json {
    match value {
        Json::Array(items) => Json::Array(items.into_iter().map(normalized_constraints).collect()),
        Json::Object(map) => Json::Object(
            map.into_iter()
                .map(|(k, v)| {
                    let mut value = normalized_constraints(v);
                    if ["required", "enum", "anyOf"].contains(&k.as_str()) {
                        if let Some(items) = value.as_array_mut() {
                            items.sort_by_key(|item| {
                                serde_jcs::to_string(item)
                                    .unwrap_or_default()
                                    .encode_utf16()
                                    .collect::<Vec<_>>()
                            });
                        }
                    }
                    (k, value)
                })
                .collect(),
        ),
        other => other,
    }
}
