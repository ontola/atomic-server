import { Resource, urls, useNumber, useString } from '@tomic/react';
import {
  useCallback,
  type JSX,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { PropertyPrecisionField } from '@tomic/table';
import { ErrorChip } from '@tomic/resource-ui/components/forms/ErrorChip';
import { useValidation } from '@tomic/resource-ui/components/forms/formValidation/useValidation';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import { FormGroupHeading } from '../FormGroupHeading.js';

interface DecimalPlacesInputProps {
  resource: Resource;
}

export function DecimalPlacesInput({
  resource,
}: DecimalPlacesInputProps): JSX.Element {
  const { error, setError, setTouched } = useValidation();
  // No `commit`: the dialog saves (or creates a new property) on confirm.
  const [_, setDataType] = useString(resource, urls.properties.datatype);

  const [decimalPlaces, setDecimalPlaces] = useNumber(
    resource,
    urls.properties.constraints.decimalPlaces,
  );

  const handleDecimalPointChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      const num = Number.parseInt(newValue, 10);

      if (num < 0 || num > 20) {
        setError('Value must be between 0 and 20.', true);

        return;
      } else {
        setError(undefined);
      }

      if (num === 0) {
        await setDataType(urls.datatypes.integer);
      } else {
        await setDataType(urls.datatypes.float);
      }

      if (isNaN(num)) {
        return await setDecimalPlaces(undefined);
      }

      setDecimalPlaces(num);
    },
    [setError],
  );

  return (
    <PropertyPrecisionField
      value={decimalPlaces}
      label='Decimal Places'
      error={error}
      onChange={handleDecimalPointChange}
      onBlur={setTouched}
      Input={PrecisionInput}
      Heading={PrecisionHeading}
      Error={ErrorChip}
    />
  );
}

function PrecisionInput({
  $invalid,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { $invalid?: boolean }) {
  return (
    <InputWrapper $invalid={$invalid}>
      <InputStyled {...props} />
    </InputWrapper>
  );
}

function PrecisionHeading({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <FormGroupHeading as='label' htmlFor={htmlFor}>
      {children}
    </FormGroupHeading>
  );
}
