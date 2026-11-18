import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { FaPlug } from 'react-icons/fa6';
import type { AtomicValue } from '@tomic/lib';
import { findSchema, useResource, useStore } from '@tomic/react';
import { ResourceGlyph } from '@components/ResourceGlyph';
import { Button } from '@components/Button';
import { Card } from '@components/Card';
import { Column, Row } from '@components/Row';
import { constructOpenURL } from '@helpers/navigation';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import {
  findSyncablePlatform,
  ensureSyncablePlatform,
  syncablePlatformSchema,
} from './syncablePlatform';
import { resolveBuiltinApp } from '@chunks/AppPage/builtinApp';
import { useProxyCatalog } from './proxyCatalog';
import { fetchSyncableDocument, syncableBranding } from './syncableDocument';
import { installIntegrationIcon } from './installIntegrationIcon';

/** Display names only. Source IDs are always the proxy's own canonical IDs. */
export function platformDisplayName(id: string): string {
  if (id === 'gitlab') return 'GitLab';
  if (id === 'todoist') return 'Todoist';
  if (id === 'spotify') return 'Spotify';
  if (id === 'airtable') return 'Airtable';
  if (id === 'discord') return 'Discord';
  if (id === 'notion') return 'Notion';
  if (id === 'moneybird') return 'Moneybird';
  if (id === 'clockify') return 'Clockify';

  return id
    .split('-')
    .map(part =>
      part === 'api' ? 'API' : part[0]?.toUpperCase() + part.slice(1),
    )
    .join(' ');
}

export function visibleProxyPlatforms(ids: string[], query: string): string[] {
  const search = query.trim().toLocaleLowerCase();

  return ids.filter(id =>
    [platformDisplayName(id), id]
      .join(' ')
      .toLocaleLowerCase()
      .includes(search),
  );
}

/**
 * Discover provider *definitions* from the configured proxy.
 *
 * Installing a supported service creates an ordinary platform table with
 * Atomic Server's built-in Syncables view.
 */
