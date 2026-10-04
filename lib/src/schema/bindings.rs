//! Reuse immutable properties while keeping application aliases outside identity.
use super::{
    app::{self, AppSchema, Field},
    frozen,
    shape::Shape,
};
use crate::{errors::AtomicResult, urls, Resource, Storelike, Value};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct PropertyBinding {
    pub id: String,
    pub definition: Json,
    pub required: bool,
}
impl PropertyBinding {
    /// Semantic scope/name are immutable vocabulary choices. Local field aliases
    /// are supplied separately to compose() and rebind().
    pub fn define(scope: &str, name: &str, shape: Shape) -> AtomicResult<Self> {
        AppSchema::define(
            scope,
            [(
                name.into(),
                Field {
                    shape,
                    required: false,
                },
            )]
            .into(),
        )?
        .binding(name)
    }
    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }
}
impl AppSchema {
    pub fn binding(&self, field: &str) -> AtomicResult<PropertyBinding> {
        let id = self.property(field)?;
        Ok(PropertyBinding {
            id: id.into(),
            definition: self
                .definitions
                .get(id)
                .ok_or("Missing definition")?
                .clone(),
            required: self
                .definitions
                .get(&self.class_id)
                .ok_or("Missing class definition")?[urls::REQUIRES]
                .as_array()
                .ok_or("Invalid class")?
                .contains(&json!(id)),
        })
    }
    /// Aliases are local access names, not new Properties. The class name and
    /// description are immutable semantic metadata; display labels live outside it.
    pub fn compose(
        name: &str,
        description: &str,
        bindings: BTreeMap<String, PropertyBinding>,
    ) -> AtomicResult<Self> {
        if name.is_empty() || name.len() > 128 || bindings.len() > 128 || description.len() > 4096 {
            return Err("Invalid class bindings".into());
        }
        let mut definitions = BTreeMap::new();
        let mut fields = BTreeMap::new();
        let (mut requires, mut recommends) = (vec![], vec![]);
        for (alias, binding) in bindings {
            if alias.is_empty() || alias.len() > 128 || definitions.contains_key(&binding.id) {
                return Err("Invalid or duplicate property binding".into());
            }
            let definition = app::resource(&binding.id, &binding.definition)?;
            if !definition.has_class(urls::PROPERTY) {
                return Err("Expected Property binding".into());
            }
            let shape: Shape = serde_json::from_value(binding.definition[app::SHAPE].clone())?;
            shape.check()?;
            if binding.definition[urls::DATATYPE_PROP] != app::datatype(&shape).to_string() {
                return Err("Shape/datatype mismatch".into());
            }
            if binding.required {
                requires.push(binding.id.clone());
            } else {
                recommends.push(binding.id.clone());
            }
            fields.insert(alias, binding.id.clone());
            definitions.insert(binding.id, binding.definition);
        }
        // Class membership order must not depend on application aliases. Sort
        // by the immutable semantic shortname, then identity for ties.
        for members in [&mut requires, &mut recommends] {
            members.sort_by_key(|id| {
                (
                    definitions[id][urls::SHORTNAME]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    id.clone(),
                )
            });
        }
        let body = json!({urls::IS_A:[urls::CLASS],urls::SHORTNAME:name,urls::DESCRIPTION:description,urls::REQUIRES:requires,urls::RECOMMENDS:recommends});
        let class_id = frozen::id(&body)?;
        definitions.insert(class_id.clone(), body);
        Ok(Self {
            class_id,
            fields,
            definitions,
        })
    }
    /// Rename an application accessor without changing Class or Property identity.
    pub fn rebind(&self, old: &str, alias: &str) -> AtomicResult<Self> {
        if alias.is_empty()
            || alias.len() > 128
            || (old != alias && self.fields.contains_key(alias))
        {
            return Err("Invalid or duplicate alias".into());
        }
        let mut schema = self.clone();
        let id = schema.fields.remove(old).ok_or("Unknown field")?;
        schema.fields.insert(alias.into(), id);
        Ok(schema)
    }
    pub fn encode_field<T: Serialize>(&self, field: &str, value: &T) -> AtomicResult<Value> {
        let id = self.property(field)?;
        let shape: Shape = serde_json::from_value(
            self.definitions
                .get(id)
                .ok_or("Missing property definition")?[app::SHAPE]
                .clone(),
        )?;
        app::typed(&shape, serde_json::to_value(value)?)
            .map_err(|e| format!("Field {field}: {e}").into())
    }
    pub fn read_field<T: DeserializeOwned>(
        &self,
        resource: &Resource,
        field: &str,
    ) -> AtomicResult<T> {
        let value = resource.get(self.property(field)?)?.clone();
        let json = crate::serialize::val_to_serde(value, "http://localhost", false)?;
        let _ = self.encode_field(field, &json)?;
        Ok(serde_json::from_value(json)?)
    }
    pub fn decode_model<T: DeserializeOwned>(&self, resource: &Resource) -> AtomicResult<T> {
        let mut data = serde_json::Map::new();
        for (alias, id) in &self.fields {
            match resource.get(id) {
                Ok(_) => {
                    data.insert(alias.clone(), self.read_field::<Json>(resource, alias)?);
                }
                Err(_) if self.binding(alias)?.required => {
                    return Err(format!("Missing required field {alias}").into())
                }
                Err(_) => {}
            }
        }
        Ok(serde_json::from_value(Json::Object(data))?)
    }
    /// Validate a complete model before changing any fields. Omitted optional
    /// fields are removed. Nested object replacement is explicit here.
    pub async fn replace_model<T: Serialize>(
        &self,
        resource: &mut Resource,
        model: &T,
        store: &impl Storelike,
    ) -> AtomicResult<()> {
        let data = serde_json::to_value(model)?;
        let data = data
            .as_object()
            .ok_or("Model must serialize as an object")?;
        let mut encoded = BTreeMap::new();
        for (alias, value) in data {
            encoded.insert(
                self.property(alias)?.to_string(),
                self.encode_field(alias, value)?,
            );
        }
        for alias in self.fields.keys() {
            if self.binding(alias)?.required && !data.contains_key(alias) {
                return Err(format!("Missing required field {alias}").into());
            }
        }
        // Work on an independent snapshot, so a late failure cannot leave half a model.
        let mut staged = resource.clone();
        for (id, value) in encoded {
            staged.set(id, value, store).await?;
        }
        for (alias, id) in &self.fields {
            if !data.contains_key(alias) && staged.get(id).is_ok() {
                staged.remove_propval(id)?;
            }
        }
        *resource = staged;
        Ok(())
    }
}
