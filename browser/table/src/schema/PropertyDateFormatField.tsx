import {
  useId,
  type ComponentType,
  type InputHTMLAttributes,
  type PropsWithChildren,
} from 'react';
import { styled } from 'styled-components';
import { tableTheme } from '../theme.js';

export interface PropertyDateFormatOption {
  value: string;
  label: string;
  /** Prepared with the backend's locale/date formatter. */
  example: string;
  disabled?: boolean;
}
type RadioProps = PropsWithChildren<InputHTMLAttributes<HTMLInputElement>>;

export interface PropertyDateFormatFieldProps {
  value?: string;
  options: readonly PropertyDateFormatOption[];
  label?: string;
  unknownLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  Radio?: ComponentType<RadioProps>;
}

function DefaultRadio({ children, ...props }: RadioProps) {
  return (
    <label>
      <input {...props} />
      {children}
    </label>
  );
}

/** Actual date-format choices and previews. IDs and locale examples come from
 * metadata; unrecognized stored formats remain visible without substitution. */
export function PropertyDateFormatField({
  value,
  options,
  label = 'Date format',
  unknownLabel,
  disabled,
  onChange,
  Radio = DefaultRadio,
}: PropertyDateFormatFieldProps) {
  const name = useId();

  return (
    <Wrapper role='radiogroup' aria-label={label}>
      {value !== undefined &&
        !options.some(option => option.value === value) && (
          <Option>
            <Radio type='radio' name={name} value={value} checked disabled>
              {unknownLabel ?? value}
            </Radio>
          </Option>
        )}
      {options.map(option => (
        <Option key={option.value}>
          <Radio
            type='radio'
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled || option.disabled}
            onChange={() => {
              if (!disabled && !option.disabled && option.value !== value)
                onChange(option.value);
            }}
          >
            {option.label}
          </Radio>
          <Example>{option.example}</Example>
        </Option>
      ))}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
`;
const Option = styled.div`
  padding: ${p => tableTheme(p.theme).margin}rem;
  &:not(:last-child) {
    border-bottom: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  }
`;
const Example = styled.span`
  color: ${p => tableTheme(p.theme).colors.textLight};
  font-style: italic;
  margin-inline-start: 0.5rem;
`;
