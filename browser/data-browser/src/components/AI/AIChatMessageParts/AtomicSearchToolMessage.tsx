import { Row } from '../../Row';
import { FaMagnifyingGlass } from 'react-icons/fa6';
import styled from 'styled-components';

interface ToolCallMessageProps {
  toolCall: {
    toolCallId: string;
    args: unknown;
  };
}

function isSearchArgs(args: unknown): args is { query: string } {
  return (
    typeof args === 'object' &&
    args !== null &&
    'query' in args &&
    typeof (args as { query?: unknown }).query === 'string'
  );
}

const ToolUseMessage = styled.div`
  background-color: ${p => p.theme.colors.mainSelectedBg};
  padding: ${p => p.theme.size(2)};
  border-radius: ${p => p.theme.radius};
  font-size: 0.7rem;
  width: fit-content;
  span {
    color: ${p => p.theme.colors.textLight};
  }
`;

export const AtomicSearchToolMessage = ({ toolCall }: ToolCallMessageProps) => {
  const query = isSearchArgs(toolCall.args) ? toolCall.args.query : '';

  return (
    <ToolUseMessage>
      <Row center gap='1ch'>
        <FaMagnifyingGlass />
        <div>
          Searching for <span>{query}</span>
        </div>
      </Row>
    </ToolUseMessage>
  );
};
