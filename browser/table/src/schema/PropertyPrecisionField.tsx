import { InputStyled } from '@tomic/ui/components/forms/InputStyles';
import {
  useId,
  type ChangeEventHandler,
  type ComponentType,
  type FocusEventHandler,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from 'react';

type PrecisionInputProps = InputHTMLAttributes<HTMLInputElement> & {
  $invalid?: boolean;
};

export interface PropertyPrecisionFieldProps {
  value?: number;
  label: string;
  error?: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  Input?: ComponentType<PrecisionInputProps>;
  Heading?: ComponentType<{ htmlFor: string; children: ReactNode }>;
  Error?: ComponentType<PropsWithChildren>;
}

function DefaultInput({ $invalid: _, ...props }: PrecisionInputProps) {
  return <InputStyled {...props} />;
}

/** Existing precision field layout; the host retains parsing, validation and datatype policy. */
export function PropertyPrecisionField({
  value,
  label,
  error,
  onChange,
  onBlur,
  Input = DefaultInput,
  Heading,
  Error,
}: PropertyPrecisionFieldProps) {
  const id = useId();
  const Title = Heading ?? 'label';
  const ErrorMessage = Error ?? 'span';

  return (
    <>
      <Title htmlFor={id}>{label}</Title>
      <div>
        <Input
          id={id}
          type='number'
          defaultValue={value}
          min={0}
          max={20}
          $invalid={error !== undefined}
          onBlur={onBlur}
          onChange={onChange}
        />
        {error && <ErrorMessage>{error}</ErrorMessage>}
      </div>
    </>
  );
}
