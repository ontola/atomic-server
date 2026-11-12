import { Resource, useNumber, Datatype } from '@tomic/react';
import { forwardRef, type InputHTMLAttributes, type JSX } from 'react';
import { PropertyRangeField } from '@tomic/table';
import { ErrorChip } from '@components/forms/ErrorChip';
import { useValidation } from '@components/forms/formValidation/useValidation';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';

interface TableRangeInputProps {
  resource: Resource;
  minProp: string;
  maxProp: string;
}

const RangeInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>((props, ref) => (
  <InputWrapper $invalid={props['aria-invalid'] === true}>
    <InputStyled {...props} ref={ref} />
  </InputWrapper>
));

export function TableRangeInput({
  resource,
  minProp,
  maxProp,
}: TableRangeInputProps): JSX.Element {
  const [min, setMin] = useNumber(resource, minProp);
  const [max, setMax] = useNumber(resource, maxProp);
  const { setError, setTouched } = useValidation();
  const numeric = [Datatype.INTEGER, Datatype.FLOAT].includes(
    resource.props.datatype as Datatype,
  );

  return (
    <PropertyRangeField
      key={resource.subject + ':' + resource.props.datatype}
      minValue={min}
      maxValue={max}
      integers={resource.props.datatype !== Datatype.FLOAT}
      nonNegative={!numeric}
      messages={{
        integer: 'Enter whole numbers or leave the bounds empty.',
        number: 'Enter finite numbers or leave the bounds empty.',
        nonNegative: 'Bounds cannot be negative.',
        order: 'Minimum must not exceed maximum.',
      }}
      minLabel='Minimum'
      maxLabel='Maximum'
      Input={RangeInput}
      Error={ErrorChip}
      onBlur={setTouched}
      onValidationError={setError}
      onChange={(minimum, maximum) => {
        setMin(minimum);
        setMax(maximum);
      }}
    />
  );
}
