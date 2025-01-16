import { styled } from 'styled-components';

import type { JSX } from 'react';
import { transition } from '../../helpers/transition';

interface CheckboxProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'type' | 'onChange'
  > {
  checked?: boolean;
  selected?: boolean;
  onChange: (value: boolean) => void;
}

export function Checkbox({
  checked,
  selected,
  onChange,
  ...props
}: CheckboxProps): JSX.Element {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.checked);
  };

  return (
    <InputCheckBox
      data-selected={selected}
      type='checkbox'
      checked={checked}
      onChange={handleChange}
      {...props}
    />
  );
}

const InputCheckBox = styled.input`
  --inset: 1px;
  --size: calc(100% - (var(--inset) * 2));

  background-color: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.theme.colors.bg2};
  width: 1rem;
  height: 1rem;
  border-radius: 3px;
  cursor: pointer;
  position: relative;
  appearance: none;

  &::before {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border-radius: 2px;
    background-color: ${p => p.theme.colors.bg};
    ${transition('opacity', 'background-color')}
  }

  &::after {
    --inset: 3px;
    --size: calc(100% - (var(--inset) * 2));
    position: absolute;
    inset: var(--inset);
    width: var(--size);
    height: var(--size);
    background-color: ${p => p.theme.colors.bg};
    clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
  }

  &:checked {
    border: none;

    &::before {
      background-color: ${p => p.theme.colors.main};
      content: '';
    }

    &::after {
      content: '';
    }
  }

  &:focus-visible,
  &:hover,
  &[data-selected='true'] {
    &:not(:checked)::before {
      background-color: ${p => p.theme.colors.main};
      content: '';
      opacity: ${p => (p.theme.darkMode ? 0.5 : 0.2)};
    }
    &:not(:checked)::after {
      content: '';
    }
  }
`;

export const CheckboxLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  justify-content: flex-start;
  user-select: none;
`;
