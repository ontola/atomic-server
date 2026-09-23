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
  background-color: ${p =>
    p.disabled ? p.theme.colors.bg1 : p.theme.colors.bg};

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
    color: ${p => p.theme.colors.textLight};
  }
`;

const Select = styled.select`
  cursor: pointer;
  appearance: none;
  width: 100%;
  // Padding lives on the select itself, so the whole box, chevron included,
  // opens the dropdown.
  padding-inline: 0.5rem 1.5rem;
  border: none;
  outline: none;
  height: 2rem;
  background-color: transparent;
  color: ${p => p.theme.colors.text};
  &:disabled {
    color: ${props => props.theme.colors.textLight};
    background-color: transparent;
  }
`;
