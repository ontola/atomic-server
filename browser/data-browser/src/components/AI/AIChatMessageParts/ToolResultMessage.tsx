import type { CoreToolMessage, ToolResultPart } from 'ai';
import { Details } from '../../Details';
import { ResourceInline } from '../../../views/ResourceInline';
import { styled } from 'styled-components';
import { TOOL_NAMES } from '../useAtomicTools';

interface ToolResultMessageProps {
  message: CoreToolMessage;
}

export const ToolResultMessage: React.FC<ToolResultMessageProps> = ({
  message,
}) => {
  return message.content.map(c => {
    const key = `result-${c.toolCallId}`;

    if (c.toolName === TOOL_NAMES.SEARCH_RESOURCE) {
      return <SearchResultMessage toolResultPart={c} key={key} />;
    }

    let result;

    if (typeof c.result === 'string') {
      result = c.result;
    } else {
      result = JSON.stringify(c.result, null, 2);
    }

    return (
      <div key={key}>
        <Details title='Result'>
          <StyledPre>
            <code>{result}</code>
          </StyledPre>
        </Details>
      </div>
    );
  });
};

interface ToolResultPartProps {
  toolResultPart: ToolResultPart;
}

const SearchResultMessage = ({ toolResultPart }: ToolResultPartProps) => {
  const subjects = Object.keys(
    toolResultPart.result as Record<string, unknown>,
  );

  return (
    <div>
      <Details title='Search Results'>
        <ol>
          {subjects.map(resource => (
            <li key={resource}>
              <ResourceInline subject={resource} />
            </li>
          ))}
        </ol>
      </Details>
    </div>
  );
};

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
