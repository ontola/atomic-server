import type { ComponentType, InputHTMLAttributes, ReactNode } from 'react';
import { styled } from 'styled-components';
import type { RowActionKind, TableRowActionKind } from './rowActionTypes.js';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import { tableTheme } from './theme.js';

export type {
  TableRowActionKind,
  TableRowActionTarget,
} from './rowActionTypes.js';

export interface TableRowActionFieldsProps {
  kinds: readonly TableRowActionKind[];
  kind: RowActionKind;
  property: string;
  label: string;
  value: string;
  values: readonly { key: string; option: ReactNode }[];
  onKindChange: (kind: RowActionKind) => void;
  onPropertyChange: (property: string) => void;
  onValueChange: (value: string) => void;
  onLabelChange: (label: string) => void;
  Input?: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  messages?: Partial<{
    kind: string;
    property: string;
    pickProperty: string;
    pickOption: string;
    label: string;
    noTargets: string;
  }>;
}
/** Existing action fields; the host retains draft state, initialization and save policy. */
export function TableRowActionFields({
  kinds,
  kind,
  property,
  label,
  value,
  values,
  onKindChange,
  onPropertyChange,
  onValueChange,
  onLabelChange,
  Input = DefaultInput,
  messages,
}: TableRowActionFieldsProps) {
  const id = 'row-action';
  const action = kinds.find(candidate => candidate.kind === kind);
  const target = { values };
  const numeric = action?.valueField?.input === 'number';
  const text = {
    kind: 'Does what',
    property: 'To column',
    pickProperty: 'Pick a column…',
    pickOption: 'Pick an option…',
    label: 'Button says',
    noTargets: 'This table has no column of the right kind for that yet.',
    ...messages,
  };

  return (
    <Fields>
      <Field>
        <label htmlFor={`${id}-kind`}>{text.kind}</label>
        <Select
          id={`${id}-kind`}
          data-testid='action-config-kind'
          value={kind}
          onChange={event => onKindChange(event.target.value as RowActionKind)}
        >
          {kinds.map(option => (
            <option key={option.kind} value={option.kind}>
              {option.title}
            </option>
          ))}
        </Select>
        <Hint>{action?.description}</Hint>
      </Field>
      <Field>
        <label htmlFor={`${id}-property`}>{text.property}</label>
        <Select
          id={`${id}-property`}
          data-testid='action-config-property'
          value={property}
          onChange={event => onPropertyChange(event.target.value)}
        >
          <option value=''>{text.pickProperty}</option>
          {action?.targets.map(candidate => candidate.option)}
        </Select>
        {!action?.targets.length && <Hint>{text.noTargets}</Hint>}
      </Field>
      {action?.valueField && (
        <Field>
          <label htmlFor={`${id}-value`}>{action.valueField.label}</label>
          {target?.values?.length ? (
            <Select
              id={`${id}-value`}
              data-testid='action-config-value'
              value={value}
              onChange={event => onValueChange(event.target.value)}
            >
              <option value=''>{text.pickOption}</option>
              {target.values.map(option => option.option)}
            </Select>
          ) : (
            <Input
              id={`${id}-value`}
              data-testid='action-config-value'
              type={numeric ? 'number' : 'text'}
              value={value}
              onChange={event => onValueChange(event.target.value)}
            />
          )}
        </Field>
      )}
      <Field>
        <label htmlFor={`${id}-label`}>{text.label}</label>
        <Input
          id={`${id}-label`}
          data-testid='action-config-label'
          value={label}
          placeholder={action?.defaultLabel}
          onChange={event => onLabelChange(event.target.value)}
        />
      </Field>
    </Fields>
  );
}

const Fields = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => tableTheme(p.theme).size(2)};
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => tableTheme(p.theme).size(1)};

  label {
    font-size: 0.85rem;
    color: ${p => tableTheme(p.theme).colors.textLight};
  }
`;

const Hint = styled.span`
  font-size: 0.8rem;
  color: ${p => tableTheme(p.theme).colors.textLight};
`;

const Select = styled.select`
  padding: 0.4rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  background-color: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
`;

function DefaultInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <InputWrapper>
      <InputStyled {...props} />
    </InputWrapper>
  );
}
