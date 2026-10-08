//! Value constraints that live on a Class, not on its Properties.
//!
//! A Class has a `constraints` map: property subject to an object of JSON
//! Schema keywords (see `docs/src/schema/classes.md`). The TypeScript twin is
//! `browser/lib/src/class-constraints.ts`; both run the cases in
//! `lib/tests/fixtures/class-constraints.json`, so change them together.

use std::collections::BTreeMap;

use regex::Regex;
use serde_json::Value as Json;

use crate::{
    errors::AtomicResult, identifiers::canonicalize_scheme, storelike::Storelike, urls,
    values::SubResource, Resource, Value,
};

/// Every keyword a constraint may use. Anything else is rejected on write.
pub const KEYWORDS: [&str; 11] = [
    "enum",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "pattern",
    "class",
];

/// The constraints on one property of one class.
#[derive(Clone, Debug, Default)]
pub struct Constraint {
    pub enum_values: Option<Vec<Json>>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub exclusive_minimum: Option<f64>,
    pub exclusive_maximum: Option<f64>,
    pub min_length: Option<u64>,
    pub max_length: Option<u64>,
    pub min_items: Option<u64>,
    pub max_items: Option<u64>,
    pub pattern: Option<Regex>,
    /// Subject of the class a link should point to. For pickers and forms,
    /// never checked at write time.
    pub class: Option<String>,
}

/// A class's constraints, keyed by canonical property subject.
pub type Constraints = BTreeMap<String, Constraint>;

/// A value broke a constraint.
#[derive(Clone, Debug, PartialEq)]
pub struct ConstraintError {
    /// The JSON Schema keyword that failed.
    pub keyword: &'static str,
    pub detail: String,
}

impl std::fmt::Display for ConstraintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.keyword, self.detail)
    }
}

impl std::error::Error for ConstraintError {}

fn number(keyword: &str, v: &Json) -> AtomicResult<f64> {
    v.as_f64()
        .ok_or_else(|| format!("Constraint `{keyword}` must be a number, got {v}").into())
}

fn count(keyword: &str, v: &Json) -> AtomicResult<u64> {
    v.as_u64().ok_or_else(|| {
        format!("Constraint `{keyword}` must be a non-negative integer, got {v}").into()
    })
}

/// Parses one constraint object, rejecting unknown keywords and wrong types.
pub fn parse_constraint(json: &Json) -> AtomicResult<Constraint> {
    let obj = json
        .as_object()
        .ok_or_else(|| format!("A constraint must be a JSON object, got {json}"))?;
    let mut c = Constraint::default();

    for (keyword, v) in obj {
        match keyword.as_str() {
            "enum" => {
                let arr = v
                    .as_array()
                    .ok_or_else(|| format!("Constraint `enum` must be an array, got {v}"))?;
                c.enum_values = Some(arr.clone());
            }
            "minimum" => c.minimum = Some(number(keyword, v)?),
            "maximum" => c.maximum = Some(number(keyword, v)?),
            "exclusiveMinimum" => c.exclusive_minimum = Some(number(keyword, v)?),
            "exclusiveMaximum" => c.exclusive_maximum = Some(number(keyword, v)?),
            "minLength" => c.min_length = Some(count(keyword, v)?),
            "maxLength" => c.max_length = Some(count(keyword, v)?),
            "minItems" => c.min_items = Some(count(keyword, v)?),
            "maxItems" => c.max_items = Some(count(keyword, v)?),
            "pattern" => {
                let src = v
                    .as_str()
                    .ok_or_else(|| format!("Constraint `pattern` must be a string, got {v}"))?;
                c.pattern = Some(
                    Regex::new(src)
                        .map_err(|e| format!("Constraint `pattern` is not a valid regex: {e}"))?,
                );
            }
            "class" => {
                let s = v
                    .as_str()
                    .ok_or_else(|| format!("Constraint `class` must be a string, got {v}"))?;
                c.class = Some(canonicalize_scheme(s));
            }
            other => {
                return Err(format!(
                    "Unknown constraint keyword `{other}`. Allowed: {}",
                    KEYWORDS.join(", ")
                )
                .into())
            }
        }
    }

    Ok(c)
}

