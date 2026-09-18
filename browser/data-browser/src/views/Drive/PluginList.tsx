import {
  core,
  readConnectionSubjects,
  server,
  useArray,
  useResource,
  useStore,
  useString,
  type Resource,
  type Server,
} from '@tomic/react';
import { useEffect, useState } from 'react';
import type React from 'react';
import { AtomicLink } from '@components/AtomicLink';
import styled from 'styled-components';
import { TableList } from '@components/TableList';

interface PluginListProps {
  drive: Resource<Server.Drive>;
}

export const PluginList: React.FC<PluginListProps> = ({ drive }) => {
  // Read via `useArray` (not `drive.props.plugins`) so the component
  // re-renders when the array changes. Reading `.props.X` directly inside
  // render is memoized by the React Compiler on the stable `drive` proxy
  // ref — an internal `push()` mutation doesn't change that ref, so a
  // direct read would never invalidate and the list would stay stuck on
  // "No plugins installed" after a fresh install.
  const [plugins] = useArray(drive, server.properties.plugins);
  const installations = useInstallations(drive.subject);
  const all = [...plugins, ...installations.filter(s => !plugins.includes(s))];

  if (all.length === 0) {
    return <NoPluginsInstalled>No plugins installed</NoPluginsInstalled>;
  }

  return (
    <TableList>
      <tbody>
        {all.map(plugin => (
          <PluginItem key={plugin} subject={plugin} />
        ))}
      </tbody>
    </TableList>
  );
};

/**
 * Installations are not listed on the drive's `plugins` property (that is the
 * legacy `Plugin` list); they are found by class under the drive, like the
 * Store does for connections.
 */
function useInstallations(drive: string): string[] {
  const store = useStore();
  const [subjects, setSubjects] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    readConnectionSubjects(
      store,
      drive,
      core.properties.isA,
      server.classes.installation,
    )
      .then(found => {
        if (active) setSubjects(found);
      })
      .catch(() => {
        // The legacy list still renders; the drive may not be on a server
        // that knows the Installation class yet.
      });

    return () => {
      active = false;
    };
  }, [store, drive]);

  return subjects;
}

const PluginItem: React.FC<{ subject: string }> = ({ subject }) => {
  // Subscribe to each field so the row re-renders when the plugin resource
  // finishes loading — same React Compiler reasoning as above.
  const resource = useResource<Server.Plugin | Server.Installation>(subject);
  const [namespace] = useString(resource, server.properties.namespace);
  const [name] = useString(resource, core.properties.name);
  const [version] = useString(resource, server.properties.version);
  const [status] = useString(resource, server.properties.installationStatus);

  const title = `${namespace ?? ''}/${name ?? ''}`;

  return (
    <tr>
      <td>
        <AtomicLink subject={subject}>{title}</AtomicLink>
      </td>
      <td>{version}</td>
      <td>{status}</td>
    </tr>
  );
};

const NoPluginsInstalled = styled.p`
  color: ${p => p.theme.colors.textLight};
  padding-block: ${p => p.theme.size()};
`;
