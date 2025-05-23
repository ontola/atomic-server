import {
  useResource,
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
  const plugins = drive.props.plugins ?? [];

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
  const resource = useResource<Server.Plugin>(subject);

  const title = `${resource.props.namespace ?? ''}/${resource.props.name ?? ''}`;

  return (
    <tr>
      <td>
        <AtomicLink subject={subject}>{title}</AtomicLink>
      </td>
      <td>{resource.props.version}</td>
    </tr>
  );
};

const NoPluginsInstalled = styled.p`
  color: ${p => p.theme.colors.textLight};
  padding-block: ${p => p.theme.size()};
`;
