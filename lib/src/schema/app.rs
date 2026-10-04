//! Code-first schemas for app data. Bundles carry their immutable definitions.
use super::{frozen, shape::Shape};
use crate::{datatype::DataType, errors::AtomicResult, urls, Resource, Storelike, Value};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;

pub const SHAPE: &str = "urn:atomic:schema:shape";
pub const SCOPE: &str = "urn:atomic:schema:scope";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field {
    pub shape: Shape,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppSchema {
    pub class_id: String,
    pub fields: BTreeMap<String, String>,
    pub definitions: BTreeMap<String, Json>,
}

fn datatype(shape: &Shape) -> DataType {
    match shape {
        Shape::String { .. } => DataType::String,
        Shape::Number { .. } => DataType::Float,
        Shape::Integer { .. } => DataType::Integer,
        Shape::Boolean => DataType::Boolean,
        Shape::Reference => DataType::AtomicUrl,
        _ => DataType::Json,
    }
}
fn typed(shape: &Shape, value: Json) -> AtomicResult<Value> {
    shape.validate(&value)?;
    Ok(match shape {
        Shape::String { .. } => Value::String(value.as_str().unwrap().into()),
        Shape::Reference => Value::AtomicUrl(value.as_str().unwrap().into()),
        Shape::Number { .. } => Value::Float(value.as_f64().unwrap()),
        Shape::Integer { .. } => Value::Integer(value.as_f64().unwrap() as i64),
        Shape::Boolean => Value::Boolean(value.as_bool().unwrap()),
        _ => Value::Json(value),
    })
}

/// Only schema bodies produced by this format are accepted. This is deliberately
/// not a general JSON-AD importer; it never resolves identifiers over the network.
fn resource(id: &str, body: &Json) -> AtomicResult<Resource> {
    if frozen::id(body)? != id {
        return Err("Schema bundle hash mismatch".into());
    }
    let mut values = crate::resources::PropVals::new();
    for (key, value) in body.as_object().ok_or("Expected definition object")? {
        let v = match key.as_str() {
            urls::IS_A | urls::REQUIRES | urls::RECOMMENDS => Value::ResourceArray(
                value
                    .as_array()
                    .ok_or("Expected identifier list")?
                    .iter()
                    .map(|v| v.as_str().map(Into::into).ok_or("Expected identifier"))
                    .collect::<Result<_, _>>()?,
            ),
            urls::DATATYPE_PROP => {
                Value::AtomicUrl(value.as_str().ok_or("Expected datatype")?.into())
            }
            urls::SHORTNAME => Value::Slug(value.as_str().ok_or("Expected name")?.into()),
            urls::DESCRIPTION | SCOPE => {
                Value::String(value.as_str().ok_or("Expected text")?.into())
            }
            SHAPE => {
                let shape: Shape = serde_json::from_value(value.clone())?;
                shape.check()?;
                Value::Json(serde_json::to_value(shape)?)
            }
            _ => return Err(format!("Unsupported schema definition property {key}").into()),
        };
        values.insert(key.clone(), v);
    }
    let res = Resource::from_propvals(values, id.into());
    frozen::verify(&res)?;
    Ok(res)
}

impl AppSchema {
    pub fn define(name: &str, fields: BTreeMap<String, Field>) -> AtomicResult<Self> {
        if name.is_empty() || name.len() > 128 || fields.len() > 128 {
            return Err("Invalid schema name or field count".into());
        }
        let mut definitions = BTreeMap::new();
        let mut bindings = BTreeMap::new();
        let (mut requires, mut recommends) = (vec![], vec![]);
        for (key, field) in fields {
            if key.is_empty() || key.len() > 128 {
                return Err("Invalid field name".into());
            }
            field.shape.check()?;
            let body = json!({
                urls::IS_A: [urls::PROPERTY], urls::SHORTNAME: key,
                urls::DESCRIPTION: "", urls::DATATYPE_PROP: datatype(&field.shape).to_string(),
                SCOPE: name, SHAPE: field.shape,
            });
            let id = frozen::id(&body)?;
            if field.required {
                requires.push(id.clone());
            } else {
                recommends.push(id.clone());
            }
            bindings.insert(key, id.clone());
            definitions.insert(id, body);
        }
        let body = json!({urls::IS_A: [urls::CLASS], urls::SHORTNAME: name,
            urls::DESCRIPTION: "", urls::REQUIRES: requires, urls::RECOMMENDS: recommends});
        let class_id = frozen::id(&body)?;
        definitions.insert(class_id.clone(), body);
        Ok(Self {
            class_id,
            fields: bindings,
            definitions,
        })
    }

    /// Verify the entire bundle before installing anything. Re-registration is
    /// idempotent. This works with both in-memory and persistent Atomic stores.
    pub async fn register(&self, store: &impl Storelike) -> AtomicResult<()> {
        if self.definitions.len() != self.fields.len() + 1 || self.fields.len() > 128 {
            return Err("Schema bundle too large".into());
        }
        let resources: Vec<Resource> = self
            .definitions
            .iter()
            .map(|(id, body)| resource(id, body))
            .collect::<AtomicResult<_>>()?;
        let class = resources
            .iter()
            .find(|r| r.get_subject().as_str() == self.class_id)
            .ok_or("Missing class definition")?;
        if self.definitions[&self.class_id][urls::IS_A] != json!([urls::CLASS]) {
            return Err("Invalid class definition".into());
        }
        let class = super::Class::from_resource(class.clone())?;
        let ids: std::collections::BTreeSet<_> =
            class.requires.iter().chain(&class.recommends).collect();
        if ids.len() != class.requires.len() + class.recommends.len() {
            return Err("Duplicate class bindings".into());
        }
        for (name, id) in &self.fields {
            let prop = resources
                .iter()
                .find(|r| r.get_subject().as_str() == id)
                .ok_or("Missing field definition")?;
            if self.definitions[id][urls::IS_A] != json!([urls::PROPERTY]) {
                return Err("Invalid property definition".into());
            }
            let property = super::Property::from_resource(prop.clone())?;
            if property.shortname != *name
                || !class
                    .requires
                    .iter()
                    .chain(&class.recommends)
                    .any(|v| v == id)
            {
                return Err("Field binding does not match class".into());
            }
            let shape: Shape = serde_json::from_value(self.definitions[id][SHAPE].clone())?;
            if property.data_type != datatype(&shape) {
                return Err("Shape/datatype mismatch".into());
            }
        }
        if class.requires.len() + class.recommends.len() != self.fields.len() {
            return Err("Incomplete class bindings".into());
        }
        for res in resources {
            store.add_resource_opts(&res, false, true, true).await?;
        }
        Ok(())
    }

    pub fn property(&self, field: &str) -> AtomicResult<&str> {
        self.fields
            .get(field)
            .map(String::as_str)
            .ok_or_else(|| format!("Unknown field {field}").into())
    }
    pub async fn set(
        &self,
        resource: &mut Resource,
        field: &str,
        value: Json,
        store: &impl Storelike,
    ) -> AtomicResult<()> {
        let id = self.property(field)?;
        let shape: Shape = serde_json::from_value(
            self.definitions.get(id).ok_or("Missing property")?[SHAPE].clone(),
        )?;
        resource
            .set(id.into(), typed(&shape, value)?, store)
            .await?;
        Ok(())
    }
    pub async fn patch(
        &self,
        resource: &mut Resource,
        field: &str,
        path: &[&str],
        value: Option<Json>,
        store: &impl Storelike,
    ) -> AtomicResult<()> {
        resource
            .patch_json_path(self.property(field)?, path, value, store)
            .await
    }
    pub fn new_resource(&self, subject: crate::Subject) -> AtomicResult<Resource> {
        let mut resource = Resource::new(subject.to_string());
        resource.set_class(&self.class_id)?;
        Ok(resource)
    }
}

pub fn validate_value(definition: &Resource, value: &Value) -> AtomicResult<()> {
    if let Ok(Value::Json(shape)) = definition.get(SHAPE) {
        let shape: Shape = serde_json::from_value(shape.clone())?;
        let map = crate::serialize::propvals_to_json_ad_map(
            &[("urn:value".into(), value.clone())].into(),
            None,
            "http://localhost",
            true,
        )?;
        shape.validate(&map["urn:value"])?;
    }
    Ok(())
}
