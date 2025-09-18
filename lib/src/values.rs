//! A value is the part of an Atom that contains the actual information.

use crate::{
    datatype::{match_datatype, DataType},
    errors::AtomicResult,
    resources::PropVals,
    utils::{check_valid_uri, check_valid_url},
    Resource,
};
use regex::Regex;
use serde::{Deserialize, Serialize};

/// An individual Value in an Atom.
/// Note that creating values using `Value::from` might result in the wrong Datatype, as the from conversion makes assumptions (e.g. integers are Integers, not Timestamps).
/// Use `Value::SomeDataType()` for explicit creation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Value {
    AtomicUrl(String),
    Date(String),
    Integer(i64),
    Float(f64),
    Markdown(String),
    ResourceArray(Vec<SubResource>),
    Slug(String),
    String(String),
    /// Unix Epoch datetime in milliseconds
    Timestamp(i64),
    NestedResource(SubResource),
    Boolean(bool),
    Uri(String),
    JSON(serde_json::Value),
    Unsupported(UnsupportedValue),
}

/// A resource in a JSON-AD body can be any of these
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum SubResource {
    // I was considering using Resources for these, but that would involve
    // storing the paths in both the NestedResource as well as its parent
    // context, which could produce inconsistencies.
    Nested(PropVals),
    Subject(String),
}

/// When the Datatype of a Value is not handled by this library
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnsupportedValue {
    pub value: String,
    /// URL of the datatype
    pub datatype: String,
}

/// Only alphanumeric characters, no spaces
pub const SLUG_REGEX: &str = r"^[a-z0-9]+(?:-[a-z0-9]+)*$";
/// YYYY-MM-DD
pub const DATE_REGEX: &str = r"^\d{4}\-(0[1-9]|1[012])\-(0[1-9]|[12][0-9]|3[01])$";

impl Value {
    /// Check if the value `q_val` is present in `val`
    pub fn contains_value(&self, q_val: &Value) -> bool {
        let query_value = q_val.to_string();
        match self {
            Value::ResourceArray(_vec) => {
                let subs = self.to_subjects(None).unwrap_or_default();
                subs.iter().any(|v| v == &query_value)
            }
            other => other.to_string() == query_value,
        }
    }

    /// Returns the datatype for the value
    pub fn datatype(&self) -> DataType {
        match self {
            Value::AtomicUrl(_) => DataType::AtomicUrl,
            Value::Date(_) => DataType::Date,
            Value::Integer(_) => DataType::Integer,
            Value::Float(_) => DataType::Float,
            Value::Markdown(_) => DataType::Markdown,
            Value::ResourceArray(_) => DataType::ResourceArray,
            Value::Slug(_) => DataType::Slug,
            Value::String(_) => DataType::String,
            Value::Timestamp(_) => DataType::Timestamp,
            // TODO: these datatypes are not the same
            Value::NestedResource(_) => DataType::AtomicUrl,
            Value::Boolean(_) => DataType::Boolean,
            Value::Uri(_) => DataType::Uri,
            Value::JSON(_) => DataType::JSON,
            Value::Unsupported(s) => DataType::Unsupported(s.datatype.clone()),
        }
    }