/// Parses a whole `constraints` map. Property keys are canonicalized
/// (`did:ad:` becomes `atomic:`), HTTP subjects are kept as they are.
pub fn parse_constraints(json: &Json) -> AtomicResult<Constraints> {
    let obj = json
        .as_object()
        .ok_or_else(|| format!("`constraints` must be a JSON object, got {json}"))?;
    let mut out = Constraints::new();

    for (prop, constraint) in obj {
        let parsed = parse_constraint(constraint)
            .map_err(|e| format!("Invalid constraint for {prop}: {e}"))?;
        out.insert(canonicalize_scheme(prop), parsed);
    }

    Ok(out)
}

/// Reads the `constraints` value of a Class resource, if it has one.
/// Accepts the JSON value itself or a JSON string of it.
pub fn constraints_of(class: &Resource) -> AtomicResult<Option<Constraints>> {
    let Ok(value) = class.get(urls::CONSTRAINTS) else {
        return Ok(None);
    };
    let json = match value {
        Value::Json(j) => j.clone(),
        Value::String(s) | Value::Markdown(s) => {
            serde_json::from_str(s).map_err(|e| format!("`constraints` is not valid JSON: {e}"))?
        }
        other => return Err(format!("`constraints` must be JSON, got {other}").into()),
    };
    Ok(Some(parse_constraints(&json)?))
}

/// Rejects a Class resource whose `constraints` map would not parse.
/// A no-op for resources without one.
pub fn validate_constraints_prop(resource: &Resource) -> AtomicResult<()> {
    constraints_of(resource)
        .map(|_| ())
        .map_err(|e| format!("Invalid constraints on {}: {e}", resource.get_subject()).into())
}

fn canonical_json(v: &Json) -> Json {
    match v {
        Json::String(s) => Json::String(canonicalize_scheme(s)),
        other => other.clone(),
    }
}

fn json_eq(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64() == y.as_f64(),
        _ => canonical_json(a) == canonical_json(b),
    }
}

/// Checks a JSON value. A keyword that does not apply to the value's type is
/// ignored, as in JSON Schema. For an array, `enum` applies to every item.
pub fn check_json(c: &Constraint, value: &Json) -> Result<(), ConstraintError> {
    let fail = |keyword: &'static str, detail: String| Err(ConstraintError { keyword, detail });

    if let Some(allowed) = &c.enum_values {
        let items: Vec<&Json> = match value {
            Json::Array(a) => a.iter().collect(),
            single => vec![single],
        };
        for item in items {
            if !allowed.iter().any(|a| json_eq(a, item)) {
                return fail(
                    "enum",
                    format!("{item} is not one of {}", Json::Array(allowed.clone())),
                );
            }
        }
    }

    match value {
        Json::Number(n) => {
            let Some(n) = n.as_f64() else { return Ok(()) };
            if let Some(m) = c.minimum {
                if n < m {
                    return fail("minimum", format!("{n} is below {m}"));
                }
            }
            if let Some(m) = c.maximum {
                if n > m {
                    return fail("maximum", format!("{n} is above {m}"));
                }
            }
            if let Some(m) = c.exclusive_minimum {
                if n <= m {
                    return fail("exclusiveMinimum", format!("{n} is not above {m}"));
                }
            }
            if let Some(m) = c.exclusive_maximum {
                if n >= m {
                    return fail("exclusiveMaximum", format!("{n} is not below {m}"));
                }
            }
        }
        Json::String(s) => {
            let len = s.chars().count() as u64;
            if let Some(m) = c.min_length {
                if len < m {
                    return fail("minLength", format!("length {len} is below {m}"));
                }
            }
            if let Some(m) = c.max_length {
                if len > m {
                    return fail("maxLength", format!("length {len} is above {m}"));
                }
            }
            if let Some(re) = &c.pattern {
                if !re.is_match(s) {
                    return fail("pattern", format!("{s:?} does not match {}", re.as_str()));
                }
            }
        }
        Json::Array(a) => {
            let len = a.len() as u64;
            if let Some(m) = c.min_items {
                if len < m {
                    return fail("minItems", format!("{len} items is below {m}"));
                }
            }
            if let Some(m) = c.max_items {
                if len > m {
                    return fail("maxItems", format!("{len} items is above {m}"));
                }
            }
        }
        _ => {}
    }

    Ok(())
}

