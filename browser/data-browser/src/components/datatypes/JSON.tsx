import type { JSONValue } from '@tomic/react';
import styled from 'styled-components';
import { HighlightedCodeBlock } from '../HighlightedCodeBlock';

export const JSON_RENDERER_CLASS = 'json-renderer';
interface JSONRendererProps {
  value: JSONValue;
}

export const JSONRenderer: React.FC<JSONRendererProps> = ({ value }) => {
  return (
    <StyledHighlightedCodeBlock
      className={JSON_RENDERER_CLASS}
      code={JSON.stringify(value, null, 2)}
    ></StyledHighlightedCodeBlock>
  );
};

const StyledHighlightedCodeBlock = styled(HighlightedCodeBlock)`
  width: calc(100cqw - var(--space-3));
  background-color: var(--color-bg-body);

  max-height: 40rem;
  pre {
    background-color: var(--color-bg-body) !important;
  }
`;
