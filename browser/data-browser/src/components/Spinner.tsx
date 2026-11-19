import { useEffect } from 'react';
import {
  Spinner as SharedSpinner,
  type SpinnerProps,
} from '@tomic/ui/components/Spinner';
import { holdBootSplash } from '../helpers/bootSplash';
import { isEmbedded } from '../helpers/embedMode';

/** Atomic's boot-splash policy around the shared loading indicator. */
export function Spinner({
  centered = false,
  delay = centered && isEmbedded() ? 1000 : 0,
  ...props
}: SpinnerProps) {
  useEffect(() => (centered ? holdBootSplash() : undefined), [centered]);

  return (
    <SharedSpinner
      {...props}
      centered={centered}
      delay={delay}
      label='Loading'
    />
  );
}
