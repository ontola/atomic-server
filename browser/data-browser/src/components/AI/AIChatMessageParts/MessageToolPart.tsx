import { getToolName, type ToolUIPart } from 'ai';
import { styled } from 'styled-components';
import { Row } from '../../Row';
import {
  FaAtom,
  FaBook,
  FaMagnifyingGlass,
  FaPencil,
  FaWrench,
} from 'react-icons/fa6';
import { Details } from '../../Details';
import { TOOL_NAMES } from '../useAtomicTools';
import { InlineFormattedResourceList } from '../../InlineFormattedResourceList';
import { useResource } from '@tomic/react';

interface ToolMessageProps {
  part: ToolUIPart;
}

export const MessageToolPart: React.FC<ToolMessageProps> = ({ part }) => {
  const toolName = getToolName(part);

  const Icon = getIcon(toolName);

  if (part.state === 'input-streaming' || part.state === 'input-available') {
    return (
      <ToolUseMessage>
        <Row center gap='0.5ch'>
          <Icon />
          <ToolTitle toolName={toolName} part={part} />
        </Row>
      </ToolUseMessage>
    );
  }

  if (part.state === 'output-available') {
    return (
      <Details
        title={
          <ToolUseMessage>
            <Row center gap='0.5ch'>
              <Icon />
              <ToolTitle toolName={toolName} part={part} />
            </Row>
          </ToolUseMessage>
        }
      >
        <StyledPre>{JSON.stringify(part.output, null, 2)}</StyledPre>
      </Details>
    );
  }

  return null;
};

const getIcon = (toolName: string) => {
  switch (toolName) {
    case TOOL_NAMES.SEARCH_RESOURCE:
      return FaMagnifyingGlass;
    case TOOL_NAMES.GET_ATOMIC_RESOURCE:
      return FaAtom;
    case TOOL_NAMES.GET_SCHEMA:
      return FaBook;
    case TOOL_NAMES.EDIT_ATOMIC_RESOURCE:
      return FaPencil;
    default:
      return FaWrench;
  }
};

const ToolTitle = ({
  toolName,
  part,
}: {
  toolName: string;
  part: ToolUIPart;
}) => {
  const args = part.input as unknown;

  if (toolName === TOOL_NAMES.SEARCH_RESOURCE && isSearchArgs(args)) {
    return <span>{args.query}</span>;
  }

  if (toolName === TOOL_NAMES.GET_ATOMIC_RESOURCE && isFetchArgs(args)) {
    return <FetchResourceTitle subjects={args.subjects} />;
  }

  if (toolName === TOOL_NAMES.EDIT_ATOMIC_RESOURCE && isEditArgs(args)) {
    return <EditTitle property={args.property} subject={args.subject} />;
  }

  return <span>{toolName}</span>;
};

const FetchResourceTitle = ({ subjects }: { subjects: string[] }) => {
  return (
    <span>
      Fetching{' '}
      <InlineFormattedResourceList
        subjects={subjects}
        RenderComp={ResourceTitle}
      />
    </span>
  );
};

const ResourceTitle = ({ subject }: { subject: string }) => {
  const resource = useResource(subject);

  return (
    <span>
      {resource.title.slice(0, 20)}
      {resource.title.length > 20 ? '...' : ''}
    </span>
  );
};

const EditTitle = ({
  property,
  subject,
}: {
  property: string;
  subject: string;
}) => {
  const resource = useResource(subject);
  const propertyResource = useResource(property);

  return (
    <span>
      Editing {propertyResource.title} on {resource.title}
    </span>
  );
};

function isSearchArgs(args: unknown): args is { query: string } {
  return typeof args === 'object' && args !== null && 'query' in args;
}

function isEditArgs(
  args: unknown,
): args is { subject: string; property: string; value: unknown } {
  return (
    typeof args === 'object' &&
    args !== null &&
    'subject' in args &&
    'property' in args &&
    'value' in args
  );
}

function isFetchArgs(args: unknown): args is { subjects: string[] } {
  return (
    typeof args === 'object' &&
    args !== null &&
    'subjects' in args &&
    Array.isArray((args as { subjects?: unknown }).subjects)
  );
}

const ToolUseMessage = styled.div`
  background-color: var(--mainSelectedBg);
  padding: 0.5em;
  border-radius: var(--radius);
  font-size: 0.7rem;
  width: fit-content;
  color: var(--textLight);
`;

const StyledPre = styled.pre`
  background-color: ${p => p.theme.colors.bg};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
  overflow-x: auto;
  code {
    font-family: Monaco, monospace;
    font-size: 0.8em;
  }
`;
