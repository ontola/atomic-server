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

export function bundledIntegrations(): BundledIntegration[] {
  return [
    {
      id: 'devonian-github-issues' as const,
      name: 'GitHub issues and comments (Devonian)',
      icon: '🐙',
      description: 'Connect a GitHub repository to a local issue tracker.',
      capabilities:
        'Sync issues and comments in both directions, including closing and reopening issues.',
      events:
        'Connect through LocalThought, then use Sync now to exchange changes.',
      limitation:
        'Creates a separate local drive. Keep the browser open to sync. Sync writes changes to your GitHub repository.',
      keywords: 'devonian github issues comments lens local tracker',
      requiresApiPlugins: true,
    },
    {
      id: 'devonian-google-calendar',
      name: 'Google Calendar (Devonian)',
      icon: '🗓️',
      description: 'Import Google Calendar events into calendar views.',
      capabilities:
        'Preserves recurring series and previews supported edits to send back to Google.',
      events:
        'Connect through LocalThought, then use Sync now to exchange changes.',
      limitation:
        'Creates a local calendar folder. Keep the browser open to sync. Calendar writes require review before they are sent to Google.',
      keywords: 'google calendar devonian events recurring lens local tracker',
      requiresApiPlugins: true,
      platform: 'google-calendar',
      extension: googleCalendarIntegration,
    },
    {
      id: 'mt940' as const,
      name: 'Bank statements',
      icon: '🏦',
      description:
        'Import bank transactions from bunq and other MT940 exports.',
      capabilities:
        'Preview exact amounts, dates, account references and original descriptions in a Bank transactions table.',
      events: 'Upload a statement when you need it. No bank token required.',
      limitation:
        'MT940 files only, up to 500 transactions and 512 KB. No payment initiation or live bank sync. Bank-specific formats may need additional support.',
      keywords:
        'bank bunq banking finance accounting statement mt940 import swift',
    },
    {
      id: 'clockify' as const,
      name: 'Clockify',
      icon: '⏱️',
      description: 'Bring your completed work into the Time Tracker.',
      capabilities:
        'Import completed entries with project and person links, start/end times and billable flags.',
      events:
        'Review imports before applying them. This first version does not sync changes back.',
      limitation:
        'Your entries only; up to 31 days. No active timers, updates, deletions, tags, task links, rates or custom fields.',
      keywords: 'clockify time tracking timesheet projects billable import',
    },
    {
      id: 'notion' as const,
      name: 'Notion',
      icon: '📓',
      description: 'Work with your Notion database in Atomic.',
      capabilities:
        'Sync supported row fields, property names and table or board views.',
      events: 'Start automations from newly discovered rows.',
      limitation:
        'Formatted text, relations, formulas and filtered views need additional mappings.',
      keywords: 'notion database table board rows knowledge tasks automation',
      requiresApiPlugins: true,
      callbackPlatform: 'notion',
    },
  ];
}

export function visibleBundledIntegrations(
  showExperimentalPlugins: boolean,
  showApiPlugins: boolean,
) {
  return (showExperimentalPlugins ? bundledIntegrations() : []).filter(
    entry => !entry.requiresApiPlugins || showApiPlugins,
  );
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