    /// Creates a new Value from an explicit DataType.
    /// Fails if the input string does not convert.
    pub fn new(value: &str, datatype: &DataType) -> AtomicResult<Value> {
        match datatype {
            DataType::Integer => {
                let val: i64 = value.parse()?;
                Ok(Value::Integer(val))
            }
            DataType::Float => {
                let val: f64 = value.parse()?;
                Ok(Value::Float(val))
            }
            DataType::String => Ok(Value::String(value.into())),
            DataType::Markdown => Ok(Value::Markdown(value.into())),
            DataType::Slug => {
                let re = Regex::new(SLUG_REGEX).unwrap();
                if re.is_match(value) {
                    return Ok(Value::Slug(value.into()));
                }
                Err(format!(
                    "Not a valid slug: {}. Only alphanumerics, no spaces allowed.",
                    value
                )
                .into())
            }
            DataType::AtomicUrl => {
                check_valid_url(value)?;
                Ok(Value::AtomicUrl(value.into()))
            }
            DataType::Uri => {
                check_valid_uri(value)?;
                Ok(Value::Uri(value.into()))
            }
            DataType::JSON => {
                let json: serde_json::Value = serde_json::from_str(value)?;
                Ok(Value::JSON(json))
            }
            DataType::ResourceArray => {
                let vector: Vec<String> = crate::parse::parse_json_array(value).map_err(|e| {
                    format!("Could not deserialize ResourceArray: {}. Should be a JSON array of strings. {}", &value, e)
                })?;
                let mut new_vec = Vec::new();
                for i in vector {
                    new_vec.push(SubResource::Subject(i));
                }
                Ok(Value::ResourceArray(new_vec))
            }
            DataType::Date => {
                let re = Regex::new(DATE_REGEX).unwrap();
                if re.is_match(value) {
                    return Ok(Value::Date(value.into()));
                }
                Err(format!("Not a valid date: {}. Needs to be YYYY-MM-DD.", value).into())
            }
            DataType::Timestamp => {
                let val: i64 = value
                    .parse()
                    .map_err(|e| format!("Not a valid Timestamp: {}. {}", value, e))?;
                Ok(Value::Timestamp(val))
            }
            DataType::Unsupported(unsup_url) => Ok(Value::Unsupported(UnsupportedValue {
                value: value.into(),
                datatype: unsup_url.into(),
            })),
            DataType::Boolean => {
                let bool = match value {
                    "true" => true,
                    "false" => false,
                    other => {
                        return Err(format!(
                            "Not a valid boolean value: {}, should be 'true' or 'false'.",
                            other
                        )
                        .into())
                    }
                };
                Ok(Value::Boolean(bool))
            }
        }
    }

    /// Returns a new Value, accepts a datatype string
    pub fn new_from_string(value: &str, datatype: &str) -> AtomicResult<Value> {
        Value::new(value, &match_datatype(datatype))
    }

    /// Turns the value into a Vector of subject strings.
    /// Works for resource arrays with nested resources, full resources, single resources.
    /// Returns a path for for Anonymous Nested Resources, which is why you need to pass a parent_path e.g. `http://example.com/foo/bar https://atomicdata.dev/properties/children`.
    pub fn to_subjects(&self, parent_path: Option<String>) -> AtomicResult<Vec<String>> {
        let mut vec: Vec<String> = Vec::new();
        match self {
            Value::ResourceArray(arr) => {
                arr.iter()
                    .enumerate()
                    .for_each(|(i, r)| match r.to_owned() {
                        SubResource::Nested(_e) => {
                            let path_base = if let Some(p) = &parent_path {
                                p.to_string()
                            } else {
                                "nested_resource_without_parent_path".into()
                            };
                            vec.push(format!("{} {}", path_base, i))
                        }
                        SubResource::Subject(s) => vec.push(s),
                    });
                Ok(vec)
            }
            Value::AtomicUrl(s) => {
                vec.push(s.into());
                Ok(vec)
            }
            Value::NestedResource(_nr) => {
                // TODO: change the data model of nested resources to store the subject of the parent, so we can construct a path
                Err("Can't convert nested resources to subjects.".into())
            }
            other => Err(format!("Value {} is not a Resource Array, but {}", self, other).into()),
        }
    }

    pub fn to_bool(&self) -> AtomicResult<bool> {
        if let Value::Boolean(bool) = self {
            return Ok(bool.to_owned());
        }
        Err(format!("Value {} is not a Boolean", self).into())
    }

    /// Returns an Integer, if the Atom is one.
    pub fn to_int(&self) -> AtomicResult<i64> {
        match self {
            Value::Timestamp(int) | Value::Integer(int) => Ok(int.to_owned()),
            _ => self.to_string().parse::<i64>().map_err(|e| {
                format!("Value {} cannot be converted into integer. {}", self, e).into()
            }),
        }
    }