/// The JSON a [`Value`] is checked as. `None` for values constraints do not
/// speak about (nested resources, Loro documents, translations).
pub fn value_to_json(value: &Value) -> Option<Json> {
    Some(match value {
        Value::AtomicUrl(s) => Json::String(s.to_string()),
        Value::String(s) | Value::Markdown(s) | Value::Slug(s) | Value::Date(s) | Value::Uri(s) => {
            Json::String(s.clone())
        }
        Value::Integer(i) | Value::Timestamp(i) => Json::from(*i),
        Value::Float(f) => Json::Number(serde_json::Number::from_f64(*f)?),
        Value::Boolean(b) => Json::Bool(*b),
        Value::Json(j) => j.clone(),
        Value::ResourceArray(items) => Json::Array(
            items
                .iter()
                .map(|i| match i {
                    SubResource::Subject(s) => Json::String(s.to_string()),
                    SubResource::Nested(_) => Json::Object(Default::default()),
                })
                .collect(),
        ),
        Value::NestedResource(_)
        | Value::LoroDoc(_)
        | Value::LocalizedText(_)
        | Value::Unsupported(_) => return None,
    })
}

/// Checks a [`Value`] against a constraint.
pub fn check_value(c: &Constraint, value: &Value) -> Result<(), ConstraintError> {
    match value_to_json(value) {
        Some(json) => check_json(c, &json),
        None => Ok(()),
    }
}

/// Checks every value of `resource` against the constraints of each class in
/// its `isA`. Classes this store does not have are skipped, and so is a class
/// whose map does not parse (it is rejected when the class is written).
///
/// Error text: `Value for <shortname> breaks <keyword> on class <class>: <detail>`.
pub async fn check_resource(store: &impl Storelike, resource: &Resource) -> AtomicResult<()> {
    let Ok(classes) = resource.get(urls::IS_A).and_then(|v| v.to_subjects(None)) else {
        return Ok(());
    };

    for class_subject in classes {
        let Ok(class) = store.get_resource(&class_subject.as_str().into()).await else {
            continue;
        };
        let constraints = match constraints_of(&class) {
            Ok(Some(c)) => c,
            Ok(None) => continue,
            Err(e) => {
                tracing::warn!("Skipping constraints of {class_subject}: {e}");
                continue;
            }
        };

        for (prop, constraint) in &constraints {
            let Some(value) = resource.get(prop).ok().or_else(|| {
                resource
                    .get(&crate::identifiers::to_legacy_scheme(prop))
                    .ok()
            }) else {
                continue;
            };
            if let Err(e) = check_value(constraint, value) {
                let shortname = shortname_of(store, prop).await;
                let class_name = class
                    .get(urls::SHORTNAME)
                    .map(|v| v.to_string())
                    .unwrap_or(class_subject.clone());
                return Err(format!(
                    "Value for {shortname} breaks {} on class {class_name}: {}",
                    e.keyword, e.detail
                )
                .into());
            }
        }
    }

    Ok(())
}

async fn shortname_of(store: &impl Storelike, prop: &str) -> String {
    if let Ok(res) = store.get_resource(&prop.into()).await {
        if let Ok(s) = res.get(urls::SHORTNAME) {
            return s.to_string();
        }
    }
    prop.to_string()
}

