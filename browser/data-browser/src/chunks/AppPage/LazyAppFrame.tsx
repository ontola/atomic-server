import { lazy, Suspense, type ComponentProps } from 'react';

const Frame = lazy(() =>
  import('./AppFrame').then(module => ({ default: module.AppFrame })),
);

/** Executable app UI loads when a frame mounts, including hidden executions. */
export function AppFrame(props: ComponentProps<typeof Frame>) {
  return (
    <Suspense fallback={null}>
      <Frame {...props} />
    </Suspense>
  );
}

export type { AppFrameProfile, AppOutcome } from './AppFrame';
