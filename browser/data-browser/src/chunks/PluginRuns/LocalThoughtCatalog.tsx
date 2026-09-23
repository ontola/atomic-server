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

// The proxy's platform list, fetched once per proxy origin like the plugin
// catalog in pluginCatalog.ts. Fetching it per mount left the section on
// "Loading…", with no cards, after every remount until the proxy answered
// again; the settled value lets a remount render the cards straight away.
const platformCache = new Map<string, Promise<string[]>>();
const resolvedPlatforms = new Map<string, string[]>();

function fetchPlatforms(origin: string): Promise<string[]> {
  let promise = platformCache.get(origin);

  if (!promise) {
    promise = browserIntegrations(origin)
      .catalog()
      .then(platforms => {
        resolvedPlatforms.set(origin, platforms);

        return platforms;
      })
      .catch(reason => {
        platformCache.delete(origin);
        throw reason;
      });
    platformCache.set(origin, promise);
  }

  return promise;
}

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
  const [platforms, setPlatforms] = useState(() =>
    resolvedPlatforms.get(origin),
  );
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPlatforms(resolvedPlatforms.get(origin));
    setError('');
    fetchPlatforms(origin)
      .then(data => {
        if (active) setPlatforms(data);
      })
      .catch(reason => {
        if (active) setError(String(reason));
      });

    return () => {
      active = false;
    };
  }, [origin]);
  const visible = localThoughtCatalogEntries(
    platforms,
    catalogEntries.flatMap(entry => entry.platform ?? []),
  )
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
