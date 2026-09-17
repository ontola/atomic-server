import {
  core,
  server,
  useArray,
  useResource,
  useString,
  type Resource,
  type Server,
} from '@tomic/react';
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

  if (plugins.length === 0) {
    return <NoPluginsInstalled>No plugins installed</NoPluginsInstalled>;
  }

  return (
    <TableList>
      <tbody>
        {plugins.map(plugin => (
          <PluginItem key={plugin} subject={plugin} />
        ))}
      </tbody>
    </TableList>
  );
};

const PluginItem: React.FC<{ subject: string }> = ({ subject }) => {
  // Subscribe to each field so the row re-renders when the plugin resource
  // finishes loading — same React Compiler reasoning as above.
  const resource = useResource<Server.Plugin>(subject);
  const [namespace] = useString(resource, server.properties.namespace);
  const [name] = useString(resource, core.properties.name);
  const [version] = useString(resource, server.properties.version);

  const title = `${namespace ?? ''}/${name ?? ''}`;

  return (
    <tr>
      <td>
        <AtomicLink subject={subject}>{title}</AtomicLink>
      </td>
      <td>{version}</td>
    </tr>
  );
};

const NoPluginsInstalled = styled.p`
  color: ${p => p.theme.colors.textLight};
  padding-block: ${p => p.theme.size()};
`;
