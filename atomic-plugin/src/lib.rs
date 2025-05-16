#[doc(hidden)]
pub mod bindings;

#[doc(hidden)]
pub use bindings::*;

// Types re-exports
pub use bindings::atomic::class_extender::types::{
    CommitContext, GetContext, ResourceJson, ResourceResponse,
};
pub use bindings::Guest;

use serde_json::Value as JsonValue;

/// High-level trait for implementing a Class Extender plugin.
pub trait AtomicPlugin {
    fn class_url() -> String;

    fn on_resource_get(
        _subject: &str,
        _resource: &mut JsonValue,
    ) -> Result<Option<JsonValue>, String> {
        Ok(None)
    }

    fn before_commit(_subject: &str, _resource: &JsonValue) -> Result<(), String> {
        Ok(())
    }

    fn after_commit(_subject: &str, _resource: &JsonValue) -> Result<(), String> {
        Ok(())
    }
}

#[doc(hidden)]
pub struct PluginWrapper<T>(std::marker::PhantomData<T>);

impl<T: AtomicPlugin> Guest for PluginWrapper<T> {
    fn class_url() -> String {
        T::class_url()
    }

    fn on_resource_get(ctx: GetContext) -> Result<Option<ResourceResponse>, String> {
        let mut json_value: JsonValue =
            serde_json::from_str(&ctx.snapshot.json_ad).map_err(|e| e.to_string())?;

        let result = T::on_resource_get(&ctx.snapshot.subject, &mut json_value)?;

        match result {
            Some(updated_json) => {
                let updated_payload = serde_json::to_string(&updated_json)
                    .map_err(|e| format!("Serialize error: {e}"))?;
                Ok(Some(ResourceResponse {
                    primary: ResourceJson {
                        subject: ctx.snapshot.subject,
                        json_ad: updated_payload,
                    },
                    referenced: Vec::new(),
                }))
            }
            None => Ok(None),
        }
    }

    fn before_commit(ctx: CommitContext) -> Result<(), String> {
        if let Some(snapshot) = ctx.snapshot {
            let json_value: JsonValue =
                serde_json::from_str(&snapshot.json_ad).map_err(|e| e.to_string())?;
            T::before_commit(&ctx.subject, &json_value)
        } else {
            Ok(())
        }
    }

    fn after_commit(ctx: CommitContext) -> Result<(), String> {
        if let Some(snapshot) = ctx.snapshot {
            let json_value: JsonValue =
                serde_json::from_str(&snapshot.json_ad).map_err(|e| e.to_string())?;
            T::after_commit(&ctx.subject, &json_value)
        } else {
            Ok(())
        }
    }
}

#[macro_export]
macro_rules! export_plugin {
    ($plugin_type:ty) => {
        struct Shim;
        impl $crate::Guest for Shim {
            fn class_url() -> String {
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
