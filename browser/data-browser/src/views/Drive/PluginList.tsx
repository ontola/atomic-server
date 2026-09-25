import {
  core,
  readConnectionSubjects,
  server,
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
import { FaTriangleExclamation } from 'react-icons/fa6';
import { useConnectionRequests } from '@helpers/connectionRequests';
import { platformName } from '@helpers/proxyConnections';

interface PluginListProps {
  drive: Resource<Server.Drive>;
}

/**
 * Every plugin on a drive is an `Installation` (the server migrates legacy
 * `Plugin` resources at startup), found by class under the drive like the
 * Store does for connections.
 */
export const PluginList: React.FC<PluginListProps> = ({ drive }) => {
  const installations = useInstallations(drive.subject);

  if (installations.length === 0) {
    return <NoPluginsInstalled>No plugins installed</NoPluginsInstalled>;
  }

  return (
    <TableList>
      <tbody>
        {installations.map(subject => (
          <PluginItem key={subject} subject={subject} />
        ))}
      </tbody>
    </TableList>
  );
};

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
        // Shown as empty; the drive may be on a server without the
        // Installation class.
      });

    return () => {
      active = false;
    };
  }, [store, drive]);

  return subjects;
}

const PluginItem: React.FC<{ subject: string }> = ({ subject }) => {
  // Subscribe to each field so the row re-renders when the resource finishes
  // loading; the React Compiler memoizes direct `.props` reads on the stable
  // proxy ref.
  const resource = useResource<Server.Installation>(subject);
  const [namespace] = useString(resource, server.properties.namespace);
  const [name] = useString(resource, core.properties.name);
  const [version] = useString(resource, server.properties.version);
  const [status] = useString(resource, server.properties.installationStatus);
  const store = useStore();
  // What the nodes that run it asked for (#1700 flow b); the Installation's
  // page connects it.
  const { open } = useConnectionRequests(store, subject, status !== 'revoked');
  const needs = [...new Set(open.map(r => platformName(r.platform)))].join(
    ', ',
  );

  const title = `${namespace ?? ''}/${name ?? ''}`;

  return (
    <tr>
      <td>
        <AtomicLink subject={subject}>{title}</AtomicLink>
      </td>
      <td>{version}</td>
      <td>
        {status}
        {needs && (
          <NeedsConnection>
            <FaTriangleExclamation aria-hidden />
            <span>Needs a connection: {needs}</span>
          </NeedsConnection>
        )}
      </td>
    </tr>
  );
};

const NeedsConnection = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  margin-inline-start: 0.5rem;
  font-size: 0.85rem;
  color: ${p => p.theme.colors.warning};
`;

const NoPluginsInstalled = styled.p`
  color: ${p => p.theme.colors.textLight};
  padding-block: ${p => p.theme.size()};
`;
