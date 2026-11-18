import { lazy, Suspense, type FC } from 'react';
import { Spinner } from '@tomic/resource-ui/components/Spinner';
import type {
  ChangeSwitcherProps,
  ResourceDiffProps,
} from '../../chunks/ResourceDiff/ResourceDiff.js';

export {
  useResourceDiff,
  isPropEqual,
  type AtomicDiff,
} from './resourceDiffUtils.js';

const ResourceDiffChunk = lazy(() =>
  import('../../chunks/ResourceDiff/ResourceDiff.js').then(m => ({
    default: m.ResourceDiff,
  })),
);

const ChangeSwitcherChunk = lazy(() =>
  import('../../chunks/ResourceDiff/ResourceDiff.js').then(m => ({
    default: m.ChangeSwitcher,
  })),
);

export const ResourceDiff: FC<ResourceDiffProps> = props => (
  <Suspense fallback={<Spinner centered />}>
    <ResourceDiffChunk {...props} />
  </Suspense>
);

export const ChangeSwitcher: FC<ChangeSwitcherProps> = props => (
  <Suspense fallback={<Spinner centered />}>
    <ChangeSwitcherChunk {...props} />
  </Suspense>
);
