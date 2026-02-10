import {
  useCanWrite,
  useResource,
  type Resource,
  type Server,
} from '@tomic/react';
import type React from 'react';
import { Column, Row } from '@components/Row';
import { lazy, Suspense } from 'react';
import { Spinner } from '@components/Spinner';
import { Card } from '@components/Card';
import { AtomicLink } from '@components/AtomicLink';
import styled from 'styled-components';
import { TableList } from '@components/TableList';

const NewPluginButton = lazy(() => import('@chunks/Plugins/NewPluginButton'));
interface PluginListProps {
  drive: Resource<Server.Drive>;
}

export const PluginList: React.FC<PluginListProps> = ({ drive }) => {
  const plugins = drive.props.plugins ?? [];
  const canWriteDrive = useCanWrite(drive);

  return (
    <Card>
      <Column gap='1rem'>
        <Suspense fallback={<Spinner />}>
          <Row justify='space-between'>
            <h2>Plugins</h2>
            {canWriteDrive && <NewPluginButton drive={drive} />}
          </Row>
        </Suspense>
        {plugins.length > 0 ? (
          <TableList>
            <tbody>
              {plugins.map(plugin => (
                <PluginItem key={plugin} subject={plugin} />
              ))}
            </tbody>
          </TableList>
        ) : (
          <NoPluginsInstalled>No plugins installed</NoPluginsInstalled>
        )}
      </Column>
    </Card>
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
  text-align: center;
  color: ${p => p.theme.colors.textLight};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
`;
