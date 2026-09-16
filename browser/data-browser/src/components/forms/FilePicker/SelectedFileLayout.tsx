import { PropsWithChildren } from 'react';
import { FaXmark } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { IconButton } from '../../IconButton/IconButton';
import { Row } from '../../Row';

interface SelectedFileLayoutProps {
  title: string;
  helperText?: string;
  disabled?: boolean;
  onClear: () => void;
}

export function SelectedFileLayout({
  title,
  helperText,
  disabled,
  children,
  onClear,
}: PropsWithChildren<SelectedFileLayoutProps>): React.JSX.Element {
  return (
    <Wrapper>
      <Row center>
        <Title>{title}</Title>
        {!disabled && (
          <IconButton title='clear' onClick={onClear}>
            <FaXmark />
          </IconButton>
        )}
      </Row>
      <PreviewWrapper>{children}</PreviewWrapper>
      {helperText && <Helper>{helperText}</Helper>}
    </Wrapper>
  );
}

const Title = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Wrapper = styled.div`
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  width: min(100%, 20rem);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const PreviewWrapper = styled.div`
  aspect-ratio: 1 / 1;
  width: 100%;
  display: grid;
  overflow: hidden;
  border-radius: var(--radius-md);
`;

const Helper = styled.p`
  color: var(--color-text-subtle);
  margin: 0;
`;
