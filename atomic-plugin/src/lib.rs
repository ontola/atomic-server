#[doc(hidden)]
pub mod bindings;

#[doc(hidden)]
pub use bindings::*;

// Types re-exports
pub use bindings::atomic::class_extender::host;
pub use bindings::atomic::class_extender::types::{
    CommitContext, GetContext, ResourceJson, ResourceResponse,
};

pub use bindings::Guest;

const IS_A: &str = "https://atomicdata.dev/properties/isA";

#[cfg(not(target_arch = "wasm32"))]
pub mod packaging;

// Re-export contents of packaging module directly if it exists
#[cfg(not(target_arch = "wasm32"))]
pub use packaging::packaging_impl;

use serde::Deserialize;
use serde_json::Value as JsonValue;

pub struct Resource {
    pub subject: String,
    pub props: serde_json::Map<String, JsonValue>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Commit {
    /// The subject URL that is to be modified by this Delta
    #[serde(rename = "https://atomicdata.dev/properties/subject")]
    pub subject: String,
    /// The date it was created, as a unix timestamp
    #[serde(rename = "https://atomicdata.dev/properties/createdAt")]
    pub created_at: i64,
    /// The URL of the one signing this Commit
    #[serde(rename = "https://atomicdata.dev/properties/signer")]
    pub signer: String,
    /// The set of PropVals that need to be added.
    /// Overwrites existing values
    #[serde(rename = "https://atomicdata.dev/properties/set")]
    pub set: Option<std::collections::HashMap<String, JsonValue>>,
    #[serde(rename = "https://atomicdata.dev/properties/yUpdate")]
    pub y_update: Option<std::collections::HashMap<String, JsonValue>>,
    #[serde(rename = "https://atomicdata.dev/properties/remove")]
    /// The set of property URLs that need to be removed
    pub remove: Option<Vec<String>>,
    /// If set to true, deletes the entire resource
    #[serde(rename = "https://atomicdata.dev/properties/destroy")]
    pub destroy: Option<bool>,
    /// Base64 encoded signature of the JSON serialized Commit
    #[serde(rename = "https://atomicdata.dev/properties/signature")]
    pub signature: Option<String>,
    /// List of Properties and Arrays to be appended to them
    #[serde(rename = "https://atomicdata.dev/properties/push")]
    pub push: Option<std::collections::HashMap<String, JsonValue>>,
    /// The previously applied commit to this Resource.
    #[serde(rename = "https://atomicdata.dev/properties/previousCommit")]
    pub previous_commit: Option<String>,
    /// The URL of the Commit
    pub url: Option<String>,
}

/// High-level trait for implementing a Class Extender plugin.
pub trait ClassExtender {
    fn class_url() -> Vec<String>;

    /// Called when a resource is fetched from the server. You can modify the resource in place.
    fn on_resource_get<'a>(resource: &'a mut Resource) -> Result<Option<&'a Resource>, String> {
        Ok(Some(resource))
    }

    /// Called before a Commit that targets the class is persisted. If you return an error, the commit will be rejected.
    fn before_commit(_commit: &Commit, _snapshot: &Resource) -> Result<(), String> {
        Ok(())
    }

    /// Called after a Commit that targets the class has been applied. Returning an error will not cancel the commit.
    fn after_commit(_commit: &Commit, _resource: &Resource) -> Result<(), String> {
        Ok(())
    }
}

#[doc(hidden)]
pub struct PluginWrapper<T>(std::marker::PhantomData<T>);

impl<T: ClassExtender> Guest for PluginWrapper<T> {
    fn class_url() -> Vec<String> {
        T::class_url()
    }

    fn on_resource_get(ctx: GetContext) -> Result<Option<ResourceResponse>, String> {
        let mut resource = Resource::try_from(ctx.snapshot)?;

        let Some(result) = T::on_resource_get(&mut resource)? else {
            return Ok(None);
        };

        let updated_payload = result.to_json()?;

        Ok(Some(ResourceResponse {
            primary: ResourceJson {
                subject: resource.subject,
                json_ad: updated_payload,
            },
            referenced: Vec::new(),
        }))
    }