export function ProxyCatalogApps({
  drive,
  query,
}: {
  drive: string;
  query: string;
}): React.JSX.Element {
  const catalog = useProxyCatalog();
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const [existing, setExisting] = useState<Record<string, string>>({});
  const [lookupError, setLookupError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();

  const ready = catalog.status === 'ready' ? catalog : undefined;

  useEffect(() => {
    if (!ready) return;

    let active = true;
    setExisting({});
    setLookupError(undefined);
    setLoading(true);
    void Promise.all(
      ready.platforms.map(async platform => {
        const subject = await findSyncablePlatform(store, {
          drive,
          proxyOrigin: ready.origin,
          platform,
        });

        return [platform, subject] as const;
      }),
    )
      .then(found => {
        if (active) {
          setExisting(
            Object.fromEntries(
              found.filter(
                (entry): entry is readonly [string, string] => !!entry[1],
              ),
            ),
          );
        }
      })
      .catch(error => {
        if (active) setLookupError(String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [store, drive, ready]);

  if (catalog.status === 'loading') {
    return <p aria-live='polite'>Loading integration proxy catalog…</p>;
  }

  if (catalog.status === 'error') {
    return (
      <p role='alert'>
        Could not load apps from {catalog.origin}: {catalog.message}
      </p>
    );
  }

  const visible = visibleProxyPlatforms(catalog.platforms, query);

  const install = (platform: string) => {
    setBusy(platform);
    void (async () => {
      const signal = new AbortController().signal;
      const installed = existing[platform]
        ? await store.getResource(existing[platform])
        : undefined;
      const oldTerms = await findSchema(store, drive, syncablePlatformSchema());
      const oldDocument = oldTerms.properties?.['syncable-api-document'];
      const oldSelection = oldTerms.properties?.['syncable-api-selection'];
      const savedDocument = oldDocument && installed?.get(oldDocument);
      const metadata = savedDocument
        ? {
            document: savedDocument,
            querySelection: oldSelection
              ? installed?.get(oldSelection)
              : undefined,
          }
        : await fetchSyncableDocument(catalog.origin, signal, platform);
      const branding = syncableBranding(metadata.document);
      const subject = await ensureSyncablePlatform(store, {
        drive,
        proxyOrigin: catalog.origin,
        platform,
        name:
          branding.name ??
          catalog.entries.find(item => item.id === platform)?.name ??
          platformDisplayName(platform),
      });
      const app = await resolveBuiltinApp(store, drive, subject);
      if (!app) throw new Error('The integration app is unavailable');
      const terms = await findSchema(store, drive, syncablePlatformSchema());

      for (const target of [subject, app.table]) {
        const resource = await store.getResource(target);
        const documentProperty = terms.properties?.['syncable-api-document'];
        const selectionProperty = terms.properties?.['syncable-api-selection'];

        if (documentProperty && !resource.get(documentProperty)) {
          await resource.set(
            documentProperty,
            metadata.document as AtomicValue,
          );
          if (selectionProperty && metadata.querySelection)
            await resource.set(
              selectionProperty,
              metadata.querySelection as AtomicValue,
            );
          await resource.save();
        }
      }

      await installIntegrationIcon(store, subject, branding.icon, signal).catch(
        () =>
          toast.error('The app is ready, but its icon could not be loaded.'),
      );

      return subject;
    })()
      .then(subject => {
        setExisting(previous => ({ ...previous, [platform]: subject }));
        navigate(constructOpenURL(subject));
      })
      .catch(error => toast.error(String(error)))
      .finally(() => setBusy(undefined));
  };

  return (
    <section aria-label='Integration proxy apps'>
      <Column gap='0.75rem'>
        <h2>Connect a service</h2>
        <p>
          From the configured integration proxy at <code>{catalog.origin}</code>
          . Add GitHub to browse repositories and import issues into your drive.
        </p>
        {lookupError && (
          <p role='alert'>
            Could not determine installed services: {lookupError}
          </p>
        )}
        {visible.length === 0 && <p>No matching services.</p>}
        <Grid>
          {visible.map(platform => {
            const entry = catalog.entries.find(item => item.id === platform);
            const name = entry?.name ?? platformDisplayName(platform);
            const subject = existing[platform];
            const canInstall = platform === 'github-issues';

            return (
              <Card key={platform} data-proxy-platform={platform}>
                <Column gap='1rem'>
                  <Row center justify='space-between'>
                    <Avatar aria-hidden>
                      <InstalledIcon subject={subject} />
                    </Avatar>
                    <small>Integration proxy</small>
                  </Row>
                  <div>
                    <h3>{name}</h3>
                    <Description>{entry?.description || platform}</Description>
                  </div>
                  <Row>
                    {!canInstall && !subject ? (
                      <small>Sync support unavailable</small>
                    ) : (
                      <Button
                        disabled={
                          busy !== undefined || loading || !!lookupError
                        }
                        onClick={() => install(platform)}
                        aria-label={
                          subject ? `Open ${name}` : `Add ${name} to drive`
                        }
                      >
                        {busy === platform
                          ? 'Adding…'
                          : subject
                            ? 'Open'
                            : 'Add to Drive'}
                      </Button>
                    )}
                  </Row>
                </Column>
              </Card>
            );
          })}
        </Grid>
      </Column>
    </section>
  );
}

function InstalledIcon({ subject }: { subject?: string }) {
  const resource = useResource(subject);

  return subject ? (
    <ResourceGlyph resource={resource} fallbackIcon={FaPlug} />
  ) : (
    <FaPlug />
  );
}

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
  gap: 1rem;
  align-items: start;
`;

const Avatar = styled.span`
  display: inline-grid;
  place-items: center;
  width: 2.8rem;
  height: 2.8rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};
  font-size: 1.3rem;
`;

const Description = styled.p`
  color: ${p => p.theme.colors.textLight};
  overflow-wrap: anywhere;
`;
