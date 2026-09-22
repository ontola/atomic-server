import {
  core,
  dataBrowser,
  useResource,
  useString,
  unknownSubject,
} from '@tomic/react';
import { useState, type JSX } from 'react';
import { LoaderBlock } from '@components/Loader';
import { Button } from '@components/Button';
import type { ResourcePageProps } from '@views/ResourcePage';
import { DashboardPage } from '@chunks/DashboardPage';
import { TablePage } from './TablePage';
import { ViewPublication } from './ViewPublication';

/** A View has its own URL even when it also appears as a table tab. */
export function ViewPage({ resource }: ResourcePageProps): JSX.Element {
  const [publishing, setPublishing] = useState(false);
  const [kind] = useString(resource, dataBrowser.properties.viewKind);
  const [legacyDashboard] = useString(
    resource,
    dataBrowser.properties.viewDashboard,
  );
  const [parent] = useString(resource, core.properties.parent);
  const table = useResource(parent ?? unknownSubject);
  const dashboard = useResource(legacyDashboard ?? resource.subject);

  if (resource.loading || (kind !== 'dashboard' && table.loading)) {
    return <LoaderBlock />;
  }
  if (resource.error) {
    return <p>Could not load this view: {String(resource.error)}</p>;
  }
  if (kind === 'dashboard') {
    return <DashboardPage resource={dashboard} />;
  }
  if (table.error || !table.hasClasses(dataBrowser.classes.table)) {
    return <p>This view has no table to display.</p>;
  }

  return (
    <>
      <Button
        subtle
        onClick={() =>
          window.location.assign(
            `/app/show?subject=${encodeURIComponent(table.subject)}&view=${encodeURIComponent(resource.subject)}`,
          )
        }
      >
        Back to table
      </Button>
      <Button subtle onClick={() => setPublishing(value => !value)}>
        {publishing ? 'Back to view' : 'Publish view'}
      </Button>
      {publishing ? (
        <ViewPublication view={resource} table={table} />
      ) : (
        <TablePage resource={table} viewSubject={resource.subject} embedded />
      )}
    </>
  );
}
