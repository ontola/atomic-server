import { NodeViewWrapper } from '@tiptap/react';
import { styled } from 'styled-components';
import styles from './ResourceNode.module.css';

const stopPropagation = (e: React.MouseEvent<HTMLDivElement>) =>
  e.stopPropagation();

interface RTENodeViewWrapperProps {
  wide?: boolean;
}

export const RTENodeViewWrapper: React.FC<
  React.PropsWithChildren<RTENodeViewWrapperProps>
> = ({ children, wide = false }) => {
  return (
    <StyledNodeViewWrapper
      onClick={stopPropagation}
      onMouseDown={stopPropagation}
      className={wide ? styles.wideNode : ''}
      contentEditable={false}
    >
      {children}
    </StyledNodeViewWrapper>
  );
};

const StyledNodeViewWrapper = styled(NodeViewWrapper)`
  margin-bottom: 1rem;
`;
