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
  name?: string;
  value: string | undefined;
  options: readonly PropertyChoice[];
  onChange: (value: string) => void;
  Radio?: ComponentType<RadioProps>;
  Group?: ComponentType<HTMLAttributes<HTMLDivElement>>;
}
/** Existing format-radio layout; data access and mutation remain with the host. */
export function PropertyChoiceField({
  label,
  name: suppliedName,
  value,
  options,
  onChange,
  Radio = DefaultRadio,
  Group,
}: PropertyChoiceFieldProps) {
  const generatedName = useId();
  const name = suppliedName ?? generatedName;
  const Container = Group ?? 'div';

  return (
    <Container role='radiogroup' aria-label={label}>
      {options.map(option => (
        <Radio
          key={option.value}
          type='radio'
          name={name}
          value={option.value}
          checked={option.value === value}
          onChange={() => onChange(option.value)}
        >
          {option.label}
        </Radio>
      ))}
    </Container>
  );
}