    /// Returns a PropVals Hashmap, if the Atom is a NestedResource
    pub fn to_nested(&self) -> AtomicResult<&PropVals> {
        if let Value::NestedResource(SubResource::Nested(nested)) = self {
            return Ok(nested);
        }
        Err(format!("Value {} is not a Nested Resource", self).into())
    }

    /// Returns a Lexicographically sortable string representation of the value
    pub fn to_sortable_string(&self) -> SortableValue {
        match self {
            Value::ResourceArray(arr) => arr.len().to_string(),
            other => other.to_string(),
        }
    }

    /// Converts one Value to a bunch of indexable items.
    /// Returns None for unsupported types.
    pub fn to_reference_index_strings(&self) -> Option<Vec<ReferenceString>> {
        let vals = match self {
            // TODO: This results in wrong indexing, as some subjects will be numbers.
            Value::ResourceArray(_v) => self.to_subjects(None).unwrap_or_else(|_| vec![]),
            Value::AtomicUrl(v) => vec![v.into()],
            // TODO We don't index nested resources for now
            Value::NestedResource(_r) => return None,
            // This might result in unnecessarily long strings, sometimes. We may want to shorten them later.
            val => vec![val.to_string()],
        };
        Some(vals)
    }
}

/// A value that is meant for checking reference indexes.
/// short. Vectors of subjects are turned into individual ReferenceStrings.
pub type ReferenceString = String;

/// String Value representing a lexicographically sortable string.
pub type SortableValue = String;

impl From<String> for Value {
    fn from(val: String) -> Self {
        Value::String(val)
    }
}

impl From<i32> for Value {
    fn from(val: i32) -> Self {
        Value::Integer(val as i64)
    }
}

impl From<usize> for Value {
    fn from(val: usize) -> Self {
        Value::Integer(val as i64)
    }
}

impl From<Vec<&str>> for Value {
    fn from(val: Vec<&str>) -> Self {
        let mut vec = Vec::new();
        for i in val {
            vec.push(SubResource::Subject(i.into()));
        }
        Value::ResourceArray(vec)
    }
}

impl From<Vec<String>> for Value {
    fn from(val: Vec<String>) -> Self {
        let mut vec = Vec::new();
        for i in val {
            vec.push(SubResource::Subject(i));
        }
        Value::ResourceArray(vec)
    }
}

impl From<Vec<SubResource>> for Value {
    fn from(val: Vec<SubResource>) -> Self {
        Value::ResourceArray(val)
    }
}

impl From<SubResource> for Value {
    fn from(val: SubResource) -> Self {
        match val {
            SubResource::Nested(n) => n.into(),
            SubResource::Subject(s) => s.into(),
        }
    }
}

impl From<PropVals> for Value {
    fn from(val: PropVals) -> Self {
        Value::NestedResource(SubResource::Nested(val))
    }
}

impl From<bool> for Value {
    fn from(val: bool) -> Self {
        Value::Boolean(val)
    }
}

impl From<f64> for Value {
    fn from(val: f64) -> Self {
        Value::Float(val)
    }
}

use std::fmt;
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::AtomicUrl(s) => write!(f, "{}", s),
            Value::Date(s) => write!(f, "{}", s),
            Value::Integer(i) => write!(f, "{}", i),
            Value::Float(float) => write!(f, "{}", float),
            Value::Markdown(i) => write!(f, "{}", i),
            Value::ResourceArray(v) => {
                let out = v
                    .iter()
                    .map(|i| i.to_string())
                    .collect::<Vec<String>>()
                    .join(",");
                write!(f, "{}", out)
            }
            Value::Slug(s) => write!(f, "{}", s),
            Value::String(s) => write!(f, "{}", s),
            Value::Timestamp(i) => write!(f, "{}", i),
            Value::NestedResource(n) => write!(f, "{:?}", n),
            Value::Boolean(b) => write!(f, "{}", b),
            Value::Uri(s) => write!(f, "{}", s),
            Value::JSON(s) => write!(f, "{}", s),
            Value::Unsupported(u) => write!(f, "{}", u.value),
        }
    }
}

