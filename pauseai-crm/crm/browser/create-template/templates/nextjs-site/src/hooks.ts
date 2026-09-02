import { useState, useEffect, useRef } from 'react';

/**
 * useThrottle
 *
 * Returns a throttled version of the input value. The throttled value only
 * updates once every specified delay, even if the input value changes more frequently.
 *
 * @param value - The value to throttle.
 * @param delay - The delay period (in milliseconds) for the throttle.
 * @returns The throttled value.
 */
export function useThrottle<T>(value: T, interval: number = 500): T {
  const [throttledValue, setThrottledValue] = useState(value);
  const lastUpdated = useRef<number | null>(null);

  useEffect(() => {
    const now = Date.now();

    if (lastUpdated.current && now >= lastUpdated.current + interval) {
      lastUpdated.current = now;
      setThrottledValue(value);
    } else {
      const id = window.setTimeout(() => {
        lastUpdated.current = now;
        setThrottledValue(value);
      }, interval);

      return () => window.clearTimeout(id);
    }
  }, [value, interval]);

  return throttledValue;
}