#[cfg(test)]
mod test {
    use super::*;
    use serde_json::json;

    fn to_value(j: &Json) -> Value {
        match j {
            Json::String(s) => Value::String(s.clone()),
            Json::Bool(b) => Value::Boolean(*b),
            Json::Number(n) => match n.as_i64() {
                Some(i) => Value::Integer(i),
                None => Value::Float(n.as_f64().unwrap()),
            },
            Json::Array(a)
                if a.iter()
                    .all(|s| s.as_str().is_some_and(|s| s.contains(':'))) =>
            {
                Value::ResourceArray(
                    a.iter()
                        .map(|s| SubResource::Subject(s.as_str().unwrap().into()))
                        .collect(),
                )
            }
            other => Value::Json(other.clone()),
        }
    }

    #[test]
    fn shared_fixture() {
        let raw = include_str!("../tests/fixtures/class-constraints.json");
        let cases: Vec<Json> = serde_json::from_str(raw).unwrap();
        assert!(cases.len() > 50);

        for case in &cases {
            let constraint = parse_constraint(&case["constraint"]).unwrap();
            let valid = case["valid"].as_bool().unwrap();
            let rule = case.get("rule").and_then(Json::as_str);
            let value = &case["value"];

            // Run both entry points: raw JSON and through a typed `Value`.
            let typed = to_value(value);
            for result in [
                check_json(&constraint, value),
                check_value(&constraint, &typed),
            ] {
                match (&result, valid) {
                    (Ok(()), true) => {}
                    (Err(e), false) => assert_eq!(Some(e.keyword), rule, "case {case}"),
                    _ => panic!("case {case} gave {result:?}"),
                }
            }
        }
    }

    #[test]
    fn rejects_bad_maps() {
        for bad in [
            json!({ "p": { "minimun": 1 } }),
            json!({ "p": { "minimum": "1" } }),
            json!({ "p": { "minLength": -1 } }),
            json!({ "p": { "enum": "a" } }),
            json!({ "p": { "pattern": "(" } }),
            json!({ "p": { "class": 1 } }),
            json!({ "p": 1 }),
            json!([]),
        ] {
            parse_constraints(&bad).unwrap_err();
        }
        let ok = parse_constraints(&json!({ "did:ad:prop:x": { "maxItems": 1 } })).unwrap();
        assert!(ok.contains_key("atomic:prop:x"));
    }

    #[tokio::test]
    async fn check_resource_names_property_and_class() {
        let store = crate::Db::init_temp("class_constraints_check")
            .await
            .unwrap();
        store.populate().await.unwrap();

        let mut class = Resource::new_instance(urls::CLASS, &store).await.unwrap();
        class.set_subject("https://example.com/Task".into());
        class
            .set_string(urls::SHORTNAME.into(), "task", &store)
            .await
            .unwrap();
        class
            .set_string(urls::DESCRIPTION.into(), "A task", &store)
            .await
            .unwrap();
        class
            .set_unsafe(
                urls::CONSTRAINTS.into(),
                Value::Json(json!({ urls::NAME: { "maxLength": 3 } })),
            )
            .unwrap();
        validate_constraints_prop(&class).unwrap();
        class.save_locally(&store).await.unwrap();

        let mut task = Resource::new("https://example.com/task1".into());
        task.set_unsafe(
            urls::IS_A.into(),
            Value::ResourceArray(vec![SubResource::Subject(
                "https://example.com/Task".into(),
            )]),
        )
        .unwrap();
        task.set_string(urls::NAME.into(), "abc", &store)
            .await
            .unwrap();
        check_resource(&store, &task).await.unwrap();

        task.set_string(urls::NAME.into(), "abcd", &store)
            .await
            .unwrap();
        let err = check_resource(&store, &task).await.unwrap_err().to_string();
        assert!(
            err.starts_with("Value for name breaks maxLength on class task:"),
            "{err}"
        );
    }
}
