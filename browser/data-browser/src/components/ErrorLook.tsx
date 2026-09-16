import { styled, css } from 'styled-components';

import { FaTriangleExclamation } from 'react-icons/fa6';

import type { JSX } from 'react';
import { getMessageForErrorType } from '@tomic/react';

export const errorLookStyle = css`
  color: var(--color-alert);
  font-family: monospace;
  line-height: 1.2rem;
`;

export const ErrorLook = styled.span`
  ${errorLookStyle}
`;

export const SimpleErrorBlock = styled.div`
  color: var(--color-alert);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-alert);
  padding: var(--space-2);
`;

export interface ErrorBlockProps {
  error: Error;
  showTrace?: boolean;
}

export function ErrorBlock({ error, showTrace }: ErrorBlockProps): JSX.Element {
  return (
    <ErrorLookBig>
      <BiggerText>
        <FaTriangleExclamation />
        {getMessageForErrorType(error)}
      </BiggerText>
      <Pre>
        <code>{error.message}</code>
        {showTrace && (
          <>
            <br />
            <br />
            <span>Stack trace:</span>
            <br />
            <code>{error.stack}</code>
          </>
        )}
      </Pre>
    </ErrorLookBig>
  );
}

const ErrorLookBig = styled.div`
  color: var(--color-alert);
  font-size: 1rem;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-alert-subtle);
  background-color: var(--color-bg-subtle);
`;

const Pre = styled.pre`
  white-space: pre-wrap;
  border-radius: var(--radius-md);
  padding: var(--space-3);
  background-color: var(--color-bg);
  font-size: 0.9rem;
`;

const BiggerText = styled.p`
  font-size: 1.3rem;
  display: flex;
  align-items: center;
  gap: 1ch;
`;
