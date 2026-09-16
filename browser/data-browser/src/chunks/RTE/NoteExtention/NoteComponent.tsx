import { Row } from '@components/Row';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import { FaCircleInfo } from 'react-icons/fa6';
import { styled } from 'styled-components';

export const NoteComponent = () => {
  return (
    <StyledNodeViewWrapper>
      <Title center contentEditable={false} gap='1ch'>
        <FaCircleInfo />
        Note
      </Title>
      <NodeViewContent />
    </StyledNodeViewWrapper>
  );
};

const StyledNodeViewWrapper = styled(NodeViewWrapper)`
  background-color: var(--color-accent-subtle);
  padding: 1rem;
  border-left: 3px solid var(--color-accent);
  width: 100%;
  margin-bottom: var(--space-3);
  clear: both;
  & p:last-child {
    margin-bottom: 0;
  }
`;

const Title = styled(Row)`
  font-weight: 600;
  font-size: 1.1rem;
  color: var(--color-accent-text);
  margin-bottom: var(--space-2);
`;
