import { useResource } from '@tomic/react';
import { Row } from '../../Row';
import { FaPencil } from 'react-icons/fa6';
import styled from 'styled-components';

interface ToolCallMessageProps {
  toolCall: {
    toolCallId: string;
    args: unknown;
  };
}

function isEditArgs(
  args: unknown,
): args is { property: string; subject: string } {
  return (
    typeof args === 'object' &&
    args !== null &&
    'property' in args &&
    'subject' in args
  );
}

const ClippedTitle = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 20ch;
`;

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

export const AtomicEditToolMessage = ({ toolCall }: ToolCallMessageProps) => {
  let propertyId: string | undefined = undefined;
  let subjectId: string | undefined = undefined;

  if (isEditArgs(toolCall.args)) {
    propertyId = toolCall.args.property;
    subjectId = toolCall.args.subject;
  }

  const property = useResource(propertyId);
  const resource = useResource(subjectId);

  if (!propertyId || !resource || !property) {
    return null;
  }

  return (
    <ToolUseMessage key={toolCall.toolCallId}>
      <Row center gap='0.7ch'>
        <FaPencil />
        Changing <ClippedTitle>{property.title}</ClippedTitle> on{' '}
        <ClippedTitle>{resource.title}</ClippedTitle>
      </Row>
    </ToolUseMessage>
  );
};
