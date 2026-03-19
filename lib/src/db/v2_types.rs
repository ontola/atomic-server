use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize)]
pub enum ValueV2 {
    AtomicUrl(String),
    Date(String),
    Integer(i64),
    Float(f64),
    Markdown(String),
    ResourceArray(Vec<SubResourceV2>),
    Slug(String),
    String(String),
    Timestamp(i64),
    NestedResource(SubResourceV2),
    Boolean(bool),
    Uri(String),
    Json(serde_json::Value),
    YDoc(Vec<u8>),
    Unsupported(crate::values::UnsupportedValue),
}

#[derive(Debug, Serialize, Deserialize)]
pub enum SubResourceV2 {
    Nested(PropValsV2),
    Subject(String),
}

pub type PropValsV2 = HashMap<String, ValueV2>;

pub fn propvals_v2_to_v3(propvals: PropValsV2, base_domain: &str) -> crate::resources::PropVals {
    propvals
        .into_iter()
        .map(|(k, v)| (k, v.to_v3(base_domain)))
        .collect()
}

pub fn string_to_subject(s: String, base_domain: &str) -> crate::Subject {
    crate::Subject::from_raw(&s, Some(base_domain))
}

impl ValueV2 {
    pub fn to_v3(self, base_domain: &str) -> crate::values::Value {
        match self {
            ValueV2::AtomicUrl(v) => {
                crate::values::Value::AtomicUrl(string_to_subject(v, base_domain))
            }
            ValueV2::Date(v) => crate::values::Value::Date(v),
            ValueV2::Integer(v) => crate::values::Value::Integer(v),
            ValueV2::Float(v) => crate::values::Value::Float(v),
            ValueV2::Markdown(v) => crate::values::Value::Markdown(v),
            ValueV2::ResourceArray(sub_resources) => {
                let sub_resources = sub_resources
                    .into_iter()
                    .map(|v| v.to_v3(base_domain))
                    .collect();
                crate::values::Value::ResourceArray(sub_resources)
            }
            ValueV2::Slug(v) => crate::values::Value::Slug(v),
            ValueV2::String(v) => crate::values::Value::String(v),
            ValueV2::Timestamp(v) => crate::values::Value::Timestamp(v),
            ValueV2::NestedResource(sub_resource) => {
                crate::values::Value::NestedResource(sub_resource.to_v3(base_domain))
            }
            ValueV2::Boolean(v) => crate::values::Value::Boolean(v),
            ValueV2::Uri(v) => crate::values::Value::Uri(v),
            ValueV2::Json(v) => crate::values::Value::Json(v),
            ValueV2::YDoc(v) => crate::values::Value::YDoc(v),
            ValueV2::Unsupported(unsupported_value) => {
                crate::values::Value::Unsupported(unsupported_value)
            }
        }
    }
}

impl SubResourceV2 {
    pub fn to_v3(self, base_domain: &str) -> crate::values::SubResource {
        match self {
            SubResourceV2::Nested(propvals) => {
                crate::values::SubResource::Nested(propvals_v2_to_v3(propvals, base_domain))
            }
            SubResourceV2::Subject(subject) => {
                crate::values::SubResource::Subject(string_to_subject(subject, base_domain))
            }
        }
    }
}
