import { Column, Row } from '@components/Row';
import type { ReviewCapability } from '@tomic/react';
import {
  FaDesktop,
  FaFire,
  FaGlobe,
  FaHardDrive,
  FaKey,
  FaMemory,
  FaShield,
} from 'react-icons/fa6';
import { styled } from 'styled-components';

const LABELS: Record<string, string> = {
  network: 'Network',
  storage: 'Storage',
  'full-drive-access': 'Full Drive Access',
  'extended-fuel': 'Extended Fuel',
  'extended-memory': 'Extended Memory',
  'custom-view': 'Custom View',
};

const ICONS: Record<string, React.ReactNode> = {
  network: <FaGlobe />,
  storage: <FaHardDrive />,
  'full-drive-access': <FaShield />,
  'extended-fuel': <FaFire />,
  'extended-memory': <FaMemory />,
  'custom-view': <FaDesktop />,
};

function iconFor(capability: ReviewCapability): React.ReactNode {
  if (ICONS[capability.title]) return ICONS[capability.title];

  switch (capability.kind) {
    case 'secret':
      return <FaKey />;
    case 'operation':
    case 'network':
      return <FaGlobe />;
    default:
      return <FaShield />;
  }
}

/**
 * The `pluginPermissions` the server writes onto an Installation
 * (`[{ permission, reason }]`), as review lines. Anything malformed is left
 * out rather than trusted.
 */
export function capabilitiesFromPermissions(
  permissions: unknown,
): ReviewCapability[] {
  if (!Array.isArray(permissions)) return [];

  return permissions.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const { permission, reason } = entry as Record<string, unknown>;
    if (typeof permission !== 'string') return [];

    return [
      {
        kind: 'permission' as const,
        title: permission,
        reason: typeof reason === 'string' ? reason : undefined,
        grant: permission,
      },
    ];
  });
}

/** What a plugin asks for and why, on the review dialog and the Installation page. */
export const CapabilityList: React.FC<{
  capabilities: ReviewCapability[];
  title?: string;
}> = ({ capabilities, title = 'What it can do' }) => (
  <Column>
    <h3>{title}</h3>
    <List>
      {capabilities.length === 0 && (
        <li>
          <p>No permissions required</p>
        </li>
      )}
      {capabilities.map(capability => (
        <li key={`${capability.kind}:${capability.title}`}>
          <CapabilityTitle center gap='0.5ch'>
            {iconFor(capability)} {LABELS[capability.title] ?? capability.title}
          </CapabilityTitle>
          <p>{capability.reason || 'No reason provided'}</p>
        </li>
      ))}
    </List>
  </Column>
);

const List = styled.ul`
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

const CapabilityTitle = styled(Row)`
  font-weight: bold;
  font-size: 0.9rem;
  color: ${p => p.theme.colors.textLight};
`;
