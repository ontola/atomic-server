import Markdown from '../../datatypes/Markdown';
import styled from 'styled-components';
import { Details } from '../../Details';

const ReasoningMessageWrapper = styled.div`
  padding: ${p => p.theme.size()};
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
  border-radius: ${p => p.theme.radius};
  width: 90%;
`;

export const ReasoningMessage = ({
  text,
  state,
}: {
  text: string;
  state?: 'streaming' | 'done';
}) => {
  if (state === 'streaming') {
    return (
      <ReasoningMessageWrapper>
        <span>Thinking...</span>
        <Markdown text={text} maxLength={Infinity} />
      </ReasoningMessageWrapper>
    );
  }

  return (
    <Details title={<Title>Thinking</Title>}>
      <ReasoningMessageWrapper>
        <Markdown text={text} maxLength={Infinity} />
      </ReasoningMessageWrapper>
    </Details>
  );
};

const Title = styled.span`
  font-size: 0.8em;
`;
