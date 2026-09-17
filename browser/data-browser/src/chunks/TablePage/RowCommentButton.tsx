import { useContext, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaMessage, FaRegMessage } from 'react-icons/fa6';
import {
  unknownSubject,
  useMemberFromCollection,
  useResource,
  type Collection,
} from '@tomic/react';
import { useRightPanel } from '@components/RightPanel/RightPanelContext';
import { useCommentCount } from '../../hooks/useCommentCount';
import { TablePageContext } from './tablePageContext';

/**
 * The comment bubble in a table row's gutter, like Notion's. A row is a
 * resource of its own, so its thread is the ordinary one: Messages whose
 * `about` points at the row. Clicking opens that thread in the shared comments
 * panel; clicking the row whose thread is already up closes it again.
 *
 * Mounted by the grid for every visible row via
 * `FancyTableProps.RowHeaderAddonComponent`, which hands it nothing but the row
 * index — the mapping from index to resource comes from the table page.
 */
export function RowCommentButton({
  rowIndex,
}: {
  rowIndex: number;
}): JSX.Element | null {
  const { rowSource } = useContext(TablePageContext);
  const source = rowSource(rowIndex);

  if (!source) {
    return null;
  }

  // The two kinds of row reach their resource by different routes, so each gets
  // the hook the grid itself uses for it.
  return source.kind === 'member' ? (
    <MemberRowComments collection={source.collection} index={source.index} />
  ) : (
    <SessionRowComments rowKey={source.key} />
  );
}

function MemberRowComments({
  collection,
  index,
}: {
  collection: Collection;
  index: number;
}): JSX.Element | null {
  const resource = useMemberFromCollection(collection, index);

  return resource.subject === unknownSubject ? null : (
    <RowCommentBubble subject={resource.subject} />
  );
}

/** A row added this session: local, under a `_new:` key, until the user types
 *  into it and it materializes — at which point the store aliases that key to
 *  the row's real subject and there is finally something to comment on. */
function SessionRowComments({
  rowKey,
}: {
  rowKey: string;
}): JSX.Element | null {
  const resource = useResource(rowKey, NEW_RESOURCE_OPTS);

  return resource.subject.startsWith('_new:') ? null : (
    <RowCommentBubble subject={resource.subject} />
  );
}

/** Matches TableNewRow: resolve the placeholder locally, never fetch it. */
const NEW_RESOURCE_OPTS = { newResource: true };

function RowCommentBubble({ subject }: { subject: string }): JSX.Element {
  const { count, hasUnseen } = useCommentCount(subject);
  const { activePanel, commentSubject, toggleCommentsFor } = useRightPanel();
  const isShowing = activePanel === 'comments' && commentSubject === subject;

  // A row with something to say keeps its bubble on screen; an empty one only
  // offers it while the row is hovered or focused (see `data-row-affordance`
  // in the grid's TableRow).
  const persistent = count > 0 || isShowing;

  return (
    <Bubble
      type='button'
      data-row-affordance
      data-persistent={persistent ? '' : undefined}
      data-unseen={hasUnseen ? '' : undefined}
      data-showing={isShowing ? '' : undefined}
      data-testid='row-comment-button'
      aria-expanded={isShowing}
      title={
        count > 0
          ? /* @wc-ignore */ `${count} comments on this row`
          : /* @wc-ignore */ 'Comment on this row'
      }
      onClick={() => toggleCommentsFor(subject)}
    >
      {count > 0 ? <FaMessage /> : <FaRegMessage />}
      {count > 0 && <Count>{count}</Count>}
    </Bubble>
  );
}

const Bubble = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.3ch;
  border: none;
  cursor: pointer;
  padding: 0.1rem 0.35rem;
  border-radius: 1em;
  font-size: 0.75rem;
  line-height: 1;
  background: transparent;
  color: ${p => p.theme.colors.textLight};

  &:hover,
  &:focus-visible {
    background: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }

  &[data-unseen],
  &[data-showing] {
    background: ${p => p.theme.colors.main};
    color: ${p => p.theme.colors.bg};
  }

  & > svg {
    font-size: 0.8rem;
  }
`;

const Count = styled.span`
  font-variant-numeric: tabular-nums;
`;
