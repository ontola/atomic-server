import { useCallback, useEffect, useState, type JSX } from 'react';
import { core, notifications, useStore, type Resource } from '@tomic/react';
import { styled } from 'styled-components';
import { Button } from './Button';
import { Column, Row } from './Row';
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
  const engine = useNotificationEngine();
  const [rows, setRows] = useState<WatchRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!engine) {
      setRows([]);
      setLoading(false);

      return;
    }

    const next: WatchRow[] = [];

    for (const watch of engine.listWatches()) {
      let targetName = watch.target;

      try {
        const t = await store.getResource(watch.target);
        targetName =
          (t.get(core.properties.name) as string | undefined) ?? watch.target;
      } catch {
        // keep subject
      }

      next.push({
        subject: watch.subject,
        target: watch.target,
        targetName,
        enabled: watch.enabled,
      });
    }

    setRows(next);
    setLoading(false);
  }, [store, engine]);

  useEffect(() => {
    void refresh();

    return engine?.subscribe(() => {
      void refresh();
    });
  }, [engine, refresh]);

  const setEnabled = async (watch: Resource, enabled: boolean) => {
    await watch.set(notifications.properties.notificationEnabled, enabled);
    await watch.save();
    await engine?.reloadWatches();
  };

  const removeWatch = async (subject: string) => {
    const res = await store.getResource(subject);
    await res.destroy();
    await engine?.reloadWatches();
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
