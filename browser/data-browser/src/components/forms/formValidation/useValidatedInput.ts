import { useCallback } from 'react';
import {
  validateDatatype,
  type Datatype,
  type JSONValue,
  type SetValue,
} from '@tomic/react';
import { checkForInitialRequiredValue, useValidation } from './useValidation';

export interface UseValidatedInputOptions {
  datatype: Datatype;
  /** Whether the field must have a value before the form can be submitted */
  required?: boolean;
}

/**
 * Shared validate-then-write logic for the form inputs.
 *
 * `update` validates `next` against the property's datatype FIRST and writes
 * it to the resource only when it is valid, so an invalid value never ends up
 * in the Loro doc (or gets scheduled for a commit). Empty values (`undefined`
 * or `''`) skip datatype validation, are written as given so the caller decides
 * whether "empty" means `''` or `undefined`, and are flagged `Required` when
 * the field is required.
 *
 * Returns `true` when the value was written.
 */
export function useValidatedInput<T extends JSONValue>(
  value: T | undefined,
  setValue: SetValue<T>,
  { datatype, required }: UseValidatedInputOptions,
) {
  const { error, setError, setTouched } = useValidation(
    checkForInitialRequiredValue(value, required),
  );

  const update = useCallback(
    (next: T | undefined): boolean => {
      if (next === undefined || next === '') {
        setValue(next);
        setError(required ? 'Required' : undefined);

        return true;
      }

      try {
        validateDatatype(next, datatype);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));

        return false;
      }

      setValue(next);
      setError(undefined);

      return true;
    },
    [datatype, required, setValue, setError],
  );

  return { error, setError, setTouched, update };
}