    fn before_commit(ctx: CommitContext) -> Result<(), String> {
        let commit: Commit = serde_json::from_str(&ctx.commit_json).map_err(|e| e.to_string())?;
        let snapshot: Resource = Resource::try_from(ctx.snapshot)?;

        T::before_commit(&commit, &snapshot)
    }

    fn after_commit(ctx: CommitContext) -> Result<(), String> {
        let commit: Commit = serde_json::from_str(&ctx.commit_json).map_err(|e| e.to_string())?;
        let snapshot: Resource = Resource::try_from(ctx.snapshot)?;

        T::after_commit(&commit, &snapshot)
    }
}

#[macro_export]
macro_rules! export_plugin {
    ($plugin_type:ty) => {
        struct Shim;
        impl $crate::Guest for Shim {
            fn class_url() -> Vec<String> {
                <$crate::PluginWrapper<$plugin_type> as $crate::Guest>::class_url()
            }
            fn on_resource_get(ctx: $crate::GetContext) -> Result<Option<$crate::ResourceResponse>, String> {
                <$crate::PluginWrapper<$plugin_type> as $crate::Guest>::on_resource_get(ctx)
            }
            fn before_commit(ctx: $crate::CommitContext) -> Result<(), String> {
                <$crate::PluginWrapper<$plugin_type> as $crate::Guest>::before_commit(ctx)
            }
            fn after_commit(ctx: $crate::CommitContext) -> Result<(), String> {
                <$crate::PluginWrapper<$plugin_type> as $crate::Guest>::after_commit(ctx)
            }
        }

       $crate::__export_world_class_extender_cabi!(Shim with_types_in $crate::bindings);
    };
}

/// Gets a resource from the store, optionally uses the given agent. If no agent is provided the public agent is used.
pub fn get_resource(subject: String, agent: Option<String>) -> Result<Resource, String> {
    host::get_resource(&subject, agent.as_deref())
        .map(|json| Resource::try_from(json).map_err(|e| e.to_string()))?
}

pub fn query(
    property: String,
    value: String,
    agent: Option<String>,
) -> Result<Vec<Resource>, String> {
    host::query(&property, &value, agent.as_deref()).map(|json| {
        json.into_iter()
            .map(|json| Resource::try_from(json).map_err(|e| e.to_string()))
            .collect::<Result<Vec<Resource>, String>>()
    })?
}

pub fn get_config<'a, T>() -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let config_str = host::get_config();
    serde_json::from_str::<T>(&config_str)
        .map_err(|e| format!("Failed to deserialize config: {}", e))
}

impl TryFrom<ResourceJson> for Resource {
    type Error = String;

    fn try_from(resource_json: ResourceJson) -> Result<Self, Self::Error> {
        let json_value: JsonValue = serde_json::from_str(&resource_json.json_ad)
            .map_err(|e| format!("Invalid JSON: {}", e))?;

        let Some(obj) = json_value.as_object() else {
            return Err("Resource is not a JSON object".into());
        };

        let mut props = obj.clone();
        props.remove("@id");

        Ok(Self {
            subject: resource_json.subject,
            props,
        })
    }
}

impl Resource {
    pub fn to_json(&self) -> Result<String, String> {
        let mut props = self.props.clone();
        props.insert("@id".to_string(), JsonValue::String(self.subject.clone()));
        serde_json::to_string(&props).map_err(|e| format!("Serialize error: {e}"))
    }

    pub fn is_a(&self, class: &str) -> bool {
        let Some(is_a) = self.props.get(IS_A) else {
            return false;
        };

        let Some(is_a_subjects) = is_a.as_array() else {
            return false;
        };

        is_a_subjects
            .iter()
            .any(|subject| subject.as_str() == Some(class))
    }
}
