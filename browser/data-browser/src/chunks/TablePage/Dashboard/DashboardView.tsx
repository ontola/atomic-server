import { useResource } from '@tomic/react';
import { lazy, Suspense, type JSX } from 'react';
import { styled } from 'styled-components';

// Same chunk the Dashboard resource page loads, so a table with no dashboard
// tab never pays for the chart code.
const DashboardPage = lazy(() =>
  import('@chunks/DashboardPage').then(m => ({ default: m.DashboardPage })),
);

/** A composed View owns its blocks. Older views may still reference a Dashboard. */
export function DashboardView({
  dashboard,
  view,
}: {
  dashboard: string | undefined;
  view: string | undefined;
}): JSX.Element {
  const subject = dashboard ?? view;
  if (!subject) {
    return <Empty>This view is still loading.</Empty>;
  }

  return <LoadedDashboard subject={subject} />;
}

function LoadedDashboard({ subject }: { subject: string }): JSX.Element {
  const resource = useResource(subject);

  return (
    <Suspense fallback={<Empty>Loading dashboard…</Empty>}>
      <DashboardPage resource={resource} />
    </Suspense>
  );
}

const Empty = styled.p`
  color: ${p => p.theme.colors.textLight};
  padding: ${p => p.theme.size(4)};
`;
