import { localThoughtCatalogEntries } from './localThoughtCatalogEntries';
import { useIntegrationProxy } from '@helpers/integrationProxy';
import { useEffect, useState, Suspense } from 'react';
import { Card } from '@components/Card';
import { Column } from '@components/Row';
import { Button } from '@components/Button';
import { Dialog, useDialog } from '@components/Dialog';
import { ErrMessage } from '@components/forms/InputStyles';
import { ConnectLocalThought } from './ConnectLocalThought';
import { browserIntegrations, platformName } from './localThought';
import { useLocalThoughtCompletedPlatform } from './localThoughtCallback';
import {
  catalogByShortname,
  isCatalogVisible,
  useIntegrationCatalog,
} from './pluginCatalog';

export function LocalThoughtCatalog({
  drive,
  search,
  showExperimentalPlugins,
  onVisibilityChange,
}: {
  drive?: string;
  search: string;
  showExperimentalPlugins: boolean;
  onVisibilityChange?: (hasResults: boolean) => void;
}) {
  const origin = useIntegrationProxy();
  const { entries: catalogEntries } = useIntegrationCatalog();
  const catalogEntriesByShortname = catalogByShortname(catalogEntries);
  const [platforms, setPlatforms] = useState<string[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setPlatforms(undefined);
    setError('');
    browserIntegrations(origin)
      .catalog(controller.signal)
      .then(data => {
        if (!controller.signal.aborted) setPlatforms(data);
      })
      .catch(reason => {
        if (!controller.signal.aborted) setError(String(reason));
      });

    return () => controller.abort();
  }, [origin]);
  const visible = localThoughtCatalogEntries(platforms)
    .filter(id =>
      isCatalogVisible(
        catalogEntriesByShortname.get(id),
        showExperimentalPlugins,
      ),
    )
    .filter(id =>
      `${id} ${platformName(id)}`.toLowerCase().includes(search.toLowerCase()),
    );
  useEffect(() => {
    // An error already explains the empty section; only report a genuine
    // empty result once the fetch has actually settled.
    onVisibilityChange?.(Boolean(error) || !platforms || visible.length > 0);
  }, [error, platforms, visible.length, onVisibilityChange]);

  return (
    <>
      {error && <ErrMessage role='alert'>{error}</ErrMessage>}
      {!platforms && !error && <p>Loading LocalThought platforms…</p>}
      {visible.map(platform => (
        <PlatformCard
          key={`${origin}:${platform}`}
          platform={platform}
          origin={origin}
          drive={drive}
        />
      ))}
    </>
  );
}

function PlatformCard({
  platform,
  drive,
  origin,
}: {
  platform: string;
  drive?: string;
  origin: string;
}) {
  const returned =
    useLocalThoughtCompletedPlatform(drive, origin, `proxy:${platform}`) ===
    platform;
  const [dialog, show, , isOpen] = useDialog({
    onCancel: () => {
      if (returned) sessionStorage.removeItem('localthought-completed');
    },
  });
  useEffect(() => {
    if (returned) show();
  }, [returned, show]);

  return (
    <Card
      highlight
      data-integration={`proxy:${platform}`}
      data-integration-source='proxy'
    >
      <Column gap='0.75rem'>
        <h2>{platformName(platform)}</h2>
        <small>Via integration proxy</small>
        <p>
          Connect your account through LocalThought and import records into your
          drive.
        </p>
        <Button disabled={!drive} onClick={show}>
          Set up connection
        </Button>
      </Column>
      <Dialog {...dialog} width='38rem'>
        <Dialog.Title>
          <h2>{platformName(platform)}</h2>
        </Dialog.Title>
        <Dialog.Content>
          {isOpen && drive && (
            <Suspense fallback={<p>Loading setup…</p>}>
              <ConnectLocalThought
                drive={drive}
                platform={platform}
                origin={origin}
                entry={`proxy:${platform}`}
              />
            </Suspense>
          )}
        </Dialog.Content>
      </Dialog>
    </Card>
  );
}
