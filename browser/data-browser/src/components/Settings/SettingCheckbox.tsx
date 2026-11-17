import type { ComponentProps, JSX } from 'react';
import { styled } from 'styled-components';
import { Checkbox, CheckboxLabel } from '../forms/Checkbox';

type SettingCheckboxProps = ComponentProps<typeof Checkbox> & {
  /** Short explanation shown under the label. */
  hint?: string;
};

/** A labelled checkbox row for settings; the label is the children. */
export function SettingCheckbox({
  children,
  hint,
  ...props
}: SettingCheckboxProps): JSX.Element {
  return (
    <CheckboxLabel>
      <Checkbox {...props} />
      <span>
        {children}
        {hint && <Hint>{hint}</Hint>}
      </span>
    </CheckboxLabel>
  );
}

const Hint = styled.span`
  display: block;
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;
