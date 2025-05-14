import Markdown from '../../datatypes/Markdown';
import styled from 'styled-components';

const MessageWrapper = styled.div`
  border-radius: ${p => p.theme.radius};
  width: 90%;
  padding-block: ${p => p.theme.size()};
`;

export const BasicMessage = ({ text }: { text: string }) => {
  return (
    <MessageWrapper>
      <Markdown text={text} maxLength={Infinity} />
    </MessageWrapper>
  );
};
