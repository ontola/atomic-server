import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { FaPlug } from 'react-icons/fa6';
import {
  describeAuthenticatedPrincipals,
  describeCollections,
  prepareDocument,
} from 'syncables/browser';
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
import {
  listSyncablePrincipalApps,
  type SyncablePrincipalAppRef,
} from './syncablePrincipalApp';

/** Display names only. Source IDs are always the proxy's own canonical IDs. */
export function platformDisplayName(id: string): string {
  return id
    .split('-')
    .map(part =>
      part === 'api' ? 'API' : part[0]?.toUpperCase() + part.slice(1),
    )
    .join(' ');
}

/**
 * Discover provider *definitions* from the configured proxy.
 *
 * Installing a supported service creates a provider App whose identities
 * are described by the catalog.
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
  const [principalApps, setPrincipalApps] = useState<
    Record<string, readonly SyncablePrincipalAppRef[]>
  >({});
  const [lookupError, setLookupError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();

  const ready = catalog.status === 'ready' ? catalog : undefined;

  useEffect(() => {
    if (!ready) return;

    let active = true;
    setExisting({});
    setPrincipalApps({});
    setLookupError(undefined);
    setLoading(true);
    void Promise.all(
      ready.platforms.map(async platform => {
        const scope = { drive, proxyOrigin: ready.origin, platform };
        const [subject, principals] = await Promise.all([
          findSyncablePlatform(store, scope),
          listSyncablePrincipalApps(store, scope),
        ]);

        return [platform, subject, principals] as const;
      }),
    )
      .then(found => {
        if (active) {
          setExisting(
            Object.fromEntries(
              found
                .filter(([, subject]) => !!subject)
                .map(([platform, subject]) => [platform, subject!]),
            ),
          );
          setPrincipalApps(
            Object.fromEntries(
              found.map(([platform, , principals]) => [platform, principals]),
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

  const search = query.trim().toLocaleLowerCase();
  const visible = catalog.entries.filter(entry =>
    [entry.name ?? platformDisplayName(entry.id), entry.id].some(value =>
      value.toLocaleLowerCase().includes(search),
    ),
  );

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
      const document = prepareDocument(
        metadata.document as Record<string, unknown>,
      );
      const collections = describeCollections(document);
      if (
        collections.length === 0 ||
        (describeAuthenticatedPrincipals(document).length === 0 &&
          !collections.some(
            collection =>
              collection.allowsAnonymous ||
              collection.entrypoints.some(entry => entry.allowsAnonymous),
          ))
      )
        throw new Error('This catalog does not describe a usable sync source');
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
          . Add a service and choose an account for this drive.
        </p>
        {lookupError && (
          <p role='alert'>
            Could not determine installed services: {lookupError}
          </p>
        )}
        {visible.length === 0 && <p>No matching services.</p>}
        <Grid>
          {visible.map(entry => {
            const platform = entry.id;
            const name = entry.name ?? platformDisplayName(platform);
            const subject = existing[platform];

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
                    <Description>{entry.description || platform}</Description>
                  </div>
                  <Row>
                    <Button
                      disabled={busy !== undefined || loading || !!lookupError}
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
                  </Row>
                  {(principalApps[platform]?.length ?? 0) > 0 && (
                    <Column gap='0.5rem'>
                      <small>Connected apps</small>
                      {principalApps[platform].map(principal => (
                        <Button
                          key={principal.subject}
                          subtle
                          onClick={() =>
                            navigate(constructOpenURL(principal.subject))
                          }
                        >
                          {principal.name}
                        </Button>
                      ))}
                    </Column>
                  )}
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