impl fmt::Display for SubResource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut s: String = String::new();

        match self {
            SubResource::Nested(pv) => {
                let serialized = crate::serialize::propvals_to_json_ad_map(pv, None)
                    .unwrap_or_else(|_e| {
                        serde_json::Value::String(format!("Could not serialize {:?} : {}", pv, _e))
                    });
                s.push_str(&serialized.to_string());
            }
            SubResource::Subject(sub) => s.push_str(sub),
        }
        write!(f, "{}", s)
    }
}

impl From<&str> for SubResource {
    fn from(val: &str) -> Self {
        SubResource::Subject(val.to_owned())
    }
}

impl From<String> for SubResource {
    fn from(val: String) -> Self {
        SubResource::Subject(val)
    }
}

impl From<PropVals> for SubResource {
    fn from(val: PropVals) -> Self {
        SubResource::Nested(val)
    }
}

impl From<Resource> for SubResource {
    fn from(val: Resource) -> Self {
        SubResource::Subject(val.get_subject().into())
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn formats_correct_value() {
        let int = Value::new("8", &DataType::Integer).unwrap();
        assert!(int.to_string() == "8");
        let string = Value::new("string", &DataType::String).unwrap();
        assert!(string.to_string() == "string");
        let date = Value::new("1200-02-02", &DataType::Date).unwrap();
        assert!(date.to_string() == "1200-02-02");
        let float = Value::new("1.123123", &DataType::Float).unwrap();
        assert!(float.to_string() == "1.123123");
        let uri = Value::new("ldap://[2001:db8::7]/c=GB?objectClass?one", &DataType::Uri).unwrap();
        assert!(uri.to_string() == "ldap://[2001:db8::7]/c=GB?objectClass?one");

        let json = Value::new("{\"foo\": \"bar\", \"baz\": 123}", &DataType::JSON).unwrap();
        // Note: JSON serialization switches the order of the keys.
        assert!(
            json.to_string() == "{\"baz\":123,\"foo\":\"bar\"}"
                || json.to_string() == "{\"foo\":\"bar\",\"baz\":123}"
        );

        let converted = Value::from(8);
        assert!(converted.to_string() == "8");
    }

    #[test]
    fn fails_wrong_values() {
        Value::new("no int", &DataType::Integer).unwrap_err();
        Value::new("1.1", &DataType::Integer).unwrap_err();
        Value::new("no spaces", &DataType::Slug).unwrap_err();
        Value::new("120-02-02", &DataType::Date).unwrap_err();
        Value::new("12000-02-02", &DataType::Date).unwrap_err();
        Value::new("a", &DataType::Float).unwrap_err();
        Value::new("blabliebla", &DataType::Uri).unwrap_err();
        Value::new(
            "{\"foo\": \"bar\", \"trailing comma\": 123,}",
            &DataType::JSON,
        )
        .unwrap_err();
    }

    #[test]
    fn value_conversions_from_and_datatypes() {
        let int = Value::from(8);
        assert_eq!(int.datatype(), DataType::Integer);
        assert_eq!(int.to_string(), "8");
        let resource_rray = Value::from(vec!["https://atomicdata.dev/properties/description"]);
        assert_eq!(resource_rray.datatype(), DataType::ResourceArray);
        assert_eq!(
            resource_rray.to_string(),
            "https://atomicdata.dev/properties/description"
        );
        let float = Value::from(1.123123);
        assert_eq!(float.datatype(), DataType::Float);
        assert_eq!(float.to_string(), "1.123123");
        let converted = Value::from(8);
        assert_eq!(converted.datatype(), DataType::Integer);
        assert_eq!(converted.to_string(), "8");
    }

    #[test]
    fn value_to_subjects() {
        let subject_string = String::from("https://example.com/subject_string");
        let mut nested = PropVals::new();
        nested.insert(
            crate::urls::DESCRIPTION.into(),
            Value::Markdown("test".into()),
        );
        let full_resource = Resource::new("https://example.com/full_resource".into());
        let array_no_nested = Value::ResourceArray(vec![
            subject_string.clone().into(),
            full_resource.clone().into(),
        ]);
        assert_eq!(array_no_nested.to_subjects(None).unwrap().len(), 2);
        let array_nested = Value::ResourceArray(vec![
            subject_string.into(),
            full_resource.clone().into(),
            nested.into(),
        ]);
        let atom = crate::Atom::new(
            "https://example.com/parent_resource".into(),
            crate::urls::PARENT.into(),
            array_nested,
        );
        assert_eq!(
            atom.values_to_subjects().unwrap(),
            vec![
                "https://example.com/subject_string".to_string(),
                full_resource.get_subject().into(),
                "https://example.com/parent_resource https://atomicdata.dev/properties/parent 2"
                    .into(),
            ]
        );
    }

    #[test]
    fn test_all_datatypes_comprehensive() {
        // Test Boolean datatype
        let bool_true = Value::new("true", &DataType::Boolean).unwrap();
        assert_eq!(bool_true.to_string(), "true");
        let bool_false = Value::new("false", &DataType::Boolean).unwrap();
        assert_eq!(bool_false.to_string(), "false");
        
        // Boolean should fail with invalid values
        Value::new("maybe", &DataType::Boolean).unwrap_err();
        Value::new("1", &DataType::Boolean).unwrap_err();

        // Test Date datatype (ISO 8601 format)
        let date = Value::new("2023-12-25", &DataType::Date).unwrap();
        assert_eq!(date.to_string(), "2023-12-25");
        
        // Date should fail with invalid formats
        Value::new("25-12-2023", &DataType::Date).unwrap_err();
        Value::new("2023/12/25", &DataType::Date).unwrap_err();
        Value::new("invalid-date", &DataType::Date).unwrap_err();

        // Test Timestamp datatype (Unix timestamp in milliseconds)
        let timestamp = Value::new("1703462400000", &DataType::Timestamp).unwrap();
        assert_eq!(timestamp.to_string(), "1703462400000");
        
        // Timestamp should fail with invalid formats
        Value::new("not-a-number", &DataType::Timestamp).unwrap_err();
        Value::new("1703462400.5", &DataType::Timestamp).unwrap_err();

        // Test Slug datatype (lowercase, dashes only)
        let slug = Value::new("my-test-slug", &DataType::Slug).unwrap();
        assert_eq!(slug.to_string(), "my-test-slug");
        let slug_with_numbers = Value::new("test-123-slug", &DataType::Slug).unwrap();
        assert_eq!(slug_with_numbers.to_string(), "test-123-slug");
        
        // Slug should fail with invalid characters
        Value::new("My Slug", &DataType::Slug).unwrap_err(); // spaces
        Value::new("my_slug", &DataType::Slug).unwrap_err(); // underscores
        Value::new("my.slug", &DataType::Slug).unwrap_err(); // dots
        Value::new("MySlug", &DataType::Slug).unwrap_err(); // uppercase

        // Test AtomicUrl datatype
        let atomic_url = Value::new("https://atomicdata.dev/test", &DataType::AtomicUrl).unwrap();
        assert_eq!(atomic_url.to_string(), "https://atomicdata.dev/test");
        
        // AtomicUrl should fail with invalid URLs
        Value::new("not-a-url", &DataType::AtomicUrl).unwrap_err();
        Value::new("invalid://not-a-url", &DataType::AtomicUrl).unwrap_err();

        // Test Markdown datatype
        let markdown = Value::new("# Hello\n\nThis is **bold** text.", &DataType::Markdown).unwrap();
        assert_eq!(markdown.to_string(), "# Hello\n\nThis is **bold** text.");

        // Test ResourceArray with multiple types
        let resource_array_json = r#"["https://example.com/first", "https://example.com/second"]"#;
        let resource_array = Value::new(resource_array_json, &DataType::ResourceArray).unwrap();
        match resource_array {
            Value::ResourceArray(resources) => {
                assert_eq!(resources.len(), 2);
            }
            _ => panic!("Expected ResourceArray value"),
        }

        // Test complex JSON
        let complex_json = r#"{"nested": {"array": [1, 2, 3]}, "string": "value", "number": 42.5}"#;
        let json_value = Value::new(complex_json, &DataType::JSON).unwrap();
        // JSON parsing should succeed, order may vary
        assert!(json_value.to_string().contains("nested"));
        assert!(json_value.to_string().contains("array"));

        // Test edge cases for numeric types
        let max_int = Value::new("9223372036854775807", &DataType::Integer).unwrap(); // i64::MAX
        assert_eq!(max_int.to_string(), "9223372036854775807");
        
        let min_int = Value::new("-9223372036854775808", &DataType::Integer).unwrap(); // i64::MIN
        assert_eq!(min_int.to_string(), "-9223372036854775808");

        let scientific_float = Value::new("1.23e-4", &DataType::Float).unwrap();
        assert_eq!(scientific_float.to_string(), "0.000123"); // Scientific notation gets converted to decimal
        
        let negative_float = Value::new("-123.456", &DataType::Float).unwrap();
        assert_eq!(negative_float.to_string(), "-123.456");
    }

    #[test]
    fn test_datatype_conversions() {
        // Test From trait implementations
        let from_bool = Value::from(true);
        assert_eq!(from_bool.datatype(), DataType::Boolean);
        assert_eq!(from_bool.to_string(), "true");

        let from_i32 = Value::from(42i32);
        assert_eq!(from_i32.datatype(), DataType::Integer);
        assert_eq!(from_i32.to_string(), "42");

        // Note: i64 doesn't have From implementation, only i32 does
        let large_int = Value::Integer(1234567890123456789i64);
        assert_eq!(large_int.datatype(), DataType::Integer);
        assert_eq!(large_int.to_string(), "1234567890123456789");

        let from_f64 = Value::from(3.14159);
        assert_eq!(from_f64.datatype(), DataType::Float);
        assert_eq!(from_f64.to_string(), "3.14159");

        let from_string = Value::from("test string".to_string());
        assert_eq!(from_string.datatype(), DataType::String);
        assert_eq!(from_string.to_string(), "test string");

        // Test URL vector conversion
        let urls = vec!["https://example.com/1", "https://example.com/2"];
        let from_urls = Value::from(urls);
        assert_eq!(from_urls.datatype(), DataType::ResourceArray);
    }

    #[test]
    fn test_value_serialization_edge_cases() {
        // Test empty values
        let empty_string = Value::new("", &DataType::String).unwrap();
        assert_eq!(empty_string.to_string(), "");

        let empty_json = Value::new("{}", &DataType::JSON).unwrap();
        assert_eq!(empty_json.to_string(), "{}");

        let empty_array = Value::new("[]", &DataType::ResourceArray).unwrap();
        match empty_array {
            Value::ResourceArray(resources) => {
                assert_eq!(resources.len(), 0);
            }
            _ => panic!("Expected ResourceArray value"),
        }

        // Test whitespace handling
        let string_with_whitespace = Value::new("  spaced  ", &DataType::String).unwrap();
        assert_eq!(string_with_whitespace.to_string(), "  spaced  ");

        let markdown_with_whitespace = Value::new("\n\n  # Title  \n\n", &DataType::Markdown).unwrap();
        assert_eq!(markdown_with_whitespace.to_string(), "\n\n  # Title  \n\n");

        // Test unicode handling
        let unicode_string = Value::new("🚀 Hello 世界! émojis", &DataType::String).unwrap();
        assert_eq!(unicode_string.to_string(), "🚀 Hello 世界! émojis");

        let unicode_markdown = Value::new("# 标题\n\n**粗体** _斜体_", &DataType::Markdown).unwrap();
        assert_eq!(unicode_markdown.to_string(), "# 标题\n\n**粗体** _斜体_");
    }
}
