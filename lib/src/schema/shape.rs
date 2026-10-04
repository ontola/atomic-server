//! Explicit supported shape vocabulary. Unknown keywords fail deserialization.
use crate::errors::AtomicResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum Shape {
    String {
        #[serde(rename = "maxLength", default, skip_serializing_if = "Option::is_none")]
        max_length: Option<usize>,
    },
    Number {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        minimum: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        maximum: Option<f64>,
    },
    Integer {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        minimum: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        maximum: Option<f64>,
    },
    Enum {
        values: Vec<String>,
    },
    Nullable {
        inner: Box<Shape>,
    },
    Union {
        variants: Vec<Shape>,
    },
    Boolean,
    Null,
    Reference,
    Object {
        properties: BTreeMap<String, Shape>,
        #[serde(default)]
        required: Vec<String>,
        #[serde(rename = "additionalProperties", default)]
        additional_properties: bool,
    },
    Array {
        items: Box<Shape>,
        #[serde(rename = "maxItems")]
        max_items: usize,
    },
}
impl Shape {
    pub fn check(&self) -> AtomicResult<()> {
        self.check_at(0, &mut 2048)
    }
    fn check_at(&self, depth: usize, budget: &mut usize) -> AtomicResult<()> {
        if *budget == 0 {
            return Err("Schema exceeds 2048 nodes".into());
        }
        *budget -= 1;
        if depth > 16 {
            return Err("Schema nesting exceeds 16 levels".into());
        }
        match self {
            Self::Enum { values } => {
                let unique: std::collections::BTreeSet<_> = values.iter().collect();
                if values.is_empty()
                    || values.len() > 128
                    || unique.len() != values.len()
                    || values.iter().any(|s| s.len() > 1024)
                {
                    return Err("Enum needs 1-128 distinct strings of at most 1024 bytes".into());
                }
            }
            Self::Nullable { inner } => inner.check_at(depth + 1, budget)?,
            Self::Union { variants } => {
                if variants.len() < 2 || variants.len() > 8 {
                    return Err("Union needs 2-8 variants".into());
                }
                for variant in variants {
                    variant.check_at(depth + 1, budget)?;
                }
            }

            Self::Number { minimum, maximum } | Self::Integer { minimum, maximum } => {
                if minimum.iter().chain(maximum).any(|v| !v.is_finite())
                    || minimum.zip(*maximum).is_some_and(|(a, b)| a > b)
                {
                    return Err("Invalid numeric bounds".into());
                }
            }
            Self::Object {
                properties,
                required,
                ..
            } => {
                if properties.len() > 128 || required.iter().any(|k| !properties.contains_key(k)) {
                    return Err("Invalid object fields or required keys".into());
                }
                for (key, value) in properties {
                    if key.is_empty() || key.len() > 128 {
                        return Err("Invalid field name".into());
                    }
                    value.check_at(depth + 1, budget)?;
                }
            }
            Self::Array { items, max_items } => {
                if *max_items > 16384 {
                    return Err("maxItems exceeds 16384".into());
                }
                items.check_at(depth + 1, budget)?;
            }
            _ => {}
        }
        Ok(())
    }
    pub fn validate(&self, value: &Value) -> AtomicResult<()> {
        self.check()?;
        self.validate_at(value, "$", &mut 100_000)
    }
    fn validate_at(&self, value: &Value, path: &str, budget: &mut usize) -> AtomicResult<()> {
        if *budget == 0 {
            return Err("Validation exceeds 100000 value checks".into());
        }
        *budget -= 1;
        let fail = || format!("Invalid value at {path}");
        match self {
            Self::Enum { values } => {
                if !value
                    .as_str()
                    .is_some_and(|v| values.iter().any(|s| s == v))
                {
                    return Err(fail().into());
                }
            }
            Self::Nullable { inner } => {
                if !value.is_null() {
                    inner.validate_at(value, path, budget)?;
                }
            }
            Self::Union { variants } => {
                let mut valid = false;
                for variant in variants {
                    if variant.validate_at(value, path, budget).is_ok() {
                        valid = true;
                        break;
                    }
                    if *budget == 0 {
                        return Err("Validation exceeds 100000 value checks".into());
                    }
                }
                if !valid {
                    return Err(format!("No union variant matches at {path}").into());
                }
            }
            Self::String { max_length } => {
                let s = value.as_str().ok_or_else(fail)?;
                if max_length.is_some_and(|n| s.chars().count() > n) {
                    return Err(fail().into());
                }
            }
            Self::Number { minimum, maximum } | Self::Integer { minimum, maximum } => {
                let n = value.as_f64().ok_or_else(fail)?;
                if !n.is_finite()
                    || minimum.is_some_and(|m| n < m)
                    || maximum.is_some_and(|m| n > m)
                    || matches!(self, Self::Integer { .. })
                        && (n.fract() != 0. || n.abs() > 9007199254740991.)
                {
                    return Err(fail().into());
                }
            }
            Self::Boolean if !value.is_boolean() => return Err(fail().into()),
            Self::Null if !value.is_null() => return Err(fail().into()),
            Self::Reference => {
                let s = value.as_str().ok_or_else(fail)?;
                if !crate::identifiers::is_atomic_identifier(s)
                    && !s.starts_with("https://")
                    && !s.starts_with("http://")
                {
                    return Err(fail().into());
                }
                url::Url::parse(s).map_err(|_| fail())?;
            }
            Self::Object {
                properties,
                required,
                additional_properties,
            } => {
                let map = value.as_object().ok_or_else(fail)?;
                for key in required {
                    if !map.contains_key(key) {
                        return Err(format!("Missing required field at {path}/{key}").into());
                    }
                }
                for (key, value) in map {
                    let next = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
                    if let Some(shape) = properties.get(key) {
                        shape.validate_at(value, &next, budget)?;
                    } else if !additional_properties {
                        return Err(format!("Unknown field at {next}").into());
                    }
                }
            }
            Self::Array { items, max_items } => {
                let list = value.as_array().ok_or_else(fail)?;
                if list.len() > *max_items {
                    return Err(fail().into());
                }
                for (i, item) in list.iter().enumerate() {
                    items.validate_at(item, &format!("{path}/{i}"), budget)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
