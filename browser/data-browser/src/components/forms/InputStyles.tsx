import { styled, css } from 'styled-components';

export const LabelStyled = styled.label`
  font-weight: bold;
  display: block;
`;

export interface InputWrapperProps {
  $invalid?: boolean;
  hasPrefix?: boolean;
}

/** A wrapper for inputs, for example when you want to add a button to some field */
export const InputWrapper = styled.div<InputWrapperProps>`
  display: flex;
  flex: 1;
  --border-color: ${({ $invalid }) =>
    $invalid ? 'var(--color-alert)' : 'var(--color-border)'};
  border: solid 1px var(--border-color);
  background-color: var(--color-bg);
  border-radius: var(--radius-md);
  overflow: hidden;
  align-items: center;
  padding-inline-start: ${p => (p.hasPrefix ? `var(--space-2)` : '0')};
  & svg {
    color: var(--color-text-subtle);
  }

  &:hover:has(input:not(:disabled)) {
    border-color: var(--color-accent);
  }
  &:focus-within {
    border: solid 1px var(--color-accent);
    background-color: var(--color-bg);
  }
`;

const inputStyle = css`
  height: 2rem;
  flex: 1;
  color: var(--color-text);
  font-size: 1em;
  padding: var(--space-2);
  border: none;
  --webkit-appearance: none;
  /* Remove iOS inner shadow */
  box-shadow: none;
  display: block;
  background-color: var(--color-bg);
  /* Invisible border, but useful because you need to set :focus styles with Input tags */
  border: solid 1px var(--color-bg);
  outline: none;
  box-sizing: border-box;
  /* If buttons are inside the input, the edges should be sharp */
  border-top-left-radius: var(--radius-md);
  border-bottom-left-radius: var(--radius-md);
  transition: border 100ms ease-in-out;

  &:disabled {
    background-color: var(--color-bg-subtle);
    border-color: var(--color-bg-subtle);
    color: var(--color-text-subtle);
  }

  &:last-child {
    border-radius: var(--radius-md);
  }
`;

export const InputStyled = styled.input`
  ${inputStyle}
`;

export const TextAreaStyled = styled.textarea`
  ${inputStyle}
  min-height: 5rem;
  height: unset;
`;

export const ErrMessage = styled.div`
  font-size: 0.8em;
  line-height: 1rem;
  color: var(--color-alert);
  margin-bottom: var(--space-3);
`;

export const InlineErrMessage = styled.span`
  font-size: 0.8em;
  line-height: 1rem;
  color: var(--color-alert);
`;

/** Wraps an inline resource, which is displayed on top of an input */
export const InputOverlay = styled.div`
  ${inputStyle}

  position: absolute;
  pointer-events: none !important;
  /* box-sizing: border-box; */
  border: transparent;
  line-height: 1rem;
  width: 100%;
  border-color: rgba(0, 0, 0, 0);
`;

export const Input: React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & InputWrapperProps
> = ({ $invalid, hasPrefix, ...props }) => (
  <InputWrapper $invalid={$invalid} hasPrefix={hasPrefix}>
    <InputStyled {...props} />
  </InputWrapper>
);
