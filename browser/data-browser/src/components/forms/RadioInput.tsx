import { styled } from 'styled-components';
import { transition } from '../../helpers/transition';

import type { JSX } from 'react';

interface RadioInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  disabled?: boolean;
}

export function RadioInput({
  children,
  disabled,
  ...props
}: React.PropsWithChildren<RadioInputProps>): JSX.Element {
  return (
    <Label aria-disabled={disabled}>
      <Input type='radio' {...props} disabled={disabled} />
      {children}
    </Label>
  );
}

const Label = styled.label`
  display: grid;
  grid-template-columns: 1em auto;
  gap: 0.5rem;
  line-height: 1;

  &:not([aria-disabled='true']) {
    cursor: pointer;
  }

  &[aria-disabled='true'] {
    color: var(--color-text-subtle);
  }

  &:focus-within {
    color: var(--color-accent);
  }

  transition: ${transition('color')};
`;

const Input = styled.input`
  display: grid;
  transform: translateY(-0.15em);
  place-items: center;
  appearance: none;
  margin: 0;
  width: 1.15em;
  background-color: var(--color-bg);
  border: solid 1px var(--color-border);
  border-radius: 50%;
  aspect-ratio: 1/1;
  transition: ${transition('border-color')};

  &:not(:disabled):checked,
  &:not(:disabled):hover {
    border-color: var(--color-accent);
  }

  &::before {
    content: '';
    background-color: var(--color-accent);
    width: 75%;
    aspect-ratio: 1/1;
    border-radius: 50%;
    transform: scale(0);
    transition: ${transition('transform')};
  }

  &:disabled::before {
    background-color: var(--color-border);
  }

  &:checked::before {
    transform: scale(1);
  }

  &:not(:disabled) {
    cursor: pointer;
  }

  &:focus {
    outline-color: var(--color-accent);
  }
`;

export const RadioGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;
