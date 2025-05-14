import { useResources } from '@tomic/react';
import { Row } from '../../Row';
import styled from 'styled-components';

interface ToolCallMessageProps {
  toolCall: {
    toolCallId: string;
    args: unknown;
  };
}

function isFetchArgs(args: unknown): args is { subjects: string[] } {
  return (
    typeof args === 'object' &&
    args !== null &&
    'subjects' in args &&
    Array.isArray((args as { subjects?: unknown }).subjects)
  );
}

const SubtleToolUseMessage = styled.div`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.7rem;
  width: fit-content;
`;

export const AtomicFetchToolMessage = ({ toolCall }: ToolCallMessageProps) => {
  const subjects = isFetchArgs(toolCall.args) ? toolCall.args.subjects : [];
  const resources = useResources(subjects);

  return (
    <>
      {Array.from(resources.values()).map(resource => (
        <SubtleToolUseMessage key={toolCall.toolCallId}>
          <Row center gap='1ch'>
            Reading
            <span>
              {resource.title.slice(0, 20)}
              {resource.title.length > 20 ? '...' : ''}
            </span>
          </Row>
        </SubtleToolUseMessage>
      ))}
    </>
  );
};
