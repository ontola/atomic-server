use std::path::PathBuf;

use atomic_lib::{
    agents::ForAgent,
    class_extender::{BoxFuture, ClassExtender, ClassExtenderScope, CommitExtenderContext},
    errors::AtomicResult,
    urls::{self},
    AtomicError, Storelike, Value,
};

use crate::plugins::wasm::uninstall_plugin;

fn on_before_commit(
    context: CommitExtenderContext,
    plugins_dir: PathBuf,
) -> BoxFuture<AtomicResult<()>> {
    tracing::info!("on_before_commit plugin");
    Box::pin(async move {
        let CommitExtenderContext {
            store,
            commit,
            resource,
        } = context;

        if commit.destroy.unwrap_or(false) == false {
            // Plugin is not being deleted so we don't need to do anything.
            return Ok(());
        }

        tracing::info!("destroying plugin {}", resource.get_subject());

        let Ok(Value::String(name)) = resource.get(urls::NAME) else {
            return Err(AtomicError::from(format!(
                "Plugin {} has no name",
                resource.get_subject()
            )));
        };

        let Ok(Value::String(namespace)) = resource.get(urls::NAMESPACE) else {
            return Err(AtomicError::from(format!(
                "Plugin {} has no namespace",
                resource.get_subject()
            )));
        };

        let Ok(Value::AtomicUrl(parent_subject)) = resource.get(urls::PARENT) else {
            return Err(AtomicError::from(format!(
                "Plugin {} has no parent",
                resource.get_subject()
            )));
        };

        let parent_resource = store
            .get_resource_extended(parent_subject, true, &ForAgent::Sudo)
            .await?
            .to_single();

        if !parent_resource
            .get(urls::IS_A)?
            .to_subjects(None)?
            .contains(&urls::DRIVE.to_string())
        {
            return Err(AtomicError::from(format!(
                "Parent resource for plugin {} is not a drive",
                resource.get_subject()
            )));
        };

        tracing::info!(
            "uninstalling plugin {} in namespace {} for drive {}",
            name,
            namespace,
            parent_subject
        );

        uninstall_plugin(name, namespace, parent_subject, store, &plugins_dir).await?;
        Ok(())
    })
}

pub fn build_plugin_extender(plugins_dir: PathBuf) -> ClassExtender {
    ClassExtender {
        id: Some("plugin".to_string()),
        classes: vec![urls::PLUGIN.to_string()],
        on_resource_get: None,
        before_commit: Some(ClassExtender::wrap_commit_handler(move |context| {
            on_before_commit(context, plugins_dir.clone())
        })),
        after_commit: None,
        scope: ClassExtenderScope::Global,
    }
}
