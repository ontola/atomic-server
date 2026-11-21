// @wc-ignore-file
import { useEffect, useState } from 'react';
import { getRuntime, subscribeRuntime } from './runtime.js';
export { getRuntime } from './runtime.js';
export function getRuntimeRx(loadID = 0) {
  const [runtime, setRuntime] = useState(() => getRuntime(loadID));
  useEffect(
    () => subscribeRuntime(loadID, runtime => setRuntime(() => runtime)),
    [loadID],
  );
  return runtime;
}
