import { Resource, urls, useNumber, useString } from '@tomic/react';
import { type JSX, type InputHTMLAttributes } from 'react';
import { PropertyPrecisionField } from '@tomic/table';
import { ErrorChip } from '@components/forms/ErrorChip';
import { useValidation } from '@components/forms/formValidation/useValidation';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';

function PrecisionInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <InputWrapper $invalid={props['aria-invalid'] === true}>
      <InputStyled {...props} />
    </InputWrapper>
  );
}

/** Atomic datatype/default policy; raw precision input and validation are shared. */
export function DecimalPlacesInput({
  resource,
}: {
  resource: Resource;
}): JSX.Element {
  const { setError, setTouched } = useValidation();
  const [_, setDataType] = useString(resource, urls.properties.datatype);
  const [decimalPlaces, setDecimalPlaces] = useNumber(
    resource,
    urls.properties.constraints.decimalPlaces,
  );

  return (
    <PropertyPrecisionField
      key={resource.subject}
      value={decimalPlaces}
      label='Decimal Places'
      invalidMessage='Enter a whole number between 0 and 20, or leave empty.'
      Input={PrecisionInput}
      Error={ErrorChip}
      onBlur={setTouched}
      onValidationError={error => setError(error, true)}
      onChange={async value => {
        await setDataType(
          value === 0 ? urls.datatypes.integer : urls.datatypes.float,
        );
        await setDecimalPlaces(value);
      }}
    />
  );
}
