// Generated from atomic:frozen:583c2583e75fe6bebc0f3b8acd5eca2d0738d254172303f1a8258176bc261f0a. Do not edit.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SchemaType0 {
    #[serde(rename = "mono")] Value0,
    #[serde(rename = "poly")] Value1,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaType2 {
    #[serde(rename = "base" )]
    pub field_base: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum SchemaType1 { Value0(f64),Value1(SchemaType2) }

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExampleModel {
    #[serde(rename = "comment", default, skip_serializing_if = "atomic_lib::schema::model::Optional::is_missing" )]
    pub field_comment: atomic_lib::schema::model::Optional<Option<String>>,
    #[serde(rename = "mode" )]
    pub field_mode: SchemaType0,
    #[serde(rename = "name" )]
    pub field_name: String,
    #[serde(rename = "steps", default, skip_serializing_if = "atomic_lib::schema::model::Optional::is_missing" )]
    pub field_steps: atomic_lib::schema::model::Optional<Vec<i64>>,
    #[serde(rename = "value" )]
    pub field_value: SchemaType1,
}
