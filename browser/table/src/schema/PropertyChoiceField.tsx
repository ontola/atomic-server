import {
  useId,
  type ComponentType,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type PropsWithChildren,
} from 'react';

export interface PropertyChoice {
  value: string;
  label: string;
  disabled?: boolean;
  reason?: string;
}

type RadioProps = PropsWithChildren<InputHTMLAttributes<HTMLInputElement>>;

function DefaultRadio({ children, ...props }: RadioProps) {
  return (
    <label>
      <input {...props} />
      {children}
    </label>
  );
}

export interface PropertyChoiceFieldProps {
  label: string;
  value: string;
  options: readonly PropertyChoice[];
  onChange: (value: string) => void;
  mode?: 'radio' | 'select';
  disabled?: boolean;
  /** Preserve an existing unsupported binding; never substitute a default. */
  unknownLabel?: string;
  Radio?: ComponentType<RadioProps>;
  Group?: ComponentType<HTMLAttributes<HTMLDivElement>>;
}

/** Controlled schema choices, with storage-independent IDs and host styling.
 * Unknown/disabled values remain visible but cannot become new selections. */
export function PropertyChoiceField({
  label,
  value,
  options,
  onChange,
  mode = 'radio',
  disabled,
  unknownLabel,
  Radio = DefaultRadio,
  Group,
}: PropertyChoiceFieldProps) {
  const name = useId();
  const unknown = !options.some(option => option.value === value);

  const choose = (next: string) => {
    if (disabled || next === value) return;
    const option = options.find(candidate => candidate.value === next);
    if (option && !option.disabled) onChange(next);
  };

  if (mode === 'select')
    return (
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={event => choose(event.target.value)}
      >
        {unknown && (
          <option value={value} disabled>
            {unknownLabel ?? value}
          </option>
        )}
        {options.map(option => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            title={option.reason}
          >
            {option.label}
          </option>
        ))}
      </select>
    );
  const Container = Group ?? 'div';

  return (
    <Container role='radiogroup' aria-label={label} aria-disabled={disabled}>
      {unknown && (
        <Radio type='radio' name={name} value={value} checked disabled>
          {unknownLabel ?? value}
        </Radio>
      )}
      {options.map(option => (
        <Radio
          key={option.value}
          type='radio'
          name={name}
          value={option.value}
          checked={option.value === value}
          disabled={disabled || option.disabled}
          title={option.reason}
          onChange={() => choose(option.value)}
        >
          {option.label}
        </Radio>
      ))}
    </Container>
  );
}
