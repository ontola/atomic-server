import * as React from 'react';
import styled from 'styled-components';
import { Row } from '@components/Row';
import { FaCheck, FaTriangleExclamation } from 'react-icons/fa6';

export interface ProviderStatusProps {
  connected: boolean;
  configured: boolean;
  checking?: boolean;
}

export const ProviderStatus: React.FC<ProviderStatusProps> = ({
  connected,
  configured,
  checking,
}) => {
  if (!configured) {
    return <Subtle>Not configured</Subtle>;
  }

  if (connected) {
    return (
      <Row center gap='1ch'>
        <FaCheck title='Connected' color={'var(--color-accent)'} />
        <Subtle>Connected</Subtle>
      </Row>
    );
  }

  if (checking) {
    return (
      <Row center gap='1ch'>
        <FaTriangleExclamation
          title='Checking server…'
          color={'var(--color-warning)'}
        />
        <Subtle>Checking server…</Subtle>
      </Row>
    );
  }

  return (
    <Row center gap='1ch'>
      <FaTriangleExclamation
        title='Not responding'
        color={'var(--color-warning)'}
      />
      <Subtle>Not responding</Subtle>
    </Row>
  );
};

export const Subtle = styled.div`
  font-size: 0.8rem;
  color: var(--color-text-subtle);
  margin: 0;
`;
