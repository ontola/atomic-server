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
  name?: string;
  value: string | undefined;
  options: readonly PropertyChoice[];
  onChange: (value: string) => void;
  Radio?: ComponentType<RadioProps>;
  Group?: ComponentType<HTMLAttributes<HTMLDivElement>>;
}
/** Existing format-radio layout; data access and mutation remain with the host. */
export function PropertyChoiceField({
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
    <Container>
      {options.map(option => (
        <Radio
          key={option.value}
          type='radio'
          name={name}
          value={option.value}
          checked={option.value === value}
          onChange={event => onChange(event.target.value)}
        >
          {option.label}
        </Radio>
      ))}
    </Container>
  );
}
