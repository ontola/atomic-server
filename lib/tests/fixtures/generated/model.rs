// Generated from atomic:frozen:5ae51fa584042c60d193f98a65897c9a07374dbcef60c06364213addaa52f53c. Do not edit.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum SchemaType0 {
    #[serde(rename = "mono")] Value0,
    #[serde(rename = "poly")] Value1,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaType2 {
    #[serde(rename = "base" )]
    pub base: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum SchemaType1 { Value0(f64),Value1(SchemaType2) }

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExampleModel {
    #[serde(rename = "comment", default, skip_serializing_if = "atomic_lib::schema::model::Optional::is_missing" )]
    pub comment: atomic_lib::schema::model::Optional<Option<String>>,
    #[serde(rename = "midiKey", default, skip_serializing_if = "atomic_lib::schema::model::Optional::is_missing" )]
    pub midi_key: atomic_lib::schema::model::Optional<i64>,
    #[serde(rename = "mode" )]
    pub mode: SchemaType0,
    #[serde(rename = "name" )]
    pub name: String,
    #[serde(rename = "steps", default, skip_serializing_if = "atomic_lib::schema::model::Optional::is_missing" )]
    pub steps: atomic_lib::schema::model::Optional<Vec<i64>>,
    #[serde(rename = "toJson", default, skip_serializing_if = "atomic_lib::schema::model::Optional::is_missing" )]
    pub to_json: atomic_lib::schema::model::Optional<String>,
    #[serde(rename = "type", default, skip_serializing_if = "atomic_lib::schema::model::Optional::is_missing" )]
    pub r#type: atomic_lib::schema::model::Optional<bool>,
    #[serde(rename = "value" )]
    pub value: SchemaType1,
}
