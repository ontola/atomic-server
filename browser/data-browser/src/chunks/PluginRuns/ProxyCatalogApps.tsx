import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { FaGithub, FaCalendarDays, FaNoteSticky, FaTableCells } from 'react-icons/fa6';
import { useStore } from '@tomic/react';
import { Button } from '@components/Button';
import { Card } from '@components/Card';
import { Column, Row } from '@components/Row';
import { constructOpenURL } from '@helpers/navigation';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { platformLocalId, ensureSyncablePlatform } from './syncablePlatform';
import { useProxyCatalog } from './proxyCatalog';

/** Display names only. Source IDs are always the proxy's own canonical IDs. */
export function platformDisplayName(id: string): string {
  if (id === 'github-issues') return 'GitHub';
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
    .map(part => (part === 'api' ? 'API' : part[0]?.toUpperCase() + part.slice(1)))
    .join(' ');
}

export function visibleProxyPlatforms(ids: string[], query: string): string[] {
  const search = query.trim().toLocaleLowerCase();
  return ids.filter(id =>
    [platformDisplayName(id), id].join(' ').toLocaleLowerCase().includes(search),
  );
}

/**
 * Discover provider *definitions* from the configured proxy.
 *
 * Installing creates an ordinary platform table, not an executable app.
 * Account OAuth, the collection tree and the sandboxed Syncables view are
 * deliberately separate milestones of #2521. Keep this section behind the
 * existing experimental toggle until those milestones can be completed.
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

  const catalogIds = catalog.status === 'ready' ? catalog.platforms : [];
  const catalogKey = catalogIds.join('\n');

  useEffect(() => {
    let active = true;
    setExisting({});
    setLookupError(undefined);
    if (catalog.status !== 'ready') return;

    setLoading(true);
    void Promise.all(
      catalog.platforms.map(async platform => {
        const localId = platformLocalId(catalog.origin, platform);
        const found = await store.findByLocalId(drive, drive, localId);
        return [platform, found?.subject] as const;
      }),
    )
      .then(found => {
        if (active) {
          setExisting(
            Object.fromEntries(
              found.filter((entry): entry is readonly [string, string] => !!entry[1]),
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
    // Catalog key changes on new provider lists; origin/drive are separate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, drive, catalog.origin, catalog.status, catalogKey]);

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

  const install = async (platform: string) => {
    setBusy(platform);

    try {
      const subject = await ensureSyncablePlatform(store, {
        drive,
        proxyOrigin: catalog.origin,
        platform,
        name: platform === 'github-issues' ? 'GitHub' : catalog.entries.find(item => item.id === platform)?.name ?? platformDisplayName(platform),
      });
      setExisting(previous => ({ ...previous, [platform]: subject }));
      navigate(constructOpenURL(subject));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-label='Integration proxy apps'>
      <Column gap='0.75rem'>
        <h2>Connect a service</h2>
        <p>
          From the configured integration proxy at <code>{catalog.origin}</code>.
          Experimental: adding a service creates its Atomic table. Connecting
          accounts and syncing collections will follow.
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
            const name =
              platform === 'github-issues'
                ? 'GitHub'
                : entry?.name ?? platformDisplayName(platform);
            const subject = existing[platform];

            return (
              <Card key={platform} data-proxy-platform={platform}>
                <Column gap='1rem'>
                  <Row center justify='space-between'>
                    <Avatar aria-hidden>
                      {platform === 'github-issues' ? (
                        <FaGithub />
                      ) : platform.includes('calendar') ? (
                        <FaCalendarDays />
                      ) : platform.includes('keep') ? (
                        <FaNoteSticky />
                      ) : (
                        <FaTableCells />
                      )}
                    </Avatar>
                    <small>Integration proxy</small>
                  </Row>
                  <div>
                    <h3>{name}</h3>
                    <Description>{entry?.description || platform}</Description>
                  </div>
                  <Row>
                    <Button
                      disabled={busy !== undefined || loading || !!lookupError}
                      onClick={() =>
                        subject
                          ? navigate(constructOpenURL(subject))
                          : void install(platform)
                      }
                      aria-label={subject ? `Open ${name}` : `Add ${name} to drive`}
                    >
                      {busy === platform
                        ? 'Adding…'
                        : subject
                          ? 'Open'
                          : 'Add to Drive'}
                    </Button>
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
