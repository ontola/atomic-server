use atomic_lib::{urls, Db};
use pyo3::exceptions::PyKeyError;
use pyo3::prelude::*;
use pyo3::types::PyDict;

use crate::{block_on, py_err, py_to_value, resolve_property, resource_to_dict, value_to_py};

/// A single Atomic resource: property → value, backed by a Loro document.
///
/// Dict-like access uses property URLs or well-known shortnames
/// (`resource["name"]`). Writes stay in memory until [`Resource.save`].
#[pyclass(unsendable)]
pub struct Resource {
    pub(crate) inner: atomic_lib::Resource,
    pub(crate) db: Db,
}

#[pymethods]
impl Resource {
    #[getter]
    fn subject(&self) -> String {
        self.inner.get_subject().to_string()
    }

    #[getter]
    fn name(&self) -> Option<String> {
        self.inner.get(urls::NAME).ok().map(|v| v.to_string())
    }

    #[setter]
    fn set_name(&mut self, name: &str) -> PyResult<()> {
        self.inner
            .set_unsafe(urls::NAME.into(), atomic_lib::Value::String(name.into()))
            .map_err(py_err)?;
        Ok(())
    }

    /// Set a property. `property` may be a URL or a shortname.
    fn set(&mut self, property: &str, value: &Bound<'_, PyAny>) -> PyResult<()> {
        let prop = resolve_property(property);
        self.inner
            .set_unsafe(prop, py_to_value(value)?)
            .map_err(py_err)?;
        Ok(())
    }

    /// Read a property, or `default` if it is missing.
    #[pyo3(signature = (property, default=None))]
    fn get<'py>(
        &self,
        py: Python<'py>,
        property: &str,
        default: Option<&Bound<'py, PyAny>>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let prop = resolve_property(property);
        match self.inner.get(&prop) {
            Ok(value) => value_to_py(py, value),
            Err(_) => match default {
                Some(d) => Ok(d.clone()),
                None => Ok(py.None().into_bound(py)),
            },
        }
    }

    fn __getitem__<'py>(&self, py: Python<'py>, property: &str) -> PyResult<Bound<'py, PyAny>> {
        let prop = resolve_property(property);
        match self.inner.get(&prop) {
            Ok(value) => value_to_py(py, value),
            Err(_) => Err(PyKeyError::new_err(property.to_string())),
        }
    }

    fn __setitem__(&mut self, property: &str, value: &Bound<'_, PyAny>) -> PyResult<()> {
        self.set(property, value)
    }

    fn __delitem__(&mut self, property: &str) -> PyResult<()> {
        let prop = resolve_property(property);
        if self.inner.get(&prop).is_err() {
            return Err(PyKeyError::new_err(property.to_string()));
        }
        self.inner.remove_propval(&prop).map_err(py_err)
    }

    fn __contains__(&self, property: &str) -> bool {
        self.inner.get(&resolve_property(property)).is_ok()
    }

    fn keys(&self) -> Vec<String> {
        self.inner.get_propvals().keys().cloned().collect()
    }

    /// Property URL → native Python value, plus `@id`.
    fn to_dict<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        resource_to_dict(py, &self.inner)
    }

    /// JSON-AD serialization of this resource.
    fn to_json(&self) -> PyResult<String> {
        self.inner.to_json_ad(None).map_err(py_err)
    }

    /// Sign and apply the pending edits to the local store.
    fn save(&mut self) -> PyResult<()> {
        block_on(self.inner.save_locally(&self.db)).map_err(py_err)?;
        Ok(())
    }

    /// Sign a destroy commit and remove the resource from the store.
    pub fn destroy(&mut self) -> PyResult<()> {
        block_on(self.inner.destroy(&self.db)).map_err(py_err)?;
        Ok(())
    }

    fn __repr__(&self) -> String {
        let name = self
            .inner
            .get(urls::NAME)
            .map(|v| v.to_string())
            .unwrap_or_default();
        format!("Resource(subject={:?}, name={:?})", self.subject(), name)
    }
}
