import type { PluginMetadata } from '@chunks/Plugins/plugins';
import {
  core,
  server,
  useStore,
  type JSONValue,
  type Resource,
  type Server,
} from '@tomic/react';

interface CreatePluginProps {
  metadata: PluginMetadata;
  config: JSONValue;
  file: File;
  drive: Resource<Server.Drive>;
}

export function useCreatePlugin() {
  const store = useStore();

  const createPluginResource = async ({
    metadata,
    file,
    drive,
    config,
  }: CreatePluginProps): Promise<Resource<Server.Plugin>> => {
    const plugin = await store.newResource({
      isA: server.classes.plugin,
      parent: drive.subject,
      propVals: {
        [core.properties.name]: metadata.name,
        [core.properties.description]: metadata.description,
        [server.properties.version]: metadata.version,
        [server.properties.pluginAuthor]: metadata.author,
        [server.properties.namespace]: metadata.namespace,
        [server.properties.config]: config,
        [server.properties.jsonSchema]: metadata.configSchema as JSONValue,
      },
    });

    await plugin.save();

    const [fileSubject] = await store.uploadFiles([file], plugin.subject);

    await plugin.set(server.properties.pluginFile, fileSubject);
    await plugin.save();

    return plugin;
  };

  const installPlugin = async (
    plugin: Resource<Server.Plugin>,
    drive: Resource<Server.Drive>,
  ): Promise<void> => {
    drive.push(server.properties.plugins, [plugin.subject], true);
    await drive.save();
  };

  const uninstallPlugin = async (
    plugin: Resource<Server.Plugin>,
  ): Promise<void> => {
    const driveSubject = plugin.props.parent;
    await plugin.destroy();

    const drive = await store.getResource<Server.Drive>(driveSubject);
    await drive.set(
      server.properties.plugins,
      drive.props.plugins?.filter(p => p !== plugin.subject),
    );
    await drive.save();
  };

  const updatePlugin = async (
    plugin: Resource<Server.Plugin>,
    metadata: PluginMetadata,
    file: File,
    updatedConfig?: JSONValue,
  ): Promise<void> => {
    if (
      metadata.name !== plugin.props.name ||
      metadata.namespace !== plugin.props.namespace
    ) {
      throw new Error(
        "The update's identifier does not match the existing plugin.",
      );
    }

    const [fileSubject] = await store.uploadFiles([file], plugin.subject);

    await plugin.set(server.properties.version, metadata.version);
    await plugin.set(core.properties.description, metadata.description);
    await plugin.set(server.properties.pluginAuthor, metadata.author);
    await plugin.set(
      server.properties.jsonSchema,
      metadata.configSchema as JSONValue,
    );
    await plugin.set(server.properties.pluginFile, fileSubject);

    if (updatedConfig) {
      await plugin.set(server.properties.config, updatedConfig);
    }

    await plugin.save();
  };

  return {
    createPluginResource,
    installPlugin,
    uninstallPlugin,
    updatePlugin,
  };
}
