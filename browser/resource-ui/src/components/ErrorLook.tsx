import { resourceTheme } from '../theme.js';
import { lighten } from 'polished';
import { styled, css } from 'styled-components';

import { FaTriangleExclamation } from 'react-icons/fa6';

import { Suspense, type JSX } from 'react';
import { useOptionalResourceUIHost } from '../ResourceUIHost.js';
import { getMessageForErrorType } from '@tomic/react';

export const errorLookStyle = css`
  color: ${props => resourceTheme(props.theme).colors.alert};
  font-family: monospace;
  line-height: 1.2rem;
`;

export const ErrorLook = styled.span`
  ${errorLookStyle}
`;

export const SimpleErrorBlock = styled.div`
  color: ${props => resourceTheme(props.theme).colors.alert};
  border-radius: ${props => resourceTheme(props.theme).radius};
  border: 1px solid ${props => resourceTheme(props.theme).colors.alert};
  padding: ${props => resourceTheme(props.theme).size(2)};
`;

export interface ErrorBlockProps {
  error: Error;
  showTrace?: boolean;
  showReport?: boolean;
}

export function ErrorBlock({
  error,
  showTrace,
  showReport = true,
}: ErrorBlockProps): JSX.Element {
  const FeedbackButton = useOptionalResourceUIHost()?.FeedbackButton;

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
      {showReport && FeedbackButton && (
        <Suspense fallback={null}>
          <FeedbackButton reportError={error} />
        </Suspense>
      )}
    </ErrorLookBig>
  );
}

const ErrorLookBig = styled.div`
  color: ${p => resourceTheme(p.theme).colors.alert};
  font-size: 1rem;
  padding: ${p => resourceTheme(p.theme).margin}rem;
  border-radius: ${p => resourceTheme(p.theme).radius};
  border: 1px solid ${p => lighten(0.2, resourceTheme(p.theme).colors.alert)};
  background-color: ${p => resourceTheme(p.theme).colors.bg1};
`;

const Pre = styled.pre`
  white-space: pre-wrap;
  border-radius: ${p => resourceTheme(p.theme).radius};
  padding: ${p => resourceTheme(p.theme).margin}rem;
  background-color: ${p => resourceTheme(p.theme).colors.bg};
  font-size: 0.9rem;
`;

const BiggerText = styled.p`
  font-size: 1.3rem;
  display: flex;
  align-items: center;
  gap: 1ch;
`;
