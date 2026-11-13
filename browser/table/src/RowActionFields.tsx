import {
  useEffect,
  useEffectEvent,
  useId,
  useState,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import type { RowActionKind, RowActionSpec } from './views/configuration.js';
import { tableTheme } from './theme.js';

export interface TableRowActionTarget {
  key: string;
  option: ReactNode;
  values?: readonly { key: string; option: ReactNode }[];
}
export interface TableRowActionKind {
  kind: RowActionKind;
  title: string;
  description: string;
  defaultLabel: string;
  valueField?: { label: string; input: 'number' | 'select' | 'text' };
  targets: readonly TableRowActionTarget[];
}
export interface TableRowActionFieldsProps {
  initial?: RowActionSpec;
  kinds: readonly TableRowActionKind[];
  disabled?: boolean;
  onChange: (draft: RowActionSpec, valid: boolean) => void;
  Input?: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  messages?: Partial<{
    kind: string;
    property: string;
    pickProperty: string;
    pickOption: string;
    label: string;
    noTargets: string;
    invalidNumber: string;
  }>;
}
/** Actual action form, including target/literal resets and raw numeric validation.
 * Metadata adapters provide compatible targets and subscribed option labels. */
export function TableRowActionFields({
  initial,
  kinds,
  disabled,
  onChange,
  Input = DefaultInput,
  messages,
}: TableRowActionFieldsProps) {
  const id = useId();
  const [actionId] = useState(initial?.id ?? '');
  const [kind, setKind] = useState<RowActionKind>(
    initial?.kind ?? kinds[0]?.kind ?? 'setNow',
  );
  const [property, setProperty] = useState(initial?.property ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [value, setValue] = useState(
    initial?.value === undefined ? '' : String(initial.value),
  );
  const action = kinds.find(candidate => candidate.kind === kind);
  const target = action?.targets.find(candidate => candidate.key === property);
  const numeric = action?.valueField?.input === 'number';
  const numericValid =
    !numeric ||
    (!!value.trim() &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) &&
      Number.isFinite(Number(value)));
  const draft: RowActionSpec = {
    id: actionId,
    kind,
    property,
    label: label || action?.defaultLabel || '',
    ...(action?.valueField
      ? { value: numeric && numericValid ? Number(value) : value }
      : {}),
  };
  const valid =
    !disabled &&
    !!target &&
    !!draft.label.trim() &&
    numericValid &&
    (!action?.valueField || value !== '') &&
    (!target.values?.length ||
      target.values.some(option => option.key === value));
  const draftKey = JSON.stringify(draft);
  const notify = useEffectEvent(() => onChange(draft, valid));
  useEffect(() => {
    notify();
  }, [draftKey, valid]);
  const text = {
    kind: 'Does what',
    property: 'To column',
    pickProperty: 'Pick a column…',
    pickOption: 'Pick an option…',
    label: 'Button says',
    noTargets: 'This table has no column of the right kind for that yet.',
    invalidNumber: 'Enter a finite number.',
    ...messages,
  };

  return (
    <Fields disabled={disabled}>
      <Field>
        <label htmlFor={`${id}-kind`}>{text.kind}</label>
        <Select
          id={`${id}-kind`}
          data-testid='action-config-kind'
          value={kind}
          onChange={event => {
            setKind(event.target.value as RowActionKind);
            setProperty('');
            setValue('');
          }}
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
          onChange={event => {
            setProperty(event.target.value);
            setValue('');
          }}
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
              onChange={event => setValue(event.target.value)}
            >
              <option value=''>{text.pickOption}</option>
              {target.values.map(option => option.option)}
            </Select>
          ) : (
            <Input
              id={`${id}-value`}
              data-testid='action-config-value'
              type='text'
              inputMode={numeric ? 'decimal' : undefined}
              value={value}
              aria-invalid={!numericValid}
              onChange={event => setValue(event.target.value)}
            />
          )}
          {!numericValid && <Hint role='alert'>{text.invalidNumber}</Hint>}
        </Field>
      )}
      <Field>
        <label htmlFor={`${id}-label`}>{text.label}</label>
        <Input
          id={`${id}-label`}
          data-testid='action-config-label'
          value={label}
          placeholder={action?.defaultLabel}
          onChange={event => setLabel(event.target.value)}
        />
      </Field>
    </Fields>
  );
}

const Fields = styled.fieldset`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 0;
  margin: 0;
  border: none;
`;
const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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
  background: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
`;
const DefaultInput = styled.input`
  padding: 0.4rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  background: ${p => tableTheme(p.theme).colors.bg};
  color: ${p => tableTheme(p.theme).colors.text};
`;
