use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use crate::AtomicError;

/// Characters that must never appear in a plugin `name` or `namespace`.
/// `/` and `\` are path separators. `.` is the on-disk filename delimiter
/// (`{namespace}.{name}.wasm`) and also blocks `..` traversal.
const FORBIDDEN_IDENTIFIER_CHARS: [char; 3] = ['/', '\\', '.'];

/// Validate a plugin `name` or `namespace` as used on the Plugin resource and
/// in `plugin.json`. These values are interpolated into filesystem paths, so
/// they must be a single non-empty identifier with no separators or dots.
pub fn validate_plugin_identifier(field: &str, value: &str) -> Result<(), AtomicError> {
    if value.is_empty() || value != value.trim() {
        return Err(AtomicError::from(format!(
            "{field} must be a non-empty identifier without leading or trailing whitespace"
        )));
    }
    if value.contains(FORBIDDEN_IDENTIFIER_CHARS) {
        return Err(AtomicError::from(format!(
            "{field} cannot contain '/', '\\', or '.'"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(AtomicError::from(format!(
            "{field} cannot contain control characters"
        )));
    }
    if !is_single_normal_component(value) {
        return Err(AtomicError::from(format!(
            "{field} is not a valid plugin identifier"
        )));
    }
    Ok(())
}

/// True if `name` is a single filename component (dots allowed — used for
/// constructed names like `{namespace}.{name}.wasm`). Rejects separators,
/// empty strings, `.`, `..`, and control characters.
pub fn is_safe_plugin_filename(name: &str) -> bool {
    if name.is_empty() || name.contains(['/', '\\']) {
        return false;
    }
    if name.chars().any(char::is_control) {
        return false;
    }
    is_single_normal_component(name)
}

fn is_single_normal_component(name: &str) -> bool {
    let mut comps = Path::new(name).components();
    matches!(
        (comps.next(), comps.next()),
        (Some(Component::Normal(os)), None) if os == name
    )
}

/// Join a single filename onto `base`. Errors if `filename` is not a safe
/// single path component, so the result cannot escape `base`.
pub fn join_under_dir(base: &Path, filename: &str) -> Result<PathBuf, AtomicError> {
    if !is_safe_plugin_filename(filename) {
        return Err(AtomicError::from(format!(
            "invalid plugin filename: {filename}"
        )));
    }
    Ok(base.join(filename))
}

/// Join a relative path onto `base`, walking only `Normal` components.
/// Rejects `..`, absolute paths, prefixes, and backslashes so the result
/// cannot escape `base`. An empty `relative` returns `base` itself.
pub fn join_relative_under_dir(base: &Path, relative: &str) -> Result<PathBuf, AtomicError> {
    if relative.is_empty() {
        return Ok(base.to_path_buf());
    }
    if relative.contains(['\\', '\0']) {
        return Err(AtomicError::from(format!(
            "path {relative:?} is not contained in the plugin directory"
        )));
    }
    let mut out = base.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            _ => {
                return Err(AtomicError::from(format!(
                    "path {relative:?} is not contained in the plugin directory"
                )));
            }
        }
    }
    Ok(out)
}

#[derive(Serialize, Deserialize)]
pub struct PluginMeta {
    pub subject: String,
    pub agent_secret: String,
    pub manifest: PluginManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginMetaKey {
    pub drive: String,
    pub name: String,
    pub namespace: String,
}

impl PluginMetaKey {
    pub fn new(drive: &str, namespace: &str, name: &str) -> Self {
        Self {
            drive: drive.to_string(),
            namespace: namespace.to_string(),
            name: name.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub name: String,
    pub namespace: String,
    pub version: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub permissions: Option<Vec<PermissionEntry>>,
    pub default_config: Option<HashMap<String, serde_json::Value>>,
    pub config_schema: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionEntry {
    pub permission: PermissionType,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionType {
    Network,
    Storage,
    FullDriveAccess,
    ExtendedFuel,
    ExtendedMemory,
    CustomView,
}

impl PluginManifest {
    pub fn from_string(string: &str) -> Result<Self, AtomicError> {
        let manifest: Self = serde_json::from_str(string)
            .map_err(|e| AtomicError::from(format!("Failed to parse plugin manifest: {}", e)))?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn from_reader(reader: impl Read) -> Result<Self, AtomicError> {
        let manifest: Self = serde_json::from_reader(reader)
            .map_err(|e| AtomicError::from(format!("Failed to parse plugin manifest: {}", e)))?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn option_has_permission(
        manifest: Option<&PluginManifest>,
        permission: PermissionType,
    ) -> bool {
        let Some(manifest) = manifest else {
            return false;
        };

        manifest.has_permission(permission)
    }

    pub fn validate(&self) -> Result<(), AtomicError> {
        validate_plugin_identifier("name", &self.name)?;
        validate_plugin_identifier("namespace", &self.namespace)?;
        Ok(())
    }

    pub fn has_permission(&self, permission: PermissionType) -> bool {
        if let Some(permissions) = &self.permissions {
            return permissions.iter().any(|p| p.permission == permission);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn valid_manifest(name: &str, namespace: &str) -> PluginManifest {
        PluginManifest {
            name: name.to_string(),
            namespace: namespace.to_string(),
            version: "1.0.0".to_string(),
            description: None,
            author: None,
            permissions: None,
            default_config: None,
            config_schema: None,
        }
    }

    #[test]
    fn accepts_plain_identifiers() {
        assert!(validate_plugin_identifier("name", "calendar").is_ok());
        assert!(validate_plugin_identifier("namespace", "google").is_ok());
        assert!(valid_manifest("calendar", "google").validate().is_ok());
    }

    #[test]
    fn rejects_path_separators_and_dots() {
        for value in [
            "../tmp", "..", ".", "foo/bar", "foo\\bar", "foo.bar", "/tmp",
        ] {
            assert!(
                validate_plugin_identifier("namespace", value).is_err(),
                "should reject {value:?}"
            );
        }
        assert!(valid_manifest("ok", "../tmp").validate().is_err());
        assert!(valid_manifest("", "ns").validate().is_err());
        assert!(valid_manifest(" name", "ns").validate().is_err());
    }

    #[test]
    fn rejects_control_characters() {
        assert!(validate_plugin_identifier("name", "foo\0bar").is_err());
        assert!(validate_plugin_identifier("name", "foo\nbar").is_err());
    }

    #[test]
    fn join_under_dir_keeps_result_inside_base() {
        let base = Path::new("/plugins/scoped/drive");
        let joined = join_under_dir(base, "google.calendar.wasm").unwrap();
        assert_eq!(joined, base.join("google.calendar.wasm"));

        for filename in ["../secret.wasm", "/tmp/secret.wasm", "", "a/b.wasm", ".."] {
            assert!(
                join_under_dir(base, filename).is_err(),
                "should reject {filename:?}"
            );
        }
    }

    #[test]
    fn join_relative_under_dir_rejects_parent_and_absolute() {
        let base = Path::new("/plugins/scoped/drive/google");
        let ok = join_relative_under_dir(base, "icons/logo.png").unwrap();
        assert_eq!(ok, base.join("icons").join("logo.png"));

        assert_eq!(
            join_relative_under_dir(base, "").unwrap(),
            base.to_path_buf()
        );

        for rel in ["../secret", "/tmp/secret", "foo/../../etc", "foo\\bar"] {
            assert!(
                join_relative_under_dir(base, rel).is_err(),
                "should reject {rel:?}"
            );
        }
    }

    #[test]
    fn is_safe_plugin_filename_allows_constructed_wasm_names() {
        assert!(is_safe_plugin_filename("google.calendar.wasm"));
        assert!(is_safe_plugin_filename("google.calendar.ui.js"));
        assert!(!is_safe_plugin_filename("../tmp/x.wasm"));
        assert!(!is_safe_plugin_filename(".."));
        assert!(!is_safe_plugin_filename("."));
        assert!(!is_safe_plugin_filename(""));
    }
}
