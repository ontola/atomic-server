use base64::{engine::general_purpose, Engine};
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
    // v2 data on disk was written when this variant was named `JSON` (the
    // `DID refactor #1139` later renamed it to `Json`). rmp_serde tags enum
    // variants by NAME, so without this rename a real v2 store fails to migrate
    // with `unknown variant 'JSON'`. ValueV2 must speak the historical wire name.
    #[serde(rename = "JSON")]
    Json(serde_json::Value),
    LoroDoc(Vec<u8>),
    // Yjs document bytes from the unreleased `#998` experiment, dropped from the
    // live `Value` enum when the project standardised on Loro. The Yjs feature
    // never shipped, so there is no production data to carry forward — but a dev
    // store can still hold these values, and the v2 deserializer must accept the
    // variant or the whole migration aborts with `unknown variant 'YDoc'`.
    // Tolerated as an inert Unsupported value in `into_v3`.
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
        .map(|(k, v)| (k, v.into_v3(base_domain)))
        .collect()
}

pub fn string_to_subject(s: String, base_domain: &str) -> crate::Subject {
    crate::Subject::from_raw(&s, Some(base_domain))
}

impl ValueV2 {
    pub fn into_v3(self, base_domain: &str) -> crate::values::Value {
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
                    .map(|v| v.into_v3(base_domain))
                    .collect();
                crate::values::Value::ResourceArray(sub_resources)
            }
            ValueV2::Slug(v) => crate::values::Value::Slug(v),
            ValueV2::String(v) => crate::values::Value::String(v),
            ValueV2::Timestamp(v) => crate::values::Value::Timestamp(v),
            ValueV2::NestedResource(sub_resource) => {
                crate::values::Value::NestedResource(sub_resource.into_v3(base_domain))
            }
            ValueV2::Boolean(v) => crate::values::Value::Boolean(v),
            ValueV2::Uri(v) => crate::values::Value::Uri(v),
            ValueV2::Json(v) => crate::values::Value::Json(v),
            ValueV2::LoroDoc(v) => crate::values::Value::LoroDoc(v),
            // Yjs was an unreleased experiment — there's nothing to convert.
            // Carry the value across as an inert Unsupported (bytes kept as
            // base64, not interpreted) so a dev store migrates without aborting.
            ValueV2::YDoc(bin) => {
                crate::values::Value::Unsupported(crate::values::UnsupportedValue {
                    value: general_purpose::STANDARD.encode(&bin),
                    datatype: "https://atomicdata.dev/datatypes/ydoc".to_string(),
                })
            }
            ValueV2::Unsupported(unsupported_value) => {
                crate::values::Value::Unsupported(unsupported_value)
            }
        }
    }
}

impl SubResourceV2 {
    pub fn into_v3(self, base_domain: &str) -> crate::values::SubResource {
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
