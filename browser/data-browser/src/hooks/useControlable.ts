import { useCallback, useRef, useState, type SetStateAction } from 'react';

type UseControllableProps<T> = {
  controlledValue?: T | undefined;
  defaultValue?: T | undefined;
  onChange?: (state: T) => void;
};

type SetStateFn<T> = (prevState: T) => T;

export function useControllable<T>({
  controlledValue,
  defaultValue,
  onChange,
}: UseControllableProps<T>): [
  T | undefined,
  (value: SetStateAction<T | undefined>) => void,
] {
  const isControlledRef = useRef(controlledValue !== undefined);
  const [uncontrolledValue, setUncontrolledValue] = useState<T | undefined>(
    defaultValue,
  );

  // I'm not sure how to fix this linter error but this is intended behavior so we'll ignore the rule.
  // eslint-disable-next-line react-hooks/refs
  const value = isControlledRef.current ? controlledValue : uncontrolledValue;

  const setValue = useCallback(
    (nextValue: SetStateAction<T | undefined>) => {
      let resolvedValue: T | undefined;

      if (typeof nextValue === 'function') {
        resolvedValue = (nextValue as SetStateFn<T | undefined>)(value);
      } else {
        resolvedValue = nextValue;
      }

      if (!isControlledRef.current) {
        setUncontrolledValue(resolvedValue);
      }

      if (onChange) {
        onChange(resolvedValue as T);
      }
    },
    [onChange, value],
  );

  return [value, setValue];
}
