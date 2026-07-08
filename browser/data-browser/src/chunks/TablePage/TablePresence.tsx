import { createContext, useCallback, useMemo, useRef } from 'react';
import { css, keyframes, styled } from 'styled-components';
import {
  useResourcePresence,
  useStore,
  type Collection,
  type Property,
} from '@tomic/react';
import { colorForAgent } from '@components/Presence/AgentAvatar';
import { PresenceUserTag } from '@components/Presence/PresenceUserTag';

/**
 * What a table session shares about where it is. Identity, not indexes:
 * a remote session's sort/filter/view can order rows differently, so
 * positions are named by subjects and each cell/card self-matches on
 * the receiving side.
 */
export interface TablePresenceData {
  /** Subject of the row resource (grid row / kanban card). */
  row: string;
  /** Subject of the column property whose cell is selected (grid). */
  column?: string;
  /** True while this session is dragging the card (kanban). */
  dragging?: boolean;
}

/** One remote session's position within the table, agent attached. */
export interface RowPresence {
  agent: string;
  column?: string;
  dragging?: boolean;
}

export interface TablePresenceValue {
  /** Row subject → remote sessions on that row (cell selections, card
   *  hovers, drags). Empty map when alone. */
  rows: Map<string, RowPresence[]>;
  /** Announce which card this session is on (kanban hover/drag);
   *  `undefined` row retracts the announcement. */
  setActiveCard: (row: string | undefined, dragging?: boolean) => void;
}

export const TablePresenceContext = createContext<TablePresenceValue>({
  rows: new Map(),
  setActiveCard: () => undefined,
});

interface UseTablePresenceOptions {
  collection: Collection;
  columns: Property[];
  /** Rows below this index are session rows from `newRowSubjects`. */
  memberCount: number;
  newRowSubjects: string[];
}

interface TablePresence {
  /** Provide on {@link TablePresenceContext} for the grid's cells and
   *  the kanban's cards. */
  presenceValue: TablePresenceValue;
  /** Wire to `FancyTable`'s `onSelectedCellChange`. */
  handleSelectedCellChange: (
    row: number | undefined,
    column: number | undefined,
  ) => void;
}

/**
 * Position presence for one table, on the drive presence channel
 * (`PresenceEntry.data`). Announces our active cell (grid) or card
 * (kanban) and exposes which rows remote sessions are on.
 */
export function useTablePresence(
  tableSubject: string,
  { collection, columns, memberCount, newRowSubjects }: UseTablePresenceOptions,
): TablePresence {
  const store = useStore();
  const { presence, setData } =
    useResourcePresence<TablePresenceData>(tableSubject);

  const rows = useMemo(() => {
    const map = new Map<string, RowPresence[]>();

    for (const item of presence) {
      // A cleared payload travels as `null`; validate the shape.
      if (typeof item.data?.row !== 'string') {
        continue;
      }

      const entry: RowPresence = {
        agent: item.agent,
        column:
          typeof item.data.column === 'string' ? item.data.column : undefined,
        dragging: item.data.dragging === true,
      };
      const existing = map.get(item.data.row) ?? [];

      // One entry per agent+column, so an agent's second tab doesn't
      // double their indicator (a dragging duplicate wins).
      const twin = existing.find(
        p => p.agent === entry.agent && p.column === entry.column,
      );

      if (twin) {
        twin.dragging = twin.dragging || entry.dragging;
      } else {
        existing.push(entry);
        map.set(item.data.row, existing);
      }
    }

    return map;
  }, [presence]);

  const setActiveCard = useCallback(
    (row: string | undefined, dragging?: boolean) => {
      setData(row ? (dragging ? { row, dragging: true } : { row }) : undefined);
    },
    [setData],
  );

  const presenceValue = useMemo(
    () => ({ rows, setActiveCard }),
    [rows, setActiveCard],
  );

  // Member-row subjects resolve asynchronously; rapid selection moves can
  // resolve out of order. Only the newest announcement may land.
  const announceSeqRef = useRef(0);

  const handleSelectedCellChange = useCallback(
    (row: number | undefined, column: number | undefined) => {
      const seq = ++announceSeqRef.current;

      const announce = (data: TablePresenceData | undefined) => {
        if (seq === announceSeqRef.current) {
          setData(data);
        }
      };

      // Column 0 is the row header; Infinity is the trailing filler cell.
      const property =
        column !== undefined && column >= 1 && Number.isFinite(column)
          ? columns[column - 1]?.subject
          : undefined;

      if (row === undefined || !Number.isFinite(row) || !property) {
        announce(undefined);

        return;
      }

      if (row < memberCount) {
        collection
          .getMemberWithIndex(row)
          .then(subject =>
            announce(subject ? { row: subject, column: property } : undefined),
          )
          .catch(() => announce(undefined));

        return;
      }

      // Session rows: a `_new:` row exists only in this tab, so it can't be
      // announced. Once materialized the store aliases it to its real
      // subject, which other sessions do see.
      const local = newRowSubjects[row - memberCount];
      const resolved = local
        ? store.getResourceLoading(local).subject
        : undefined;

      announce(
        resolved && !resolved.startsWith('_new:')
          ? { row: resolved, column: property }
          : undefined,
      );
    },
    [collection, columns, memberCount, newRowSubjects, setData, store],
  );

  return { presenceValue, handleSelectedCellChange };
}

/**
 * Marks a cell or card a remote session is on: an inset ring plus a
 * name tag in the agent's presence color, matching their canvas cursor
 * and avatar. Pulses while they're dragging. Rendered inside a
 * `position: relative` parent; never intercepts pointer events.
 */
export function RemoteCellPresence({
  agents,
  dragging,
}: {
  agents: string[];
  dragging?: boolean;
}): React.JSX.Element {
  return (
    <>
      <PresenceRing $color={colorForAgent(agents[0])} $dragging={!!dragging} />
      <CornerTag>
        <PresenceUserTag agentSubject={agents[0]} />
        {agents.length > 1 && <Overflow>+{agents.length - 1}</Overflow>}
      </CornerTag>
    </>
  );
}

const dragPulse = keyframes`
  from {
    opacity: 1;
  }

  to {
    opacity: 0.45;
  }
`;

const PresenceRing = styled.div<{ $color: string; $dragging: boolean }>`
  position: absolute;
  inset: 0;
  border: 2px solid ${p => p.$color};
  border-radius: inherit;
  pointer-events: none;

  ${p =>
    p.$dragging &&
    css`
      animation: 0.7s ease-in-out infinite alternate ${dragPulse};
    `}
`;

const CornerTag = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 0.15rem;
  pointer-events: none;
`;

const Overflow = styled.span`
  font-size: 0.7rem;
  color: ${p => p.theme.colors.textLight};
`;
