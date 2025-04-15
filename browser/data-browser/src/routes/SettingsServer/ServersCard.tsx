import { Card, CardInsideFull, CardRow } from '../../components/Card';
import { styled } from 'styled-components';
import { useSettings } from '../../helpers/AppSettings';
import { DriveRow } from './DriveRow';

import type { JSX } from 'react';

export interface ServerCardProps {
  servers: string[];
  onServerSelect: (server: string) => void;
  onServerRemove: (server: string) => void;
  disabled?: boolean;
}

export function ServersCard({
  servers,
  onServerSelect,
  onServerRemove,
  disabled,
}: ServerCardProps): JSX.Element {
  const { baseURL } = useSettings();

  if (servers.length === 0) {
    return <span>No known servers</span>;
  }

  return (
    <ContainerCard>
      <CardInsideFull>
        {servers.map((origin, i) => {
          return (
            <CardRow key={origin} noBorder={i === 0}>
              <DriveRow
                subject={origin}
                disabled={disabled || origin === baseURL}
                onRemove={disabled ? undefined : onServerRemove}
                onClick={onServerSelect}
              />
            </CardRow>
          );
        })}
      </CardInsideFull>
    </ContainerCard>
  );
}

const ContainerCard = styled(Card)`
  container-type: inline-size;
  padding-block: 0;
`;
