import { Resource } from '@tomic/lib';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from './hooks.js';

// T is a generic type for value parameter, our case this will be string
export function useDebounce<T>(value: T, delay: number): T {
  // State and setters for debounced value
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(
    () => {
      // Update debounced value after delay
      const handler = setTimeout(() => {
        setDebouncedValue(value);
      }, delay);

      // Cancel the timeout if value changes (also on delay change or unmount)
      // This is how we prevent debounced value from updating if value is changed ...
      // .. within the delay period. Timeout gets cleared and restarted.
      return () => {
        clearTimeout(handler);
      };
    },
    [value, delay], // Only re-call effect if value or delay changes
  );

  return debouncedValue;
}

export function useDebouncedSave(
  resource: Resource,
  timeout: number,
  onError?: (error: Error) => void,
): [save: () => void, savePending: boolean] {
  const timeoutId = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [savePending, setSavePending] = useState(false);
  const store = useStore();

  const save = useCallback(() => {
    // Report the debounce window to the store so sync status counts the
    // not-yet-executed save (see Store.startScheduledSave).
    if (timeoutId.current !== undefined) {
      clearTimeout(timeoutId.current);
    } else {
      store.startScheduledSave();
    }

    timeoutId.current = setTimeout(async () => {
      timeoutId.current = undefined;

      try {
        await resource.__internalObject.save();
        setSavePending(false);
      } catch (e) {
        if (onError) {
          onError(e instanceof Error ? e : new Error(String(e)));
        } else {
          throw e;
        }
      } finally {
        store.finishScheduledSave();
      }
    }, timeout);

    setSavePending(true);
  }, [resource.__internalObject, timeout, onError, store]);

  return [save, savePending];
}
