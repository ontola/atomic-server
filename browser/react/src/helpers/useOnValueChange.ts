import { useState } from 'react';

const initialUnique = [Symbol('uniqueValue')];

export function useOnValueChange(
  callback: () => void,
  dependants: unknown[],
  runOnMount: boolean = false,
) {
  const [deps, setDeps] = useState(runOnMount ? initialUnique : dependants);

  if (deps.some((d, i) => d !== dependants[i])) {
    setDeps(dependants);
    callback();
  }
}
