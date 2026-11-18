import type {
  ComponentType,
  InputHTMLAttributes,
  SelectHTMLAttributes,
  PropsWithChildren,
  ReactNode,
} from 'react';

export type TableFilterValueKind =
  | 'text'
  | 'number'
  | 'date'
  | 'boolean'
  | 'json'
  | 'reference';
export interface TableFilterValueInputProps {
  kind: TableFilterValueKind;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  choices?: readonly string[];
  Option?: ComponentType<{ value: string }>;
  referenceInput?: (
    state: Pick<TableFilterValueInputProps, 'value' | 'onChange' | 'autoFocus'>,
  ) => ReactNode;
  messages?: Partial<{
    any: string;
    true: string;
    false: string;
    pickOption: string;
    value: string;
  }>;
  Input?: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  Select?: ComponentType<SelectHTMLAttributes<HTMLSelectElement>>;
  Wrapper?: ComponentType<PropsWithChildren>;
}
const messages = {
  any: 'Any',
  true: 'True',
  false: 'False',
  pickOption: 'Pick an option…',
  value: 'Value…',
};

/** Existing datatype-aware query input. Preserve native numeric editing and
 * the original JSON/numeric normalization on blur. */
export function TableFilterValueInput({
  kind,
  value,
  onChange,
  autoFocus,
  choices,
  Option,
  referenceInput,
  messages: labels,
  Input,
  Select,
  Wrapper,
}: TableFilterValueInputProps) {
  const text = { ...messages, ...labels };
  const InputComponent = Input ?? 'input';
  const SelectComponent = Select ?? 'select';

  if (choices?.length)
    return (
      <SelectComponent
        value={value}
        autoFocus={autoFocus}
        onChange={event => onChange(event.target.value)}
      >
        <option value=''>{text.pickOption}</option>
        {choices.map(choice =>
          Option ? (
            <Option key={choice} value={choice} />
          ) : (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ),
        )}
      </SelectComponent>
    );
  if (kind === 'reference' && referenceInput)
    return <>{referenceInput({ value, onChange, autoFocus })}</>;
  if (kind === 'boolean')
    return (
      <SelectComponent
        value={value}
        autoFocus={autoFocus}
        onChange={event => onChange(event.target.value)}
      >
        <option value=''>{text.any}</option>
        <option value='true'>{text.true}</option>
        <option value='false'>{text.false}</option>
      </SelectComponent>
    );
  const input = (
    <InputComponent
      type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'}
      value={value}
      autoFocus={autoFocus}
      placeholder={text.value}
      onChange={event => onChange(event.target.value)}
      onBlur={() => {
        if (value === '') return;

        if (kind === 'json') {
          const canonical = canonicalTableFilterJson(value);
          if (canonical !== undefined && canonical !== value)
            onChange(canonical);
        }

        if (kind === 'number') {
          const number = Number(value);
          if (Number.isFinite(number) && String(number) !== value)
            onChange(String(number));
        }
      }}
    />
  );

  return Wrapper ? <Wrapper>{input}</Wrapper> : input;
}

/** Canonical query JSON retains incomplete text and sorts object keys at every
 * level. It does not alter array ordering or write a stored row value. */
export function canonicalTableFilterJson(text: string): string | undefined {
  try {
    return JSON.stringify(sortKeys(JSON.parse(text)));
  } catch {
    return undefined;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, inner]) => [key, sortKeys(inner)]),
    );

  return value;
}
