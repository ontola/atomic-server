import { Resource, useNumber } from '@tomic/react';
import { useCallback, type JSX } from 'react';
import { ErrorChip } from '@tomic/resource-ui/components/forms/ErrorChip';
import { useValidation } from '@tomic/resource-ui/components/forms/formValidation/useValidation';
import {
  MinMaxInput,
  validateRange,
} from '@tomic/resource-ui/components/forms/MinMaxInput';

interface TableRangeInputProps {
  resource: Resource;
  minProp: string;
  maxProp: string;
  allowFractions?: boolean;
}

export function TableRangeInput({
  resource,
  minProp,
  maxProp,
  allowFractions = false,
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
      setError(validateRange(min, max, !allowFractions));
    },
    [allowFractions, setMinLength, setMaxLength, setError],
  );

  return (
    <div>
      <MinMaxInput
        round={!allowFractions}
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
