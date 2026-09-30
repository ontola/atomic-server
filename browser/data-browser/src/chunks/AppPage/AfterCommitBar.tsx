import { Button } from '@components/Button';
import { useResource, useStore } from '@tomic/react';
import { useState, type JSX } from 'react';
import toast from 'react-hot-toast';
import { FaArrowsRotate, FaTriangleExclamation } from 'react-icons/fa6';
import { styled } from 'styled-components';
import {
  answerAfterCommit,
  type AfterCommitAnswer,
  type AfterCommitSubscription,
} from './afterCommit';
import { useAfterCommit } from './useAfterCommit';

/**
 * Above an app's tab on a table (#1851): the edits its `afterCommit` hook
 * proposed in the background, waiting for an answer (decision 2), and a
 * quiet warning with Retry when it stopped following the table after
 * failing repeatedly (decision 3). Nothing when neither applies.
 */
export function AfterCommitBar({
  app,
  table,
  tableName,
}: {
  app: string;
  table: string;
  tableName: string;
}): JSX.Element | null {
  const status = useAfterCommit(app, table);
  const appName = useResource(app).title || 'This app';
  const sub = status?.subscriptions[0];

  if (!sub || (!sub.pending && !sub.stopped)) return null;

  return (
    <AfterCommitNotice
      sub={sub}
      appName={appName}
      table={table}
      tableName={tableName}
    />
  );
}

/** The bar itself, for one subscription. Exported for its tests. */
export function AfterCommitNotice({
  sub,
  appName,
  table,
  tableName,
}: {
  sub: AfterCommitSubscription;
  appName: string;
  table: string;
  tableName: string;
}): JSX.Element {
  const store = useStore();
  const drive = store.getDrive();
  const [busy, setBusy] = useState(false);

  const answer = async (op: AfterCommitAnswer) => {
    if (!drive) return;
    setBusy(true);

    try {
      await answerAfterCommit(store, { drive, table, app: sub.app, op });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rows = sub.pending?.rows ?? 0;

  return (
    <Column>
      {sub.pending && (
        <Bar role='status' data-testid='after-commit-proposal'>
          {/* Whole sentences, so each is one message to translate. */}
          <Message>
            {rows === 1
              ? `${appName} wants to change 1 row`
              : `${appName} wants to change ${rows} rows`}
          </Message>
          <Actions>
            <Button disabled={busy} onClick={() => answer('apply')}>
              Apply
            </Button>
            {sub.pending.inScope && (
              <Button
                subtle
                disabled={busy}
                onClick={() => answer('allow-all')}
              >
                Allow all edits by this view on this table
              </Button>
            )}
            <Button subtle disabled={busy} onClick={() => answer('decline')}>
              Decline
            </Button>
          </Actions>
        </Bar>
      )}
      {sub.stopped && (
        <Warning role='status' data-testid='after-commit-stopped'>
          <FaTriangleExclamation aria-hidden />
          <Message>
            <strong>{appName}</strong> stopped following changes to {tableName}:
            <Reason>{sub.stopped.reason}</Reason>
          </Message>
          <Actions>
            <Button subtle disabled={busy} onClick={() => answer('retry')}>
              <FaArrowsRotate aria-hidden />
              <span>Retry</span>
            </Button>
          </Actions>
        </Warning>
      )}
    </Column>
  );
}

const Column = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
`;

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  padding: 0.5rem 0.75rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.main};
  background: ${p => p.theme.colors.bg1};
`;

const Warning = styled(Bar)`
  border-color: ${p => p.theme.colors.warning};
  color: ${p => p.theme.colors.text};
  overflow-wrap: anywhere;

  > svg {
    color: ${p => p.theme.colors.warning};
    flex-shrink: 0;
  }
`;

const Message = styled.span`
  flex: 1 1 14rem;
`;

/** The plugin's own error, verbatim, under the sentence. */
const Reason = styled.span`
  display: block;
  font-family: monospace;
  font-size: 0.85em;
  color: ${p => p.theme.colors.textLight};
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
`;
