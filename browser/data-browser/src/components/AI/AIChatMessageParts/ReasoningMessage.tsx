import Markdown from '../../datatypes/Markdown';
import styled from 'styled-components';

const ReasoningMessageWrapper = styled.div`
  padding: ${p => p.theme.size()};
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
  max-height: 10rem;
  overflow-y: auto;
  border-radius: ${p => p.theme.radius};
  width: 90%;
`;

export const ReasoningMessage = ({ text }: { text: string }) => (
  <ReasoningMessageWrapper>
    <span>Thinking...</span>
    <Markdown text={text} maxLength={Infinity} />
  </ReasoningMessageWrapper>
);
