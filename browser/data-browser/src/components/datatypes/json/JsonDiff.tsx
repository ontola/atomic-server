import { diffJson, Change } from 'diff';
import styled from 'styled-components';
import { HighlightedCodeBlock } from '../../HighlightedCodeBlock';

interface JsonDiffProps {
  oldValue: unknown;
  newValue: unknown;
  className?: string;
}

export const JsonDiff = ({ oldValue, newValue, className }: JsonDiffProps) => {
  const changes = diffJson(
    oldValue as string | object,
    newValue as string | object,
  );

  const diffText = changes
    .map((change: Change) => {
      const prefix = change.added ? '+' : change.removed ? '-' : ' ';

      return change.value
        .split('\n')
        .filter((line, i, arr) => line.length > 0 || i < arr.length - 1)
        .map(line => prefix + line)
        .join('\n');
    })
    .join('\n');

  return (
    <StyledHighlightedCodeBlock
      className={className}
      code={diffText}
      language='diff-json'
    />
  );
};

const StyledHighlightedCodeBlock = styled(HighlightedCodeBlock)`
  width: 100%;
  background-color: ${p => p.theme.colors.bgBody};
  max-height: 40rem;

  pre {
    background-color: ${p => p.theme.colors.bgBody} !important;
  }
`;
