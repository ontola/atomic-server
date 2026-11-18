import {
  type ComponentType,
  type InputHTMLAttributes,
  type PropsWithChildren,
} from 'react';
import { styled } from 'styled-components';
import { tableTheme } from '../theme.js';
import { RadioInput } from '@tomic/ui/components/forms/RadioInput';

export interface PropertyDateFormatOption {
  value: string;
  label: string;
  /** Prepared with the backend's locale/date formatter. */
  example: string;
}
type RadioProps = PropsWithChildren<InputHTMLAttributes<HTMLInputElement>>;

export interface PropertyDateFormatFieldProps {
  value?: string;
  options: readonly PropertyDateFormatOption[];
  onChange: (value: string) => void;
  Radio?: ComponentType<RadioProps>;
}

/** Actual date-format choices and previews. IDs and locale examples come from
 * metadata; preserve the existing radio choices and previews. */
export function PropertyDateFormatField({
  value,
  options,
  onChange,
  Radio = RadioInput,
}: PropertyDateFormatFieldProps) {
  const name = 'date-format';

  return (
    <Wrapper>
      {options.map(option => (
        <Option key={option.value}>
          <Radio
            type='radio'
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
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
`;
