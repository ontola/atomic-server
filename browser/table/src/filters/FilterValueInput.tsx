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
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  maxLength?: number;
  textType?: 'text' | 'search';
  /** Opt in to a backend's canonical numeric-string comparison policy. */
  normalizeNumbers?: boolean;
  choices?: readonly string[];
  Option?: ComponentType<{ value: string }>;
  referenceInput?: (
    state: Pick<
      TableFilterValueInputProps,
      'value' | 'onChange' | 'autoFocus' | 'disabled'
    >,
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

/** Controlled query-value UI. Values remain strings, including false/zero and
 * invalid drafts. Only the host's explicit canonicalization policy runs on blur;
 * backend parsing, type/range checks and query capabilities remain in adapters. */
export function TableFilterValueInput({
  kind,
  value,
  onChange,
  label = 'Filter value',
  placeholder,
  autoFocus,
  disabled,
  maxLength,
  textType = 'text',
  normalizeNumbers = false,
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

  const change = (next: string) => {
    if (!disabled) onChange(next);
  };

  if (choices?.length)
    return (
      <SelectComponent
        aria-label={label}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={event => change(event.target.value)}
      >
        <option value=''>{text.pickOption}</option>
        {value && !choices.includes(value) && (
          <option value={value} disabled>
            {value}
          </option>
        )}
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
    return (
      <>{referenceInput({ value, onChange: change, autoFocus, disabled })}</>
    );
  if (kind === 'boolean')
    return (
      <SelectComponent
        aria-label={label}
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={event => change(event.target.value)}
      >
        {value && !['true', 'false'].includes(value) && (
          <option value={value} disabled>
            {value}
          </option>
        )}
        <option value=''>{text.any}</option>
        <option value='true'>{text.true}</option>
        <option value='false'>{text.false}</option>
      </SelectComponent>
    );
  const input = (
    <InputComponent
      aria-label={label}
      type={kind === 'date' ? 'date' : textType}
      inputMode={kind === 'number' ? 'decimal' : undefined}
      value={value}
      disabled={disabled}
      autoFocus={autoFocus}
      maxLength={maxLength}
      placeholder={placeholder ?? text.value}
      onChange={event => change(event.target.value)}
      onBlur={() => {
        if (disabled || value === '') return;

        if (kind === 'json') {
          const canonical = canonicalTableFilterJson(value);
          if (canonical !== undefined && canonical !== value) change(canonical);
        }

        if (kind === 'number' && normalizeNumbers && value.trim() !== '') {
          const number = Number(value);
          if (Number.isFinite(number) && String(number) !== value)
            change(String(number));
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
