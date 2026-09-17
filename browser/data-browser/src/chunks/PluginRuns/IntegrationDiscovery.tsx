import { lazy, Suspense, useEffect } from 'react';
import { ButtonLink } from '@components/ButtonLink';
import { Card } from '@components/Card';
import { Column } from '@components/Row';
import { Button } from '@components/Button';
import { Dialog, useDialog } from '@components/Dialog';
import { IntegrationEvidence } from './IntegrationEvidence';
import { googleCalendarIntegration } from '@localthought/atomic-integrations/ui/GoogleCalendar';
import { useIntegrationProxy } from '@helpers/integrationProxy';
import { useLocalThoughtCompletedPlatform } from './localThoughtCallback';
import { isCatalogVisible, type CatalogEntry } from './pluginCatalog';

const NotionSetup = lazy(() =>
  import('./ConnectNotion').then(m => ({ default: m.ConnectNotion })),
);

const ClockifySetup = lazy(() =>
  import('./ConnectClockify').then(m => ({ default: m.ConnectClockify })),
);

const MT940Setup = lazy(() =>
  import('./ImportMT940').then(m => ({ default: m.ImportMT940 })),
);

const LocalThoughtSetup = lazy(() =>
  import('./ConnectLocalThought').then(m => ({
    default: m.ConnectLocalThought,
  })),
);

type BundledIntegration = {
  id: string;
  name: string;
  icon: string;
  description: string;
  capabilities: string;
  events: string;
  limitation: string;
  keywords: string;
  requiresApiPlugins?: boolean;
  platform?: string;
  callbackPlatform?: string;
  extension?: typeof googleCalendarIntegration;
};

// The one field a catalog.json entry can't hold: a live reference to the
// LocalThought extension module that customizes that platform's setup lens.
// Everything else about a bundled integration's card is data, sourced from
// catalog.json; this is code, so it stays here, keyed by the same shortname.
const EXTENSIONS: Partial<Record<string, typeof googleCalendarIntegration>> = {
  'devonian-google-calendar': googleCalendarIntegration,
};

function toBundledIntegration(
  entry: CatalogEntry,
): BundledIntegration | undefined {
  const { shortname, name, icon, description, capabilities, events } = entry;
  const { limitation, keywords } = entry;

  if (
    !name ||
    !icon ||
    !description ||
    !capabilities ||
    !events ||
    !limitation ||
    !keywords
  ) {
    return undefined;
  }

  return {
    id: shortname,
    name,
    icon,
    description,
    capabilities,
    events,
    limitation,
    keywords,
    requiresApiPlugins: entry.requiresApiPlugins,
    platform: entry.platform,
    callbackPlatform: entry.callbackPlatform,
    extension: EXTENSIONS[shortname],
  };
}

export function visibleBundledIntegrations(
  entries: CatalogEntry[],
  showExperimentalPlugins: boolean,
  showApiPlugins: boolean,
): BundledIntegration[] {
  return entries
    .filter(entry => isCatalogVisible(entry, showExperimentalPlugins))
    .map(toBundledIntegration)
    .filter((entry): entry is BundledIntegration => entry !== undefined)
    .filter(entry => !entry.requiresApiPlugins || showApiPlugins);
}

export function IntegrationDiscovery({
  entry,
  drive,
  workspace,
}: {
  entry: BundledIntegration;
  drive?: string;
  workspace?: string;
}) {
  const origin = useIntegrationProxy();
  const returned = useLocalThoughtCompletedPlatform(drive, origin, entry.id);
  const [dialog, show, , isOpen] = useDialog({
    onCancel: () => {
      if (returned) sessionStorage.removeItem('localthought-completed');
    },
  });
  useEffect(() => {
    if (returned && returned === (entry.platform ?? entry.callbackPlatform))
      show();
  }, [returned, entry.platform, entry.callbackPlatform, show]);

  return (
    <Card data-integration={entry.id}>
      <Column gap='0.75rem'>
        <h2>
          <span aria-hidden>{entry.icon}</span> {entry.name}
        </h2>
        <p>{entry.description}</p>
        <p>{entry.capabilities}</p>
        <p>{entry.events}</p>
        <details>
          <summary>Supported scope</summary>
          <p>{entry.limitation}</p>
          <p>
            Experimental integration. Preview proposed changes before approving
            them.
          </p>
        </details>
        {workspace && (entry.id === 'notion' || entry.id === 'mt940') && (
          <p>This integration creates a new workspace for its imported data.</p>
        )}
        {entry.id === 'devonian-github-issues' ? (
          <ButtonLink href='/app/devonian-demo'>Install plugin</ButtonLink>
        ) : (
          <>
            {!entry.platform && (
              <IntegrationEvidence
                id={entry.id as 'mt940' | 'clockify' | 'notion'}
              />
            )}
            <Button disabled={!drive} onClick={show}>
              Set up connection
            </Button>
          </>
        )}
      </Column>
      <Dialog {...dialog} width='38rem'>
        <Dialog.Title>
          <h2>
            <span aria-hidden>{entry.icon}</span> {entry.name}
          </h2>
        </Dialog.Title>
        <Dialog.Content>
          <Suspense fallback={<p>Loading setup…</p>}>
            {isOpen &&
              drive &&
              (entry.platform ? (
                <LocalThoughtSetup
                  drive={drive}
                  platform={entry.platform}
                  extension={entry.extension}
                  entry={entry.id}
                />
              ) : entry.id === 'mt940' ? (
                <MT940Setup drive={drive} />
              ) : entry.id === 'clockify' ? (
                <ClockifySetup drive={drive} workspace={workspace} />
              ) : (
                <NotionSetup drive={drive} />
              ))}
          </Suspense>
        </Dialog.Content>
      </Dialog>
    </Card>
  );
}
