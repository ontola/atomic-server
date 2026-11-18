import { Resource, useNumber } from '@tomic/react';
import {
  useCallback,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type JSX,
} from 'react';
import { ErrorChip } from '@components/forms/ErrorChip';
import { useValidation } from '@components/forms/formValidation/useValidation';
import { PropertyRangeField, validatePropertyRange } from '@tomic/table';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { Row } from '@components/Row';

interface TableRangeInputProps {
  resource: Resource;
  minProp: string;
  maxProp: string;
}

function RangeFieldInput({
  $invalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { $invalid?: boolean }) {
  return (
    <InputWrapper $invalid={$invalid}>
      <InputStyled {...props} />
    </InputWrapper>
  );
}

function RangeFieldContainer({ children }: PropsWithChildren) {
  return (
    <Row center gap='0.5rem'>
      {children}
    </Row>
  );
}

export function TableRangeInput({
  resource,
  minProp,
  maxProp,
}: TableRangeInputProps): JSX.Element {
  const [minLength, setMinLength] = useNumber(resource, minProp);
  const [maxLength, setMaxLength] = useNumber(resource, maxProp);

  const { error, setError, setTouched } = useValidation();

  const handleRangeChange = useCallback(
    (min: number | undefined, max: number | undefined) => {
      setMinLength(min);
      setMaxLength(max);

      // Form state only: the range is written to the table class's
      // constraints when the dialog is confirmed.
      setError(
        validatePropertyRange(min, max, true, {
          rounded: 'Value should be a round number.',
          order: 'Min must be a less than max',
        }),
      );
    },
    [setMinLength, setMaxLength, setError],
  );

  return (
    <div>
      <PropertyRangeField
        Input={RangeFieldInput}
        Container={RangeFieldContainer}
        round
        maxValue={maxLength}
        minValue={minLength}
        invalid={!!error}
        onBlur={setTouched}
        onChange={handleRangeChange}
      />
      {error && <ErrorChip>{error}</ErrorChip>}
    </div>
  );
}
