import type { Version } from '@tomic/react';

import { DateTime } from '../../components/datatypes/DateTime';
import { styled } from 'styled-components';
import { ButtonClean } from '../../components/Button';

export interface VersionButtonProps {
  version: Version;
  selected: boolean;
  onClick: () => void;
}

export function VersionButton({
  version,
  selected,
  onClick,
}: VersionButtonProps) {
  const key = `${version.peer}-${version.frontiers[0]?.counter ?? 0}`;

  return (
    <VersionRow
      selected={selected}
      key={key}
      onClick={onClick}
      data-testid='version-button'
    >
      <DateTime date={new Date(version.timestamp)} />
      {version.message && (
        <Message>{version.message}</Message>
      )}
    </VersionRow>
  );
}

const VersionRow = styled(ButtonClean)<{ selected: boolean }>`
  padding: 1rem;
  background-color: ${p => (p.selected ? p.theme.colors.main : 'transparent')};
  color: ${p => (p.selected ? 'white' : p.theme.colors.text)};
  border-radius: ${p => p.theme.radius};
  contain: paint;

  &:hover,
  &:focus-visible {
    background-color: ${p =>
      p.selected ? p.theme.colors.main : p.theme.colors.bg1};
  }
`;

const Message = styled.span`
  font-size: 0.85em;
  opacity: 0.7;
  display: block;
`;
