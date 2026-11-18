import { resourceTheme } from '@tomic/resource-ui/theme';
import { useResource } from '@tomic/react';
import { lazy, Suspense, type JSX } from 'react';
import { styled } from 'styled-components';
import { Spinner } from '@tomic/resource-ui/components/Spinner';

// Same chunk the Dashboard resource page loads, so a table with no dashboard
// tab never pays for the chart code.
const DashboardPage = lazy(() =>
  import('../../DashboardPage/index.js').then(m => ({
    default: m.DashboardPage,
  })),
);

/**
 * A table tab that shows a Dashboard: the view of kind `dashboard` names one
 * in `view-dashboard`, and this renders the same page the Dashboard resource
 * has on its own. Nothing about the dashboard is view-specific, which is the
 * point: blocks are resources, and this is only how the table reaches them.
 */
export function DashboardView({
  dashboard,
}: {
  dashboard: string | undefined;
}): JSX.Element {
  if (!dashboard) {
    // A view whose dashboard is still being created, or one written by hand
    // without the reference.
    return <Empty>This view has no dashboard yet.</Empty>;
  }

  return <LoadedDashboard subject={dashboard} />;
}

function LoadedDashboard({ subject }: { subject: string }): JSX.Element {
  const resource = useResource(subject);

  return (
    <Suspense fallback={<Spinner centered />}>
      <DashboardPage resource={resource} />
    </Suspense>
  );
}

const Empty = styled.p`
  color: ${p => resourceTheme(p.theme).colors.textLight};
  padding: ${p => resourceTheme(p.theme).size(4)};
`;
