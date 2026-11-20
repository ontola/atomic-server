import { uiTheme } from '../../theme.js';
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
  --border-color: ${({ $invalid, theme }) =>
    $invalid ? uiTheme(theme).colors.alert : uiTheme(theme).colors.bg2};
  border: solid 1px var(--border-color);
  background-color: ${props => uiTheme(props.theme).colors.bg};
  border-radius: ${props => uiTheme(props.theme).radius};
  overflow: hidden;
  align-items: center;
  padding-inline-start: ${p =>
    p.hasPrefix ? `${uiTheme(p.theme).margin / 2}rem` : '0'};
  & svg {
    color: ${p => uiTheme(p.theme).colors.textLight};
  }

  &:hover:has(input:not(:disabled)) {
    border-color: ${props => uiTheme(props.theme).colors.main};
  }
  &:focus-within {
    border: solid 1px ${props => uiTheme(props.theme).colors.main};
    background-color: ${props => uiTheme(props.theme).colors.bg};
  }
`;

const inputStyle = css`
  height: 2rem;
  flex: 1;
  color: ${props => uiTheme(props.theme).colors.text};
  font-size: 1em;
  padding: ${props => uiTheme(props.theme).margin / 2}rem;
  border: none;
  --webkit-appearance: none;
  /* Remove iOS inner shadow */
  box-shadow: none;
  display: block;
  background-color: ${props => uiTheme(props.theme).colors.bg};
  /* Invisible border, but useful because you need to set :focus styles with Input tags */
  border: solid 1px ${props => uiTheme(props.theme).colors.bg};
  outline: none;
  box-sizing: border-box;
  /* If buttons are inside the input, the edges should be sharp */
  border-top-left-radius: ${props => uiTheme(props.theme).radius};
  border-bottom-left-radius: ${props => uiTheme(props.theme).radius};
  transition: border 100ms ease-in-out;

  &:disabled {
    background-color: ${props => uiTheme(props.theme).colors.bg1};
    border-color: ${props => uiTheme(props.theme).colors.bg1};
    color: ${props => uiTheme(props.theme).colors.textLight};
  }

  &:last-child {
    border-radius: ${props => uiTheme(props.theme).radius};
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
  color: ${props => uiTheme(props.theme).colors.alert};
  margin-bottom: ${p => uiTheme(p.theme).margin}rem;
`;

export const InlineErrMessage = styled.span`
  font-size: 0.8em;
  line-height: 1rem;
  color: ${props => uiTheme(props.theme).colors.alert};
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
