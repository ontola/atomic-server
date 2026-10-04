//! Frozen definitions travel with the resource that authorizes their transfer.
//! No remote lookups, code execution, or cache writes occur during validation.
use super::{app, frozen, shape::Shape, Class, Property};
use crate::{errors::AtomicResult, Resource, Storelike, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub const ROOT: &str = "atomic:schema-definitions";
pub const MAX_DEFINITIONS: usize = 512;
pub const MAX_BYTES: usize = 1024 * 1024;
pub const MAX_DEPTH: usize = 16;
pub type Definitions = BTreeMap<String, Resource>;

fn canonical_id(id: &str) -> Option<String> {
    let subject: crate::Subject = id.into();
    frozen::is_frozen(&subject).then(|| subject.pure_id())
}

/// Only semantic schema links are dependencies. Shape literals and arbitrary
/// user strings that look like identifiers are not dereferenced.
fn references(resource: &Resource, definition: bool) -> AtomicResult<BTreeSet<String>> {
    let mut ids: BTreeSet<String> = resource
        .get_propvals()
        .keys()
        .filter_map(|key| canonical_id(key))
        .collect();
    if !definition {
        ids.extend(
            resource
                .class_subjects()
                .iter()
                .filter_map(|id| canonical_id(id)),
        );
        return Ok(ids);
    }
    let properties = &[
        crate::urls::IS_A,
        crate::urls::REQUIRES,
        crate::urls::RECOMMENDS,
        crate::urls::DATATYPE_PROP,
        crate::urls::CLASSTYPE_PROP,
    ];
    for property in properties {
        if let Ok(value) = resource.get(property) {
            for id in value.to_subjects(None)? {
                if let Some(id) = canonical_id(&id) {
                    ids.insert(id);
                }
            }
        }
    }
    Ok(ids)
}

fn check_definition(resource: &Resource) -> AtomicResult<()> {
    frozen::verify(resource)?;
    let classes = resource.get(crate::urls::IS_A)?.to_subjects(None)?;
    if classes == [crate::urls::CLASS] {
        resource.get(crate::urls::REQUIRES)?;
        resource.get(crate::urls::RECOMMENDS)?;
        let class = Class::from_resource(resource.clone())?;
        if class.requires.len() + class.recommends.len() > 128 {
            return Err("Too many schema fields".into());
        }
    } else if classes == [crate::urls::PROPERTY] {
        let prop = Property::from_resource(resource.clone())?;
        let shape: Shape = match resource.get(app::SHAPE)? {
            Value::Json(shape) => serde_json::from_value(shape.clone())?,
            _ => return Err("Missing property shape".into()),
        };
        shape.check()?;
        if prop.data_type != app::datatype(&shape) {
            return Err("Shape/datatype mismatch".into());
        }
    } else {
        return Err("Dependency must be an app Class or Property".into());
    }
    Ok(())
}

pub fn read_doc(doc: &crate::loro::AtomicLoroDoc) -> AtomicResult<Definitions> {
    let map = doc.doc().get_map(ROOT);
    if map.len() > MAX_DEFINITIONS {
        return Err("Too many schema dependencies".into());
    }
    let mut total = 0usize;
    let mut definitions = BTreeMap::new();
    for key in map.keys() {
        let id = key.to_string();
        let value = map.get(&id).ok_or("Missing schema entry")?;
        let loro::ValueOrContainer::Value(loro::LoroValue::String(body)) = value else {
            return Err("Schema body must be a canonical JSON string".into());
        };
        total = total.saturating_add(id.len()).saturating_add(body.len());
        if total > MAX_BYTES || body.len() > frozen::MAX_BYTES {
            return Err("Schema dependencies exceed byte budget".into());
        }
        let parsed: serde_json::Value = serde_json::from_str(body.as_ref())?;
        let resource = app::resource(&id, &parsed)?;
        if serde_jcs::to_string(&parsed)? != body.as_ref() {
            return Err("Schema body is not canonical JSON".into());
        }
        check_definition(&resource)?;
        definitions.insert(id, resource);
    }
    Ok(definitions)
}

/// Resolve a bounded closure, preferring verified attachments to local cache.
/// Missing frozen definitions fail explicitly rather than weakening validation.
pub async fn resolve(resource: &Resource, store: &impl Storelike) -> AtomicResult<Definitions> {
    let attached = resource.attached_schema_definitions()?;
    let mut queue: VecDeque<_> = references(resource, false)?
        .into_iter()
        .map(|id| (id, 0))
        .collect();
    let mut resolved = BTreeMap::new();
    let mut total = 0usize;
    while let Some((id, depth)) = queue.pop_front() {
        if resolved.contains_key(&id) {
            continue;
        }
        if depth > MAX_DEPTH || resolved.len() >= MAX_DEFINITIONS {
            return Err("Schema dependency traversal limit exceeded".into());
        }
        let definition = if let Some(def) = attached.get(&id) {
            def.clone()
        } else {
            store
                .get_resource(&id.as_str().into())
                .await
                .map_err(|_| format!("Missing frozen schema dependency {id}"))?
        };
        check_definition(&definition)?;
        total = total
            .saturating_add(id.len())
            .saturating_add(serde_jcs::to_vec(&frozen::body(&definition)?)?.len());
        if total > MAX_BYTES {
            return Err("Schema dependencies exceed byte budget".into());
        }
        queue.extend(
            references(&definition, true)?
                .into_iter()
                .map(|id| (id, depth + 1)),
        );
        resolved.insert(id, definition);
    }
    Ok(resolved)
}

pub fn validate_data(resource: &Resource, definitions: &Definitions) -> AtomicResult<()> {
    for (property, value) in resource.get_propvals() {
        if let Some(id) = canonical_id(property) {
            let definition = definitions.get(&id).ok_or("Missing property definition")?;
            if definition.get(crate::urls::IS_A)?.to_subjects(None)? != [crate::urls::PROPERTY] {
                return Err("Expected a Property dependency".into());
            }
            app::validate_value(definition, value)?;
        }
    }
    for id in resource
        .class_subjects()
        .iter()
        .filter_map(|id| canonical_id(id))
    {
        let definition = definitions.get(&id).ok_or("Missing class definition")?;
        if definition.get(crate::urls::IS_A)?.to_subjects(None)? != [crate::urls::CLASS] {
            return Err("Expected a Class dependency".into());
        }
        let class = Class::from_resource(definition.clone())?;
        for required in class.requires {
            if resource.get(&required).is_err() {
                return Err(format!("Missing required schema field {required}").into());
            }
        }
    }
    Ok(())
}

pub async fn attach(resource: &mut Resource, store: &impl Storelike) -> AtomicResult<()> {
    let definitions = resolve(resource, store).await?;
    resource.attach_schema_definitions(&definitions)
}
