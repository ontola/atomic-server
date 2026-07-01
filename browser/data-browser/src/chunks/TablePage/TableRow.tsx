import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  type JSX,
} from 'react';
import {
  Collection,
  core,
  DataBrowser,
  Property,
  Resource,
  unknownSubject,
  useMemberFromCollection,
  useResource,
} from '@tomic/react';
import { TableCell } from './TableCell';
import { styled, keyframes } from 'styled-components';
import { useTableEditorContext } from '@chunks/TableEditor/TableEditorContext';
import { FaTriangleExclamation } from 'react-icons/fa6';
import { useMaterializeWhenDeselected } from './useMaterializeWhenDeselected';

interface TableRowProps {
  collection: Collection;
  index: number;
  columns: Property[];
}

const WarningIcon = styled(FaTriangleExclamation)`
  color: ${p => p.theme.colors.warning};
`;

const TableCellMemo = memo(TableCell);

function useMarkings(row: Resource, index: number) {
  const { setMarkings } = useTableEditorContext();

  const addMarkings = useEffectEvent(() => {
    setMarkings(markings => {
      const newMap = new Map(markings);
      newMap.set(
        index,
        <WarningIcon title='Row is incomplete or has invalid data' />,
      );

      return newMap;
    });
  });

  const removeMarkings = useEffectEvent(() => {
    setMarkings(markings => {
      const newMap = new Map(markings);
      newMap.delete(index);

      return newMap;
    });
  });

  useEffect(() => {
    if (row.commitError) {
      addMarkings();
    }

    return () => {
      removeMarkings();
    };

    // Markings don't need to be updated when the function address changes...
  }, [row.commitError, index]);
}

export function TableRow({
  collection,
  index,
  columns,
}: TableRowProps): JSX.Element {
  const resource = useMemberFromCollection(collection, index);

  useMarkings(resource, index);

  if (resource.subject === unknownSubject) {
    return (
      <>
        {columns.map((column, i) => (
          <Loader key={column.subject} delay={i * 100} title='loading' />
        ))}
      </>
    );
  }

  return (
    <>
      {columns.map((column, cIndex) => (
        <TableCellMemo
          key={column.subject}
          rowIndex={index}
          columnIndex={cIndex + 1}
          subject={resource.subject}
          property={column}
        />
      ))}
    </>
  );
}

type TableNewRowProps = Omit<TableRowProps, 'collection'> & {
  parent: Resource<DataBrowser.Table>;
  /** Stable `_new:` subject owned by the parent (also this row's react-window
   * key). Passed in — NOT minted here — so a remount reuses the same virtual
   * resource instead of orphaning typed data on a discarded subject. */
  subject: string;
  /** True for the bottom-most new row — the only one that spawns a fresh
   * trailing placeholder when it first gains content. */
  isLast: boolean;
  addNewRow: () => void;
};

const resourceOpts = {
  newResource: true,
};

export function TableNewRow({
  index,
  columns,
  parent,
  subject,
  isLast,
  addNewRow,
}: TableNewRowProps): JSX.Element {
  // A synchronous, *virtual* new-row resource: a stable local `_new:`
  // placeholder, editable on first paint. The old code awaited
  // `store.newResource()` (genesis sign) on mount — a loading spinner per
  // row plus a signed commit for every empty placeholder — then persisted
  // each keystroke, so rapid entry churned saves → re-fetches → remounts that
  // stole focus from the cell. This row instead stays purely local (the Loro
  // dirty subscriber skips `_new:` subjects, so it never auto-drains) and is
  // materialized when the user moves off it (`useMaterializeWhenDeselected`).
  // Cells are keyed by the *stable* `_new:` subject — after materialization
  // the store aliases it to the real `did:ad:` subject, so the cell resolves
  // the same resource without remounting.
  const resource = useResource(subject, resourceOpts);

  useMarkings(resource, index);
  useMaterializeWhenDeselected(resource, index);

  // Spawn a fresh trailing placeholder the first time *this* (bottom-most) row
  // gains real content, so there is always exactly one empty row at the bottom
  // to type into — without persisting anything. This is the SOLE spawn trigger:
  // because it keeps a trailing empty row present once content exists, Enter and
  // Tab navigation just move into the row that's already there (no spawning on
  // navigation). The old code got this for free because the first keystroke
  // saved the row (→ collection invalidate → a new `TableNewRow` rendered
  // below). Guarded by a ref so it fires once per row, and gated on `isLast`
  // (read fresh via a ref so the callback stays stable) so only the bottom row
  // spawns. After it fires, this row is no longer last.
  const spawnedRef = useRef(false);
  const isLastRef = useRef(isLast);
  isLastRef.current = isLast;
  const handleFirstContent = useCallback(() => {
    if (spawnedRef.current || !isLastRef.current) {
      return;
    }

    spawnedRef.current = true;
    addNewRow();
  }, [addNewRow]);

  // Seed class + parent locally (validate:false → no fetch, no commit) so the
  // genesis sign at materialization builds a valid row of the table's class.
  // Runs once, keyed on the stable `_new:` subject.
  useEffect(() => {
    const classtype = parent.props.classtype;

    if (classtype) {
      void resource.set(core.properties.isA, [classtype], false);
    }

    void resource.set(core.properties.parent, parent.subject, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject]);

  return (
    <>
      {columns.map((column, cIndex) => (
        <TableCellMemo
          key={column.subject}
          rowIndex={index}
          columnIndex={cIndex + 1}
          subject={subject}
          property={column}
          onFirstContent={handleFirstContent}
        />
      ))}
    </>
  );
}

const pulse = keyframes`
  from {
    background-color: var(--from-color);
  }

  to {
    background-color: var(--to-color);
  }
`;

interface LoaderProps {
  delay: number;
}

const Loader = styled.div<LoaderProps>`
  width: 100%;
  --from-color: ${p => p.theme.colors.bg};
  --to-color: ${p => p.theme.colors.bg1};
  animation: 0.8s ${p => p.delay}ms ease-in-out infinite alternate ${pulse};
`;
