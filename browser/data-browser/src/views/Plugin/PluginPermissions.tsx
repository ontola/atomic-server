import type {
  PluginPermission,
  PluginPermissionType,
} from '@chunks/Plugins/plugins';
import { Column, Row } from '@components/Row';
import {
  FaDesktop,
  FaFire,
  FaGlobe,
  FaHardDrive,
  FaMemory,
  FaShield,
} from 'react-icons/fa6';
import styled from 'styled-components';

interface PluginPermissionsProps {
  permissions?: PluginPermission[];
  title?: string;
}

const TITLES = {
  network: 'Network',
  storage: 'Storage',
  'full-drive-access': 'Full Drive Access',
  'extended-fuel': 'Extended Fuel',
  'extended-memory': 'Extended Memory',
  'custom-view': 'Custom View',
} satisfies Record<PluginPermissionType, string>;

const ICONS = {
  network: <FaGlobe />,
  storage: <FaHardDrive />,
  'full-drive-access': <FaShield />,
  'extended-fuel': <FaFire />,
  'extended-memory': <FaMemory />,
  'custom-view': <FaDesktop />,
} satisfies Record<PluginPermissionType, React.ReactNode>;

export const PluginPermissions: React.FC<PluginPermissionsProps> = ({
  permissions = [],
  title = 'Permissions',
}) => {
  return (
    <Column>
      <h3>{title}</h3>
      <PermissionList>
        {permissions.length === 0 && (
          <li>
            <p>No permissions required</p>
          </li>
        )}
        {permissions.map(permission => (
          <li key={permission.permission}>
            <PermissionTitle center gap='0.5ch'>
              {ICONS[permission.permission]} {TITLES[permission.permission]}
            </PermissionTitle>
            <p>{permission.reason || 'No reason provided'}</p>
          </li>
        ))}
      </PermissionList>
    </Column>
  );
};

const PermissionList = styled.ul`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size()};
  padding: 0;
  margin: 0;

  li {
    background-color: ${p => p.theme.colors.bg1};
    border-radius: ${p => p.theme.radius};
    list-style: none;
    padding: ${p => p.theme.size()};
    margin: 0;

    p {
      margin: 0;
    }
  }
`;

const PermissionTitle = styled(Row)`
  font-weight: bold;
  font-size: 0.9rem;
  color: ${p => p.theme.colors.textLight};
`;
