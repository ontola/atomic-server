use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;

use crate::AtomicError;

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
        let forbidden = ['/', '.'];

        for field_name in [("name", &self.name), ("namespace", &self.namespace)] {
            if field_name.1.contains(forbidden) {
                return Err(AtomicError::from(format!(
                    "{} cannot contain '/' or '.'",
                    field_name.0
                )));
            }
        }

        Ok(())
    }

    pub fn has_permission(&self, permission: PermissionType) -> bool {
        if let Some(permissions) = &self.permissions {
            return permissions.iter().any(|p| p.permission == permission);
        }
        false
    }
}
