import { useEffect, useRef } from 'react';

export function useLifecycleWithDependencies(
  onMount: () => void,
  onCleanup: () => void,
) {
  const mountRef = useRef(onMount);
  const cleanupRef = useRef(onCleanup);

  useEffect(() => {
    mountRef.current = onMount;
    cleanupRef.current = onCleanup;
  }, [onMount, onCleanup]);

  useEffect(() => {
    mountRef.current();

    return () => {
      cleanupRef.current();
    };
  }, []);
}
