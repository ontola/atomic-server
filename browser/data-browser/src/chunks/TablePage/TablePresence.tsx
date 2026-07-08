import { createContext, useCallback, useMemo, useRef } from 'react';
import { styled } from 'styled-components';
import {
  useResourcePresence,
  useStore,
  type Collection,
  type Property,
} from '@tomic/react';
import { colorForAgent } from '@components/Presence/AgentAvatar';
import { PresenceUserTag } from '@components/Presence/PresenceUserTag';

/**
 * What a table session shares about its selection. Identity, not indexes:
 * a remote session's sort/filter/view can order rows differently, so the
 * cell is named by row resource subject + column property subject and
 * each cell self-matches on the receiving side.
 */
export interface TableCellPresenceData {
  /** Subject of the row resource. */
  row: string;
  /** Subject of the column property. */
  column: string;
}

export const cellPresenceKey = (row: string, column: string): string =>
  `${row} ${column}`;

/** Cell key (see {@link cellPresenceKey}) → agents of remote sessions
 *  whose active cell it is. Empty map when alone. */
export const TablePresenceContext = createContext<Map<string, string[]>>(
  new Map(),
);

interface UseTablePresenceOptions {
  collection: Collection;
  columns: Property[];
  /** Rows below this index are session rows from `newRowSubjects`. */
  memberCount: number;
  newRowSubjects: string[];
}

interface TablePresence {
  /** Provide on {@link TablePresenceContext} for the grid's cells. */
  cellPresence: Map<string, string[]>;
  /** Wire to `FancyTable`'s `onSelectedCellChange`. */
  handleSelectedCellChange: (
    row: number | undefined,
    column: number | undefined,
  ) => void;
}

/**
 * Selected-cell presence for one table, on the drive presence channel
 * (`PresenceEntry.data`). Announces our active cell and exposes which
 * cells remote sessions are on.
 */
export function useTablePresence(
  tableSubject: string,
  { collection, columns, memberCount, newRowSubjects }: UseTablePresenceOptions,
): TablePresence {
  const store = useStore();
  const { presence, setData } =
    useResourcePresence<TableCellPresenceData>(tableSubject);

  const cellPresence = useMemo(() => {
    const map = new Map<string, string[]>();

    for (const item of presence) {
      // A cleared payload travels as `null`; validate the shape.
      if (
        typeof item.data?.row !== 'string' ||
        typeof item.data.column !== 'string'
      ) {
        continue;
      }

      const key = cellPresenceKey(item.data.row, item.data.column);
      const agents = map.get(key) ?? [];

      if (!agents.includes(item.agent)) {
        agents.push(item.agent);
      }

      map.set(key, agents);
    }

    return map;
  }, [presence]);

  // Member-row subjects resolve asynchronously; rapid selection moves can
  // resolve out of order. Only the newest announcement may land.
  const announceSeqRef = useRef(0);

  const handleSelectedCellChange = useCallback(
    (row: number | undefined, column: number | undefined) => {
      const seq = ++announceSeqRef.current;

      const announce = (data: TableCellPresenceData | undefined) => {
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

  return { cellPresence, handleSelectedCellChange };
}

/**
 * Marks a cell a remote session has selected: an inset ring plus a name
 * tag in the agent's presence color, matching their canvas cursor and
 * avatar. Rendered inside the cell (`CellWrapper` is `position:
 * relative`); never intercepts pointer events.
 */
export function RemoteCellPresence({
  agents,
}: {
  agents: string[];
}): React.JSX.Element {
  return (
    <>
      <PresenceRing $color={colorForAgent(agents[0])} />
      <CornerTag>
        <PresenceUserTag agentSubject={agents[0]} />
        {agents.length > 1 && <Overflow>+{agents.length - 1}</Overflow>}
      </CornerTag>
    </>
  );
}

const PresenceRing = styled.div<{ $color: string }>`
  position: absolute;
  inset: 0;
  border: 2px solid ${p => p.$color};
  pointer-events: none;
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
