import type { ComponentProps, JSX, PropsWithChildren } from 'react';
import { styled } from 'styled-components';
import { Checkbox, CheckboxLabel } from '../forms/Checkbox';
import { Column } from '../Row';
import { extractTextFromChildren, useSettingVisible } from './SettingsSection';

type SettingCheckboxProps = ComponentProps<typeof Checkbox> & {
  /** Short explanation shown under the label. */
  hint?: string;
};

/** A labelled checkbox row for settings; the label is the children. Hides
 *  itself when a settings search doesn't match it. */
export function SettingCheckbox({
  children,
  hint,
  ...props
}: SettingCheckboxProps): JSX.Element | null {
  const visible = useSettingVisible(
    `${extractTextFromChildren(children)} ${hint ?? ''}`,
  );

  if (!visible) return null;

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

interface SettingFieldProps {
  label: string;
  /** Id of the input, so the label focuses it. */
  htmlFor?: string;
}

/** A labelled setting that is not a checkbox (buttons, a select, a picker).
 *  Hides itself when a settings search matches neither its label nor its text. */
export function SettingField({
  label,
  htmlFor,
  children,
}: PropsWithChildren<SettingFieldProps>): JSX.Element | null {
  const visible = useSettingVisible(
    `${label} ${extractTextFromChildren(children)}`,
  );

  if (!visible) return null;

  return (
    <Column gap='0.5rem'>
      <FieldLabel as={htmlFor ? 'label' : 'span'} htmlFor={htmlFor}>
        {label}
      </FieldLabel>
      {children}
    </Column>
  );
}

const Hint = styled.span`
  display: block;
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;

const FieldLabel = styled.span`
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;
