import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  CollectionBuilder,
  core,
  notifications,
  useStore,
  type Resource,
} from '@tomic/react';
import { styled } from 'styled-components';
import { Button } from './Button';
import { Column, Row } from './Row';
import { useSettings } from '../helpers/AppSettings';
import { fetchPersonalDriveSubject } from '../helpers/personalDrive';
import { useNotificationEngine } from '../hooks/useNotificationEngine';
import { AtomicLink } from './AtomicLink';

type WatchRow = {
  subject: string;
  target: string;
  targetName: string;
  enabled: boolean;
};

/**
 * Lists personal-drive WatchSubscriptions with mute-off / remove. Channels UI
 * stays deferred; this covers the Phase 3 "Settings list" checkbox.
 */
export function WatchesList(): JSX.Element {
  const store = useStore();
  const { agent } = useSettings();
  const engine = useNotificationEngine();
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!agent?.subject) {
      setRows([]);
      setLoading(false);

      return;
    }

    const personalDrive = await fetchPersonalDriveSubject(store, agent);

    if (!personalDrive) {
      setRows([]);
      setLoading(false);

      return;
    }

    try {
      const collection = await new CollectionBuilder(store)
        .setDrive(personalDrive)
        .setProperty(core.properties.isA)
        .setValue(notifications.classes.watchSubscription)
        .setPageSize(50)
        .buildAndFetch();

      const next: WatchRow[] = [];

      for (let i = 0; i < collection.totalMembers; i++) {
        const subject = await collection.getMemberWithIndex(i);

        if (!subject) {
          continue;
        }

        const res = await store.getResource(subject);
        const target = res.get(notifications.properties.watchTarget);

        if (typeof target !== 'string') {
          continue;
        }

        const enabled =
          (res.get(notifications.properties.notificationEnabled) as
            | boolean
            | undefined) !== false;

        let targetName = target;

        try {
          const t = await store.getResource(target);
          targetName =
            (t.get(core.properties.name) as string | undefined) ?? target;
        } catch {
          // keep subject
        }

        next.push({ subject, target, targetName, enabled });
      }

      setRows(next);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [store, agent]);

  useEffect(() => {
    void refresh();

    const unsub = engine?.subscribe(() => {
      void refresh();
    });

    return () => {
      unsub?.();
    };
  }, [engine, refresh]);

  const setEnabled = async (watch: Resource, enabled: boolean) => {
    await watch.set(notifications.properties.notificationEnabled, enabled);
    await watch.save();
    await engine?.reloadWatches();
    await refresh();
  };

  const removeWatch = async (subject: string) => {
    const res = await store.getResource(subject);
    await res.destroy();
    await engine?.reloadWatches();
    await refresh();
  };

  if (loading) {
    return <Muted>Loading watches…</Muted>;
  }

  if (rows.length === 0) {
    return (
      <Muted data-testid='watches-list-empty'>
        No watches yet. Open a table or collection and tap Watch.
      </Muted>
    );
  }

  return (
    <Column gap='0.5rem' data-testid='watches-list'>
      {rows.map(row => (
        <WatchRowStyled key={row.subject}>
          <AtomicLink subject={row.target}>{row.targetName}</AtomicLink>
          <Row gap='0.5rem'>
            <Button
              subtle
              onClick={async () => {
                const res = await store.getResource(row.subject);
                await setEnabled(res, !row.enabled);
              }}
            >
              {row.enabled ? 'Mute' : 'Unmute'}
            </Button>
            <Button
              subtle
              onClick={() => {
                void removeWatch(row.subject);
              }}
            >
              Remove
            </Button>
          </Row>
        </WatchRowStyled>
      ))}
    </Column>
  );
}

const Muted = styled.p`
  color: ${p => p.theme.colors.textLight};
  margin: 0;
`;

const WatchRowStyled = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
`;
