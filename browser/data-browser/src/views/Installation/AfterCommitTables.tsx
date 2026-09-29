import { Button } from '@components/Button';
import { Column, Row } from '@components/Row';
import { constructOpenURL } from '@helpers/navigation';
import { useResource, useStore } from '@tomic/react';
import { ResourceInline } from '@views/ResourceInline/ResourceInline';
import { useState, type JSX } from 'react';
import toast from 'react-hot-toast';
import { FaArrowsRotate, FaTriangleExclamation } from 'react-icons/fa6';
import { AtomicLink } from '@components/AtomicLink';
import { styled } from 'styled-components';
import {
  answerAfterCommit,
  pendingRows,
  type AfterCommitSubscription,
} from '@chunks/AppPage/afterCommit';
import { useAfterCommit } from '@chunks/AppPage/useAfterCommit';

/**
 * The tables this installation follows with its `afterCommit` hook (#1851):
 * how many proposed edits wait, each linking to its table where they are
 * answered (decision 2), and a quiet warning with Retry for a table it
 * stopped following (decision 3). Nothing when it follows no table.
 */
export function AfterCommitTables({
  installation,
  canWrite,
}: {
  installation: string;
  canWrite: boolean;
}): JSX.Element | null {
  const status = useAfterCommit(installation);
  const subs = status?.subscriptions ?? [];

  if (!status?.enabled || subs.length === 0) return null;

  const waiting = pendingRows(subs);

  return (
    <Column as='section' aria-label='Tables it follows'>
      <h3>Tables it follows</h3>
      <Muted data-testid='after-commit-waiting-count'>
        {waiting === 0
          ? 'No proposed edits are waiting.'
          : waiting === 1
            ? 'One proposed edit is waiting for review.'
            : `${waiting} proposed edits are waiting for review.`}
      </Muted>
      <List>
        {subs.map(sub => (
          <FollowedTable key={sub.table} sub={sub} canWrite={canWrite} />
        ))}
      </List>
    </Column>
  );
}

function FollowedTable({
  sub,
  canWrite,
}: {
  sub: AfterCommitSubscription;
  canWrite: boolean;
}): JSX.Element {
  const store = useStore();
  const drive = store.getDrive();
  const table = useResource(sub.table);
  const [busy, setBusy] = useState(false);
  const open = constructOpenURL(sub.table, { view: sub.view });

  const retry = async () => {
    if (!drive) return;
    setBusy(true);

    try {
      await answerAfterCommit(store, {
        drive,
        table: sub.table,
        app: sub.app,
        op: 'retry',
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Item>
      <Row center justify='space-between' wrapItems>
        <ResourceInline subject={sub.table} />
        {sub.pending && (
          <AtomicLink path={open} data-testid='after-commit-table-pending'>
            {sub.pending.rows === 1
              ? 'One row waiting'
              : `${sub.pending.rows} rows waiting`}
          </AtomicLink>
        )}
      </Row>
      {sub.stopped && (
        <Warning role='status'>
          <FaTriangleExclamation aria-hidden />
          <span>
            Stopped following changes to {table.title || 'this table'}:
            <Reason>{sub.stopped.reason}</Reason>
          </span>
          {canWrite && (
            <Button subtle disabled={busy} onClick={retry}>
              <FaArrowsRotate aria-hidden />
              <span>Retry</span>
            </Button>
          )}
        </Warning>
      )}
    </Item>
  );
}

const Reason = styled.span`
  display: block;
  font-family: monospace;
  font-size: 0.85em;
  color: ${p => p.theme.colors.textLight};
`;

const Muted = styled.p`
  color: ${p => p.theme.colors.textLight};
  margin: 0;
`;

const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const Item = styled.li`
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
`;

const Warning = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  overflow-wrap: anywhere;

  > svg {
    color: ${p => p.theme.colors.warning};
    flex-shrink: 0;
  }

  > span {
    flex: 1 1 12rem;
  }
`;
