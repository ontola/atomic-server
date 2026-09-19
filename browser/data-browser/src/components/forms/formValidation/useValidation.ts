import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { FormValidationContext } from './FormValidationContextProvider';
import type { JSONValue } from '@tomic/react';

export function useValidation(initialValue?: string | undefined): {
  error: string | undefined;
  setError: (error: Error | string | undefined, immediate?: boolean) => void;
  setTouched: () => void;
} {
  const id = useId();

  const [touched, setTouched] = useState(false);
  const { setValidations, validations } = useContext(FormValidationContext);
  // Once the input reports its own validation result it owns the entry. Until
  // then the registered error follows `initialValue`, so a required field
  // whose value only arrives after the first render is (un)flagged correctly
  // instead of keeping whatever the first render computed.
  const ownedRef = useRef(false);

  const setError = useCallback(
    (error: Error | string | undefined, immediate = false) => {
      const err = error instanceof Error ? error.message : error;
      ownedRef.current = true;

      setValidations(prev => {
        if (prev[id] === err) {
          return prev;
        }

        return {
          ...prev,
          [id]: err,
        };
      });

      if (immediate) {
        setTouched(true);
      }
    },
    [setValidations, id],
  );

  const handleTouched = useCallback(() => {
    setTouched(true);
  }, []);

  useEffect(() => {
    if (ownedRef.current) {
      return;
    }

    setValidations(prev => {
      if (id in prev && prev[id] === initialValue) {
        return prev;
      }

      return {
        ...prev,
        [id]: initialValue,
      };
    });
  }, [initialValue, id, setValidations]);

  useEffect(() => {
    return () => {
      setValidations(prev => {
        // Not `const { [id]: _, ...rest } = prev`: React Compiler cannot lower
        // computed keys in an object pattern and would skip this hook.
        const rest = { ...prev };
        delete rest[id];

        return rest;
      });
    };
  }, [id, setValidations]);

  const error = touched ? validations[id] : undefined;

  return { error, setError, setTouched: handleTouched };
}

export function checkForInitialRequiredValue(
  value: JSONValue,
  required: boolean | undefined,
): string | undefined {
  if (typeof value === 'string') {
    if (required && value === '') {
      return 'Required';
    }
  }

  if (Array.isArray(value)) {
    if (required && value.length === 0) {
      return 'Required';
    }
  }

  if (required && value === undefined) {
    return 'Required';
  }

  return undefined;
}
