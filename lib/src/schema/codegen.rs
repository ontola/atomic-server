//! Deterministic model generation from the same portable bundle used at runtime.
//! Generated Rust uses serde; Dart has no package dependency beyond dart:convert.
use super::{
    app::{AppSchema, SHAPE},
    shape::Shape,
};
use crate::errors::AtomicResult;
use std::collections::{BTreeMap, BTreeSet};

fn ident(value: &str) -> AtomicResult<()> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        || !value.as_bytes()[0].is_ascii_alphabetic()
    {
        return Err("Code generation names must be ASCII identifiers starting with a letter; rebind the local alias first".into());
    }
    Ok(())
}
fn literal(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}
fn dart_literal(s: &str) -> String {
    literal(s).replace('$', "\\$")
}
struct Generator {
    rust: Vec<String>,
    dart: Vec<String>,
    next: usize,
}
impl Generator {
    fn ty(&mut self, shape: &Shape) -> AtomicResult<(String, String, String)> {
        let primitive = match shape {
            Shape::String { .. } | Shape::Reference => Some(("String", "String", "v as String")),
            Shape::Number { .. } => Some(("f64", "double", "(v as num).toDouble()")),
            Shape::Integer { .. } => Some(("i64", "int", "(v as num).toInt()")),
            Shape::Boolean => Some(("bool", "bool", "v as bool")),
            Shape::Null => Some(("()", "Null", "v as Null")),
            _ => None,
        };
        if let Some((r, d, e)) = primitive {
            return Ok((r.into(), d.into(), e.into()));
        }
        match shape {
            Shape::Array { items, .. } => {
                let (r, d, e) = self.ty(items)?;
                Ok((
                    format!("Vec<{r}>"),
                    format!("List<{d}>"),
                    format!("List<{d}>.unmodifiable((v as List).map((v) => {e}))"),
                ))
            }
            Shape::Nullable { inner } => {
                let (r, d, e) = self.ty(inner)?;
                Ok((
                    format!("Option<{r}>"),
                    if d.ends_with('?') { d } else { format!("{d}?") },
                    format!("v == null ? null : ({e})"),
                ))
            }
            Shape::Enum { values } => {
                let n = self.next;
                self.next += 1;
                let name = format!("SchemaType{n}");
                self.rust.push(format!("#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]\npub enum {name} {{\n{}\n}}",values.iter().enumerate().map(|(i,v)|format!("    #[serde(rename = {})] Value{i},",literal(v))).collect::<Vec<_>>().join("\n")));
                self.dart.push(format!("enum {name} {{ {} ;\n const {name}(this.value); final String value;\n static {name} fromJson(Object? v) => values.firstWhere((e) => e.value == v, orElse: () => throw FormatException('Invalid enum'));\n}}",values.iter().enumerate().map(|(i,v)|format!("value{i}({})",dart_literal(v))).collect::<Vec<_>>().join(",")));
                Ok((name.clone(), name.clone(), format!("{name}.fromJson(v)")))
            }
            Shape::Union { variants } => {
                let n = self.next;
                self.next += 1;
                let name = format!("SchemaType{n}");
                let mut r = vec![];
                let mut d = vec![];
                for (i, variant) in variants.iter().enumerate() {
                    let (rt, dt, decode) = self.ty(variant)?;
                    r.push(format!("Value{i}({rt})"));
                    d.push(format!(" {dt} get asVariant{i} {{ _check({}, _value); final v=_value; return {decode}; }}",dart_literal(&serde_json::to_string(variant)?)));
                }
                self.rust.push(format!("#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\n#[serde(untagged)]\npub enum {name} {{ {} }}",r.join(",")));
                self.dart.push(format!("class {name} {{\n {name}.fromJson(Object? value): _value=_copy(value) {{ _check({}, _value); }}\n final Object? _value;\n Object? toJson()=>_copy(_value);\n{}\n}}",dart_literal(&serde_json::to_string(shape)?),d.join("\n")));
                Ok((name.clone(), name.clone(), format!("{name}.fromJson(v)")))
            }
            Shape::Object {
                properties,
                required,
                additional_properties,
            } => {
                let n = self.next;
                self.next += 1;
                let name = format!("SchemaType{n}");
                self.object(&name, properties, required, *additional_properties)?;
                Ok((
                    name.clone(),
                    name.clone(),
                    format!("{name}.fromJson((v as Map).cast<String,Object?>())"),
                ))
            }
            _ => unreachable!(),
        }
    }
    fn object(
        &mut self,
        name: &str,
        properties: &BTreeMap<String, Shape>,
        required: &[String],
        additional: bool,
    ) -> AtomicResult<()> {
        let mut rust = vec![];
        let mut dart = vec![];
        for (key, shape) in properties {
            // Indexed members avoid all keyword and normalization collisions. The
            // friendly accessor is emitted as field_<alias>, preserving spelling.
            ident(key)?;
            let (rt, dt, decode) = self.ty(shape)?;
            let optional = !required.contains(key);
            let rt = if optional {
                format!("atomic_lib::schema::model::Optional<{rt}>")
            } else {
                rt
            };
            rust.push(format!("    #[serde(rename = {}{} )]\n    pub field_{key}: {rt},",literal(key),if optional {", default, skip_serializing_if = \"atomic_lib::schema::model::Optional::is_missing\""}else{""}));
            let dt = if optional && !dt.ends_with('?') {
                format!("{dt}?")
            } else {
                dt
            };
            let absent = if optional {
                format!(
                    "if (!_json.containsKey({})) {{ return null; }}",
                    dart_literal(key)
                )
            } else {
                String::new()
            };
            dart.push(format!(" bool get has_{key} => _json.containsKey({});\n {dt} get field_{key} {{ {absent} final v=_json[{}]; return {decode}; }}",dart_literal(key),dart_literal(key)));
        }
        if additional {
            rust.push("    #[serde(flatten)]\n    pub additional: std::collections::BTreeMap<String, serde_json::Value>,".into());
        }
        self.rust.push(format!("#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]\n{}pub struct {name} {{\n{}\n}}",if additional {""}else{"#[serde(deny_unknown_fields)]\n"},rust.join("\n")));
        let shape = Shape::Object {
            properties: properties.clone(),
            required: required.into(),
            additional_properties: additional,
        };
        self.dart.push(format!("class {name} {{\n {name}.fromJson(Map<String,Object?> value):_json=(_copy(value) as Map).cast<String,Object?>() {{ _check({},_json); }}\n final Map<String,Object?> _json;\n Map<String,Object?> toJson()=>(_copy(_json) as Map).cast<String,Object?>();\n{}\n}}",dart_literal(&serde_json::to_string(&shape)?),dart.join("\n")));
        Ok(())
    }
}
/// Both outputs intentionally use field_<alias> accessors to avoid language
/// keywords. Optional nullable fields retain presence (Rust Optional<Option<T>>,
/// Dart has_<alias>). Union alternatives expose typed Dart asVariantN getters.
pub struct GeneratedModels {
    pub rust: String,
    pub dart: String,
}
impl AppSchema {
    pub fn generate_models(&self, name: &str) -> AtomicResult<GeneratedModels> {
        ident(name)?;
        let class = self
            .definitions
            .get(&self.class_id)
            .ok_or("Missing class")?;
        super::app::resource(&self.class_id, class)?;
        if name.starts_with("SchemaType")
            || !name.ends_with("Model")
            || !name.as_bytes()[0].is_ascii_uppercase()
        {
            return Err(
                "Model name must start uppercase, end in Model, and not start with SchemaType"
                    .into(),
            );
        }
        let mut properties = BTreeMap::new();
        let mut required = vec![];
        let mut ids = BTreeSet::new();
        for (alias, id) in &self.fields {
            if !ids.insert(id) {
                return Err("Duplicate binding".into());
            }
            let binding = self.binding(alias)?;
            if super::frozen::id(&binding.definition)? != *id {
                return Err("Property hash mismatch".into());
            }
            let shape: Shape = serde_json::from_value(binding.definition[SHAPE].clone())?;
            shape.check()?;
            properties.insert(alias.clone(), shape);
            if binding.required {
                required.push(alias.clone());
            }
        }
        let mut g = Generator {
            rust: vec![],
            dart: vec![],
            next: 0,
        };
        g.object(name, &properties, &required, false)?;
        Ok(GeneratedModels {
            rust: format!(
                "// Generated from {}. Do not edit.\n{}\n",
                self.class_id,
                g.rust.join("\n\n")
            ),
            dart: format!(
                "// Generated from {}. Do not edit.\n// ignore_for_file: non_constant_identifier_names\nimport 'dart:convert';\n{}\n{}\n",
                self.class_id,
                include_str!("model_runtime.dart"),
                g.dart.join("\n\n")
            ),
        })
    }
}
