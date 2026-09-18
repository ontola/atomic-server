import type { PluginMetadata } from '@chunks/Plugins/plugins';
import {
  server,
  useStore,
  type JSONValue,
  type Resource,
  type Server,
} from '@tomic/react';
import toast from 'react-hot-toast';
import { useCustomViews } from '@components/CustomViewProvider';

/**
 * Maintenance of `Plugin` resources that were installed by zip upload before
 * releases existed. New installs go through `installRelease` (an
 * `Installation` pinned to a published release); see
 * `chunks/Plugins/NewPluginButton.tsx`.
 */
export function useCreatePlugin() {
  const store = useStore();
  const { refresh: refreshCustomViews } = useCustomViews();

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
    await refreshCustomViews();
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

    await plugin.set(server.properties.pluginFile, fileSubject);

    if (updatedConfig) {
      await plugin.set(server.properties.config, updatedConfig);
    }

    try {
      await plugin.save();
    } catch (err) {
      toast.error(err.message);
    }

    // Refresh so we see any new dynamic properties if those were added.
    await plugin.refresh();
  };

  return {
    uninstallPlugin,
    updatePlugin,
  };
}
