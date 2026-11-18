import { useEffect } from 'react';
import {
  Spinner as SharedSpinner,
  type SpinnerProps as SharedSpinnerProps,
} from '@tomic/ui/components/Spinner';
import {
  useOptionalResourceUIHost,
  type ResourceUIHost,
} from '../ResourceUIHost.js';

export interface SpinnerProps extends SharedSpinnerProps {
  /** An early shell screen can supply policy before the host provider mounts. */
  loadingPolicy?: ResourceUIHost['loading'];
}
/** The shared indicator retains its translated label and the shell's boot-splash policy. */
export function Spinner({
  centered = false,
  delay,
  loadingPolicy,
  ...props
}: SpinnerProps) {
  const host = useOptionalResourceUIHost();
  const loading = loadingPolicy ?? host?.loading;
  useEffect(
    () => (centered ? loading?.hold() : undefined),
    [centered, loading],
  );

  return (
    <SharedSpinner
      {...props}
      centered={centered}
      delay={delay ?? loading?.delay(centered) ?? 0}
      label='Loading'
    />
  );
}
