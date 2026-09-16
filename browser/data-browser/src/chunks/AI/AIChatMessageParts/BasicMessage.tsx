import Markdown from '@components/datatypes/Markdown';
import styled from 'styled-components';

const MessageWrapper = styled.div`
  border-radius: var(--radius-md);
  width: 90%;
  padding-block: var(--space-3);
`;

export const BasicMessage = ({ text }: { text: string }) => {
  return (
    <MessageWrapper>
      <Markdown markExternalLinks text={text} maxLength={Infinity} />
    </MessageWrapper>
  );
};
