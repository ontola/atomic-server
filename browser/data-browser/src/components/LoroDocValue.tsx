import { styled } from 'styled-components';
import { FaEye } from 'react-icons/fa6';
import { Button } from './Button';
import { useState } from 'react';
import { CodeBlock } from './CodeBlock';
import { Column } from './Row';

interface LoroDocValueProps {
  value: Uint8Array | undefined;
}

export const LoroDocValue: React.FC<LoroDocValueProps> = ({ value }) => {
  const [showState, setShowState] = useState(false);

  if (!value) {
    return <span>Empty</span>;
  }

  return (
    <Column gap='0px' fullHeight justify='center'>
      <SubtleButton clean onClick={() => setShowState(!showState)}>
        <FaEye />
        {showState ? 'Hide encoded state' : 'Show encoded state'}
      </SubtleButton>
      {showState && (
        <CodeBlock
          wordWrap
          content={`Loro document (${value.byteLength} bytes)`}
        />
      )}
    </Column>
  );
};

const SubtleButton = styled(Button)`
  color: ${p => p.theme.colors.textLight};
  display: flex;
  align-items: center;
  gap: 0.5rem;
  &:hover,
  &:focus-visible {
    color: ${p => p.theme.colors.main};
  }
`;
