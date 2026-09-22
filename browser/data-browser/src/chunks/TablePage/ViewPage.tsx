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
import { AppPublication } from './AppPublication';
import { WebsitePage } from '@chunks/Website/WebsitePage';
import { AppPage } from '@chunks/AppPage';
import { WebsiteExportPage } from '@chunks/Website/WebsiteExportPage';

/** A View has its own URL even when it also appears as a table tab. */
export function ViewPage({
  resource,
  websiteVersion,
}: ResourcePageProps & { websiteVersion?: string }): JSX.Element {
  const [kind] = useString(resource, dataBrowser.properties.viewKind);

  if (kind === 'site')
    return websiteVersion ? (
      <WebsiteExportPage resource={resource} deployment={websiteVersion} />
    ) : (
      <WebsitePage resource={resource} />
    );
  if (kind === 'code') return <AppPage resource={resource} />;
  if (kind === 'blocks') return <DashboardPage resource={resource} />;

  return <TableAppPage resource={resource} />;
}

function TableAppPage({ resource }: ResourcePageProps): JSX.Element {
  const [publishing, setPublishing] = useState(false);
  const [parent] = useString(resource, core.properties.parent);
  const table = useResource(parent ?? unknownSubject);
  if (resource.loading || table.loading) {
    return <LoaderBlock />;
  }
  if (resource.error) {
    return <p>Could not load this app: {String(resource.error)}</p>;
  }
  if (table.error || !table.hasClasses(dataBrowser.classes.table)) {
    return <p>This app has no table to display.</p>;
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
        {publishing ? 'Back to app' : 'Publish app'}
      </Button>
      {publishing ? (
        <AppPublication app={resource} table={table} />
      ) : (
        <TablePage resource={table} viewSubject={resource.subject} embedded />
      )}
    </>
  );
}
