use atomic_lib::{urls, values::SubResource, Resource, Value};
use pyo3::exceptions::{PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};
use pyo3::IntoPyObjectExt;

pub(crate) fn py_err(err: impl ToString) -> PyErr {
    pyo3::exceptions::PyRuntimeError::new_err(err.to_string())
}

/// Map a shortname or URL to a property URL.
///
/// Full `https://` / `http://` / `did:` strings pass through. Well-known
/// core shortnames resolve to `https://atomicdata.dev/properties/{name}`.
/// Anything else is treated as that same core-property convention so
/// `resource["description"] = "..."` works without importing `urls`.
pub(crate) fn resolve_property(name: &str) -> String {
    if name.starts_with("https://") || name.starts_with("http://") || name.starts_with("did:") {
        return name.to_string();
    }
    match name {
        "name" => urls::NAME.to_string(),
        "description" => urls::DESCRIPTION.to_string(),
        "parent" => urls::PARENT.to_string(),
        "isA" | "is_a" | "isa" => urls::IS_A.to_string(),
        "shortname" => urls::SHORTNAME.to_string(),
        "datatype" => urls::DATATYPE_PROP.to_string(),
        "read" => urls::READ.to_string(),
        "write" => urls::WRITE.to_string(),
        "children" => urls::CHILDREN.to_string(),
        "drives" => urls::DRIVES.to_string(),
        "classType" | "classtype" => urls::CLASSTYPE_PROP.to_string(),
        "requires" => urls::REQUIRES.to_string(),
        "recommends" => urls::RECOMMENDS.to_string(),
        other => format!("https://atomicdata.dev/properties/{other}"),
    }
}

pub(crate) fn py_to_value(obj: &Bound<'_, PyAny>) -> PyResult<Value> {
    if obj.is_none() {
        return Err(PyValueError::new_err(
            "cannot store None as an Atomic value",
        ));
    }
    // `bool` is a subclass of `int` in Python — check it first.
    if let Ok(b) = obj.extract::<bool>() {
        return Ok(Value::Boolean(b));
    }
    if let Ok(i) = obj.extract::<i64>() {
        return Ok(Value::Integer(i));
    }
    if let Ok(f) = obj.extract::<f64>() {
        return Ok(Value::Float(f));
    }
    if let Ok(s) = obj.extract::<String>() {
        if s.starts_with("https://") || s.starts_with("http://") || s.starts_with("did:") {
            return Ok(Value::AtomicUrl(s.into()));
        }
        return Ok(Value::String(s));
    }
    if let Ok(list) = obj.downcast::<PyList>() {
        let mut subjects = Vec::with_capacity(list.len());
        let mut all_strings = true;
        for item in list.iter() {
            if let Ok(s) = item.extract::<String>() {
                subjects.push(SubResource::Subject(s.into()));
            } else {
                all_strings = false;
                break;
            }
        }
        if all_strings {
            return Ok(Value::ResourceArray(subjects));
        }
        return json_value(obj);
    }
    if obj.downcast::<PyDict>().is_ok() {
        return json_value(obj);
    }
    Err(PyTypeError::new_err(format!(
        "cannot convert Python {} to an Atomic value",
        obj.get_type().name()?
    )))
}

fn json_value(obj: &Bound<'_, PyAny>) -> PyResult<Value> {
    let dumps = obj.py().import("json")?.getattr("dumps")?;
    let encoded: String = dumps.call1((obj,))?.extract()?;
    let parsed: serde_json::Value = serde_json::from_str(&encoded).map_err(py_err)?;
    Ok(Value::Json(parsed))
}

pub(crate) fn value_to_py<'py>(py: Python<'py>, value: &Value) -> PyResult<Bound<'py, PyAny>> {
    match value {
        Value::Boolean(b) => (*b).into_bound_py_any(py),
        Value::Integer(i) => (*i).into_bound_py_any(py),
        Value::Timestamp(i) => (*i).into_bound_py_any(py),
        Value::Float(f) => (*f).into_bound_py_any(py),
        Value::String(s) | Value::Markdown(s) | Value::Slug(s) | Value::Date(s) | Value::Uri(s) => {
            s.as_str().into_bound_py_any(py)
        }
        Value::AtomicUrl(s) => s.to_string().into_bound_py_any(py),
        Value::ResourceArray(items) => {
            let list = PyList::empty(py);
            for item in items {
                list.append(subresource_to_py(py, item)?)?;
            }
            Ok(list.into_any())
        }
        Value::NestedResource(item) => subresource_to_py(py, item),
        Value::Json(v) => loads_json(py, &v.to_string()),
        Value::LocalizedText(map) => {
            let json = serde_json::to_string(map).map_err(py_err)?;
            loads_json(py, &json)
        }
        Value::LoroDoc(bytes) => bytes.as_slice().into_bound_py_any(py),
        Value::Unsupported(u) => u.value.as_str().into_bound_py_any(py),
    }
}

fn subresource_to_py<'py>(py: Python<'py>, item: &SubResource) -> PyResult<Bound<'py, PyAny>> {
    match item {
        SubResource::Subject(s) => s.to_string().into_bound_py_any(py),
        SubResource::Nested(propvals) => {
            let dict = PyDict::new(py);
            for (key, val) in propvals {
                dict.set_item(key, value_to_py(py, val)?)?;
            }
            Ok(dict.into_any())
        }
    }
}

fn loads_json<'py>(py: Python<'py>, json: &str) -> PyResult<Bound<'py, PyAny>> {
    py.import("json")?.call_method1("loads", (json,))
}

/// Used when we already have a `Resource` and want a Python dict of its
/// current propvals (URL keys, native Python values).
pub(crate) fn resource_to_dict<'py>(
    py: Python<'py>,
    resource: &Resource,
) -> PyResult<Bound<'py, PyDict>> {
    let dict = PyDict::new(py);
    dict.set_item("@id", resource.get_subject().to_string())?;
    for (key, val) in resource.get_propvals() {
        dict.set_item(key, value_to_py(py, val)?)?;
    }
    Ok(dict)
}
