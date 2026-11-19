import { lazy, Suspense, type ComponentProps } from 'react';
import { LoaderBlock } from '@tomic/ui/components/Loader';

const Flow = lazy(() =>
  import('./GettingStartedFlow').then(module => ({
    default: module.GettingStartedFlow,
  })),
);

/** Account setup UI loads when that route is actually shown. */
export function GettingStartedFlow(props: ComponentProps<typeof Flow>) {
  return (
    <Suspense fallback={<LoaderBlock />}>
      <Flow {...props} />
    </Suspense>
  );
}
