//! Copy of the old types needed for the migration to resources_v2.
//! These should never be used outside of the migration.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub enum ValueV1 {
    AtomicUrl(String),
    Date(String),
    Integer(i64),
    Float(f64),
    Markdown(String),
    ResourceArray(Vec<SubResourceV1>),
    Slug(String),
    String(String),
    Timestamp(i64),
    NestedResource(SubResourceV1),
    Resource(Box<ResourceV1>),
    Boolean(bool),
    Unsupported(crate::values::UnsupportedValue),
}

#[derive(Debug, Serialize, Deserialize)]
pub enum SubResourceV1 {
    Resource(Box<ResourceV1>),
    Nested(PropValsV1),
    Subject(String),
}

pub type PropValsV1 = HashMap<String, ValueV1>;

#[derive(Debug, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct QueryFilterV1 {
    pub property: Option<String>,
    pub value: Option<ValueV1>,
    pub sort_by: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResourceV1 {
    propvals: PropValsV1,
    subject: String,
    commit: CommitBuilderV1,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CommitBuilderV1 {
    subject: String,
    set: std::collections::HashMap<String, ValueV1>,
    push: std::collections::HashMap<String, ValueV1>,
    remove: HashSet<String>,
    destroy: bool,
    previous_commit: Option<String>,
}

use std::fmt;

impl fmt::Display for ValueV1 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ValueV1::AtomicUrl(s) => write!(f, "{}", s),
            ValueV1::Date(s) => write!(f, "{}", s),
            ValueV1::Integer(i) => write!(f, "{}", i),
            ValueV1::Float(float) => write!(f, "{}", float),
            ValueV1::Markdown(i) => write!(f, "{}", i),
            ValueV1::ResourceArray(_) => write!(f, "not implemented"),
            ValueV1::Slug(s) => write!(f, "{}", s),
            ValueV1::String(s) => write!(f, "{}", s),
            ValueV1::Timestamp(i) => write!(f, "{}", i),
            ValueV1::Resource(_) => write!(f, "not implemented"),
            ValueV1::NestedResource(n) => write!(f, "{:?}", n),
            ValueV1::Boolean(b) => write!(f, "{}", b),
            ValueV1::Unsupported(u) => write!(f, "{}", u.value),
        }
    }
}

pub fn propvals_v1_to_v2(propvals: PropValsV1) -> crate::resources::PropVals {
    propvals.into_iter().map(|(k, v)| (k, v.into())).collect()
}

impl From<SubResourceV1> for crate::values::SubResource {
    fn from(sub_resource: SubResourceV1) -> Self {
        match sub_resource {
            SubResourceV1::Resource(resource) => {
                tracing::warn!(
                    "Named SubResource found, converting to Subject {}",
                    resource.subject
                );
                Self::Subject(resource.subject.into())
            }
            SubResourceV1::Nested(propvals) => Self::Nested(propvals_v1_to_v2(propvals)),
            SubResourceV1::Subject(subject) => Self::Subject(subject.into()),
        }
    }
}

impl From<ResourceV1> for crate::resources::Resource {
    fn from(resource: ResourceV1) -> Self {
        Self::from_propvals(
            propvals_v1_to_v2(resource.propvals),
            resource.subject.into(),
        )
    }
}

impl From<ValueV1> for crate::values::Value {
    fn from(value: ValueV1) -> Self {
        match value {
            crate::db::v1_types::ValueV1::AtomicUrl(v) => Self::AtomicUrl(v.clone().into()),
            crate::db::v1_types::ValueV1::Date(v) => Self::Date(v.clone()),
            crate::db::v1_types::ValueV1::Integer(v) => Self::Integer(v),
            crate::db::v1_types::ValueV1::Float(v) => Self::Float(v),
            crate::db::v1_types::ValueV1::Markdown(v) => Self::Markdown(v.clone()),
            crate::db::v1_types::ValueV1::ResourceArray(sub_resource_v1s) => {
                let sub_resources = sub_resource_v1s.into_iter().map(|v| v.into()).collect();
                Self::ResourceArray(sub_resources)
            }
            crate::db::v1_types::ValueV1::Slug(v) => Self::Slug(v.clone()),
            crate::db::v1_types::ValueV1::String(v) => Self::String(v.clone()),
            crate::db::v1_types::ValueV1::Timestamp(v) => Self::Timestamp(v),
            crate::db::v1_types::ValueV1::NestedResource(sub_resource_v1) => {
                Self::NestedResource(sub_resource_v1.into())
            }
            crate::db::v1_types::ValueV1::Resource(resource_v1) => {
                tracing::warn!(
                    "Named SubResource found, converting to Subject {}",
                    resource_v1.subject
                );
                Self::AtomicUrl(resource_v1.subject.into())
            }
            crate::db::v1_types::ValueV1::Boolean(v) => Self::Boolean(v),
            crate::db::v1_types::ValueV1::Unsupported(unsupported_value) => {
                Self::Unsupported(unsupported_value)
            }
        }
    }
}
