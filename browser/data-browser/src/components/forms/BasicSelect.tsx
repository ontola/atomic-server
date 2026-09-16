import { styled } from 'styled-components';
import { InputWrapper } from './InputStyles';
import { FC, PropsWithChildren } from 'react';

type Props = React.SelectHTMLAttributes<HTMLSelectElement>;

export const BasicSelect: FC<PropsWithChildren<Props>> = ({
  children,
  className,
  ...props
}) => {
  return (
    <StyledInputWrapper className={className}>
      <SelectWrapper disabled={!!props.disabled}>
        <Select {...props}>{children}</Select>
      </SelectWrapper>
    </StyledInputWrapper>
  );
};

const StyledInputWrapper = styled(InputWrapper)`
  min-width: 15ch;
`;

const SelectWrapper = styled.span<{ disabled: boolean }>`
  width: 100%;
  padding-inline: 0.5rem;
  background-color: ${p =>
    p.disabled ? 'var(--color-bg-subtle)' : 'var(--color-bg)'};

  // Because we remove the appearance of the select for compatibility reasons, we have to add back the chevron.
  position: relative;
  &:after {
    content: '▾';
    position: absolute;
    display: flex;
    right: 0.5rem;
    top: 0;
    height: 100%;
    align-items: center;
    pointer-events: none;
    color: var(--color-text-subtle);
  }
`;

const Select = styled.select`
  cursor: pointer;
  appearance: none;
  width: 100%;
  border: none;
  outline: none;
  height: 2rem;
  background-color: transparent;
  color: var(--color-text);
  &:disabled {
    color: var(--color-text-subtle);
    background-color: transparent;
  }
`;
