import {
  core,
  server,
  useStore,
  type JSONValue,
  type Resource,
  type Server,
} from '@tomic/react';
import type { JSONSchema7 } from 'ai';

export interface PluginMetadata {
  name: string;
  namespace?: string;
  author?: string;
  description?: string;
  version: string;
  defaultConfig?: JSONValue;
  configSchema?: JSONSchema7;
}

interface CreatePluginProps {
  metadata: PluginMetadata;
  file: File;
  drive: Resource<Server.Drive>;
}

export function useCreatePlugin() {
  const store = useStore();

  const createPluginResource = async ({
    metadata,
    file,
    drive,
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
        [server.properties.config]: metadata.defaultConfig,
        [server.properties.jsonSchema]: metadata.configSchema as JSONValue,
        [server.properties.pluginFile]: 'https://placeholder',
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

  return {
    createPluginResource,
    installPlugin,
    uninstallPlugin,
  };
}
