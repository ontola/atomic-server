import Markdown from '@components/datatypes/Markdown';
import styled from 'styled-components';

const MessageWrapper = styled.div`
  border-radius: ${p => p.theme.radius};
  width: 100%;
  min-width: 0;

  /* Markdown paragraph spacing belongs between blocks, not after the reply. */
  & > div > :last-child {
    margin-bottom: 0;
  }
  padding-block: ${p => p.theme.size()};

  @media (max-width: 600px) {
    padding-block: 0.25rem;
  }
`;

export const BasicMessage = ({ text }: { text: string }) => {
  return (
    <MessageWrapper data-testid='ai-message-text'>
      <Markdown markExternalLinks text={text} maxLength={Infinity} />
    </MessageWrapper>
  );
};
