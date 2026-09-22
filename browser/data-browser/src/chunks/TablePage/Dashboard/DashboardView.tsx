import { useResource } from '@tomic/react';
import { lazy, Suspense, type JSX } from 'react';
import { styled } from 'styled-components';

// A table with no block tab never pays for the block renderer.
const DashboardPage = lazy(() =>
  import('@chunks/DashboardPage').then(m => ({ default: m.DashboardPage })),
);

/** A composed App owns its blocks. */
export function DashboardView({ view }: { view: string | undefined }): JSX.Element {
  if (!view) {
    return <Empty>This app is still loading.</Empty>;
  }

  return <LoadedDashboard subject={view} />;
}

function LoadedDashboard({ subject }: { subject: string }): JSX.Element {
  const resource = useResource(subject);

  return (
    <Suspense fallback={<Empty>Loading app…</Empty>}>
      <DashboardPage resource={resource} />
    </Suspense>
  );
}

const Empty = styled.p`
  color: ${p => p.theme.colors.textLight};
  padding: ${p => p.theme.size(4)};
`;
