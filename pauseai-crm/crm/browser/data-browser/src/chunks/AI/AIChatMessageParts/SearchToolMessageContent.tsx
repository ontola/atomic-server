import { FaMagnifyingGlass } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { Column, Row } from '@components/Row';

type SemanticSearchResultItem = {
  subject?: string;
  title: string;
  chunk: string;
};

function parseSemanticSearchOutput(
  output: unknown,
): SemanticSearchResultItem[] | null {
  if (!Array.isArray(output)) {
    return null;
  }

  const items: SemanticSearchResultItem[] = [];

  for (const entry of output) {
    if (typeof entry !== 'object' || entry === null) {
      return null;
    }

    const { subject, title, chunk } = entry as Record<string, unknown>;

    if (typeof title !== 'string' || typeof chunk !== 'string') {
      return null;
    }

    items.push({
      title,
      chunk,
      ...(typeof subject === 'string' ? { subject } : {}),
    });
  }

  return items;
}

export function SearchToolMessageContent({
  output,
  query,
}: {
  output: unknown;
  query?: string;
}) {
  const parsed = parseSemanticSearchOutput(output);

  const queryBlock =
    typeof query === 'string' && query !== '' ? (
      <QueryLine gap='0.5ch' align='flex-start'>
        <QueryIcon aria-hidden>
          <FaMagnifyingGlass />
        </QueryIcon>
        <QueryText>{query}</QueryText>
      </QueryLine>
    ) : null;

  if (parsed === null) {
    return (
      <Outer>
        {queryBlock}
        <FallbackPre>{JSON.stringify(output, null, 2)}</FallbackPre>
      </Outer>
    );
  }

  if (parsed.length === 0) {
    return (
      <Outer>
        {queryBlock}
        <EmptyHint>No matching results.</EmptyHint>
      </Outer>
    );
  }

  return (
    <Outer>
      {queryBlock}
      <Column role='list'>
        {parsed.map((item, i) => (
          <ListItem key={item.subject ?? i} role='listitem'>
            <ResultTitle>{item.title}</ResultTitle>
            <ResultChunk>{item.chunk}</ResultChunk>
          </ListItem>
        ))}
      </Column>
    </Outer>
  );
}

const Outer = styled(Column)`
  padding: ${p => p.theme.size()};
  background-color: ${p => p.theme.colors.bg};
  border-radius: ${p => p.theme.radius};
  max-width: 100%;
`;

const QueryLine = styled(Row)`
  font-size: 0.8em;
  line-height: 1.45;
  color: ${p => p.theme.colors.textLight};
  padding-bottom: ${p => p.theme.size()};
  margin-bottom: 2px;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  width: 100%;
`;

/**
 * One line tall (`1lh`) so the glyph sits in the vertical center of the first line.
 * With `align-items: flex-start` on the row, wrapped lines stay left of the icon column
 * without pulling the icon to the vertical middle of the block.
 */
const QueryIcon = styled.span`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1lh;
  min-height: 1em;

  & svg {
    width: 1em;
    height: 1em;
    flex-shrink: 0;
    display: block;
  }
`;

const QueryText = styled.span`
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: inherit;
`;

const ListItem = styled(Column)`
  gap: 0.35em;
  padding-bottom: ${p => p.theme.size()};
  border-bottom: 1px solid ${p => p.theme.colors.bg2};

  &:last-child {
    padding-bottom: 0;
    border-bottom: none;
  }
`;

const ResultTitle = styled.div`
  font-weight: 600;
  font-size: 0.85em;
  color: ${p => p.theme.colors.text};
`;

const ResultChunk = styled.div`
  font-size: 0.75em;
  color: ${p => p.theme.colors.textLight};
  white-space: pre-wrap;
  word-break: break-word;
`;

const EmptyHint = styled.div`
  padding: ${p => p.theme.size()};
  font-size: 0.75em;
  color: ${p => p.theme.colors.textLight};
`;

const FallbackPre = styled.pre`
  background-color: ${p => p.theme.colors.bg};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
  overflow-x: auto;
  code {
    font-family: Monaco, monospace;
    font-size: 0.8em;
  }
`;
