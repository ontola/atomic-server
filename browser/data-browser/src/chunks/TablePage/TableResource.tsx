import {
  unknownSubject,
  useCanWrite,
  useStore,
  type DataBrowser,
  type Property,
  type Resource,
} from '@tomic/react';
import { useHandleClearCells } from '@chunks/TablePage/helpers/useHandleClearCells';
import { useHandleColumnResize } from '@chunks/TablePage/helpers/useHandleColumnResize';
import { useHandleCopyCommand } from '@chunks/TablePage/helpers/useHandleCopyCommand';
import { useHandlePaste } from '@chunks/TablePage/helpers/useHandlePaste';
import {
  useTableHistory,
  createResourceDeletedHistoryItem,
} from '@chunks/TablePage/helpers/useTableHistory';
import {
  TablePageContext,
  type TablePageContextType,
} from '@chunks/TablePage/tablePageContext';
import { TableNewRow, TableRow } from '@chunks/TablePage/TableRow';
import { useTableColumns } from '@chunks/TablePage/useTableColumns';
import { useTableData } from '@chunks/TablePage/useTableData';
import {
  useId,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { FancyTable } from '@chunks/TableEditor/TableEditor';
import { NewColumnButton } from './NewColumnButton';
import { TableHeading } from './TableHeading';
import { TableFilterBar } from './TableFilterBar';
import { TableViewTabs } from './TableViewTabs';
import { ExpandedRowDialog } from './ExpandedRowDialog';

interface TableResourceProps {
  resource: Resource<DataBrowser.Table>;
}

const columnToKey = (column: Property) => column.subject;

export const TableResource: React.FC<TableResourceProps> = ({ resource }) => {
  const store = useStore();
  const titleId = useId();
  const canWrite = useCanWrite(resource);

  const {
    tableClass,
    sorting,
    setSortBy,
    filters,
    addFilter,
    setFilterValue,
    setFilterOperator,
    removeFilter,
    viewColumns,
    setViewColumns,
    viewName,
    renameView,
    views,
    activeView,
    setActiveView,
    createView,
    collection,
    ready,
    invalidateCollection,
  } = useTableData(resource);

  const { columns, allColumns, reorderColumns, hideColumn, showColumn } =
    useTableColumns(tableClass, viewColumns, setViewColumns);

  const { undoLastItem, addItemsToHistoryStack } =
    useTableHistory(invalidateCollection);

  const handlePaste = useHandlePaste(
    resource,
    collection,
    tableClass,
    invalidateCollection,
    addItemsToHistoryStack,
  );

  // Each new row's `_new:` subject is minted ONCE, here in the parent, and
  // used as both its react-window key and the subject handed to `TableNewRow`.
  // This is what keeps row identity stable: react-window recycles/remounts row
  // components freely, so if `TableNewRow` minted its own subject via
  // `useState(createSubject)` a remount would orphan the typed data on the old
  // subject and show a fresh empty one. Binding subject↔key in the parent means
  // a remount reuses the same subject and the same (virtual) resource.
  const generateRowSubject = useCallback(
    () => store.createSubject(resource.subject),
    [store, resource.subject],
  );

  const [newRowSubjects, setNewRowSubjects] = useState<string[]>(() => [
    generateRowSubject(),
  ]);

  // `memberCount` is the number of rows the collection already had when it
  // FIRST finished loading — captured once, at `ready`. Those render as real
  // `TableRow` collection members (by index). Everything after them is a
  // this-session row from `newRowSubjects`, rendered as a `TableNewRow` keyed
  // by its stable `_new:` subject.
  //
  // Freezing the count (rather than tracking `collection.totalMembers` live) is
  // the whole point: a session row NEVER flips from `TableNewRow` to `TableRow`
  // when it materializes. It keeps its `_new:` key — which the store aliases to
  // the real `did:ad:` subject, so the cell resolves the persisted resource —
  // and react-window therefore never remounts it. That remount was the churn
  // that desynced the table editor's active-cell / cursor state and dropped
  // keystrokes mid-edit. Capturing at the initial load (not inferring from
  // later growth) is also what makes a RELOAD correct: every persisted row is
  // part of that first count and renders as a member. (The growth-inference
  // version mistook the initial `0 → N` load for this-session materializations
  // and hid the rows.)
  //
  // Caveat: with a non-default sort AND pre-existing rows, a materialized
  // session row can sort into the member range and briefly render twice until a
  // reload re-seeds the session. For a fresh table `memberCount` is 0, so this
  // never happens — covering new-table entry, the common case.
  // Identity of the current query: value-bearing filters (incl. operator),
  // sort, and active view. `useCollection` returns a NEW collection instance
  // both when this changes (a filter/sort/view edit) and on same-query
  // refreshes (e.g. after a new row materializes). The baseline must re-capture
  // in the former case but stay frozen in the latter (so session/new rows keep
  // a stable identity and don't duplicate — "fast entry").
  const queryKey = useMemo(
    () =>
      JSON.stringify({
        f: filters
          .filter(x => x.value !== '')
          .map(x => [x.property, x.operator, x.value]),
        s: [sorting.prop, sorting.sortDesc],
        v: activeView ?? null,
      }),
    [filters, sorting, activeView],
  );

  const baselineMemberCountRef = useRef<number | null>(null);
  const baselineQueryKeyRef = useRef<string | null>(null);
  const prevCollectionRef = useRef(collection);

  if (prevCollectionRef.current !== collection) {
    prevCollectionRef.current = collection;

    if (baselineQueryKeyRef.current !== queryKey) {
      baselineMemberCountRef.current = null;
    }
  }

  if (ready && baselineMemberCountRef.current === null) {
    baselineMemberCountRef.current = collection.totalMembers;
    baselineQueryKeyRef.current = queryKey;
  }

  // Before the collection is ready, track its live count so existing members
  // render as `TableRow`s during load (matching the old behaviour); once ready,
  // the frozen baseline takes over.
  //
  // Clamp to the collection's CURRENT size: when a filter shrinks the
  // collection the frozen baseline would otherwise exceed `totalMembers`, and
  // `getMemberWithIndex(index)` throws "Index out of bounds" for the now-
  // missing rows (surfacing as an unhandled rejection in
  // `useMemberFromCollection`). The clamp guards that instant; the filter
  // rebase effect below then recaptures a fresh baseline.
  const memberCount = Math.min(
    baselineMemberCountRef.current ?? collection.totalMembers,
    collection.totalMembers,
  );

  // Applying a sort must visibly reorder the rows. Session rows render from
  // `newRowSubjects` in INSERTION order, bypassing the collection's sort, so a
  // sort would otherwise do nothing (the virtual rows ignore it). On a sort
  // change, "rebase" onto the freshly-sorted collection: clear the frozen
  // baseline (it re-captures from the re-sorted collection, so members render
  // in the new order) and reset the session to a single trailing placeholder.
  //
  // First, force-materialize any session row that has content but hasn't been
  // saved yet — otherwise dropping the session list would lose it. Once saved,
  // it joins the collection and reappears in its sorted position. Skips the
  // initial mount.
  const newRowSubjectsRef = useRef(newRowSubjects);
  newRowSubjectsRef.current = newRowSubjects;
  const rebaseInitialisedRef = useRef(false);

  // When the query changes (filter/sort/view edit — keyed on `queryKey`), the
  // collection rebuilds, so rebase the session: force-save any in-progress new
  // row, then reset to a single trailing placeholder. The baseline itself is
  // re-captured by the `queryKey`-aware block above (NOT here — doing it here
  // raced the still-`ready` old collection and captured its count).
  useEffect(() => {
    if (!rebaseInitialisedRef.current) {
      rebaseInitialisedRef.current = true;

      return;
    }

    for (const subject of newRowSubjectsRef.current) {
      const row = store.getResourceLoading(subject);

      if (row.subject.startsWith('_new:') && row.getEntries().length > 2) {
        void row.save().catch(() => undefined);
      }
    }

    setNewRowSubjects([generateRowSubject()]);
  }, [queryKey, store, generateRowSubject]);

  const decrementMemberCount = useCallback(() => {
    if (baselineMemberCountRef.current && baselineMemberCountRef.current > 0) {
      baselineMemberCountRef.current -= 1;
    }
  }, []);

  const addNewRow = useCallback(() => {
    setNewRowSubjects(prev => [...prev, generateRowSubject()]);
  }, [generateRowSubject]);

  const itemKey = useCallback(
    (index: number) => {
      if (index < memberCount) {
        return `member-${index}`;
      }

      return newRowSubjects[index - memberCount] ?? `new-row-fallback-${index}`;
    },
    [memberCount, newRowSubjects],
  );

  const [showExpandedRowDialog, setShowExpandedRowDialog] = useState(false);
  const [expandedRowSubject, setExpandedRowSubject] = useState<string>();

  const handleRowExpand = useCallback(
    async (index: number) => {
      const row = await collection.getMemberWithIndex(index);
      setExpandedRowSubject(row);
      setShowExpandedRowDialog(true);
    },
    [collection],
  );

  const tablePageContext: TablePageContextType = useMemo(
    () => ({
      tableSubject: resource.subject,
      tableClassSubject: tableClass.subject,
      sorting,
      setSortBy,
      filters,
      addFilter,
      setFilterValue,
      setFilterOperator,
      removeFilter,
      hideColumn,
      addItemsToHistoryStack,
    }),
    [
      resource.subject,
      tableClass.subject,
      sorting,
      setSortBy,
      filters,
      addFilter,
      setFilterValue,
      setFilterOperator,
      removeFilter,
      hideColumn,
      addItemsToHistoryStack,
    ],
  );

  const handleDeleteRow = useCallback(
    async (index: number) => {
      // Resolve the row by the SAME index→row mapping the grid renders with:
      // members come from the collection, session rows from `newRowSubjects`.
      // Using `collection.getMemberWithIndex` for everything would mis-resolve
      // session rows (they keep their `_new:` identity and are not addressed by
      // collection index here).
      const isMember = index < memberCount;
      const subject = isMember
        ? await collection.getMemberWithIndex(index)
        : newRowSubjects[index - memberCount];

      if (!subject) {
        return;
      }

      // Drop a session row from the render list immediately (optimistic).
      if (!isMember) {
        setNewRowSubjects(prev => prev.filter(s => s !== subject));
      }

      const rowResource = store.getResourceLoading(subject);

      // A purely-virtual row that was never materialized has no server resource
      // to destroy — removing it from `newRowSubjects` above is enough.
      if (rowResource.subject.startsWith('_new:')) {
        return;
      }

      addItemsToHistoryStack(createResourceDeletedHistoryItem(rowResource));

      await rowResource.destroy();

      if (isMember) {
        decrementMemberCount();
      }

      // No explicit invalidateCollection — `removeResource()` (called by
      // `destroy()`) emits `ResourceRemoved`, and `useCollection`'s listener
      // surgically strips the row from the cached page via
      // `applyResourceChange`. Calling `refresh()` here would re-fetch from
      // the local WASM DB (which still contains the just-destroyed row, since
      // `removeResource` doesn't tombstone there) and clobber the optimistic
      // update back to the pre-delete state.
    },
    [
      collection,
      store,
      addItemsToHistoryStack,
      memberCount,
      newRowSubjects,
      decrementMemberCount,
    ],
  );

  const handleClearCells = useHandleClearCells(
    collection,
    addItemsToHistoryStack,
  );

  const handleCopyCommand = useHandleCopyCommand(collection);

  const [columnSizes, handleColumnResize] = useHandleColumnResize(resource);

  const Row = useCallback(
    ({ index }: { index: number }) => {
      if (index < memberCount) {
        return (
          <TableRow collection={collection} index={index} columns={columns} />
        );
      }

      // Only the trailing new row spawns a fresh empty placeholder when it
      // first gains content (keeping exactly one empty row at the bottom).
      const newRowIndex = index - memberCount;
      const isLastNewRow = newRowIndex === newRowSubjects.length - 1;

      return (
        <TableNewRow
          parent={resource}
          columns={columns}
          index={index}
          subject={newRowSubjects[newRowIndex]}
          isLast={isLastNewRow}
          addNewRow={addNewRow}
        />
      );
    },

    // Resource can update a lot but its internals are stable so removing it from the array saves a lot of rerenders and shouldn't cause issues.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      collection,
      columns,
      memberCount,
      newRowSubjects,
      resource.subject,
      addNewRow,
    ],
  );

  return (
    <TablePageContext value={tablePageContext}>
      <TableViewTabs
        views={views}
        activeView={activeView}
        setActiveView={setActiveView}
        createView={createView}
        viewName={viewName}
        renameView={renameView}
        allColumns={allColumns}
        columns={columns}
        showColumn={showColumn}
        hideColumn={hideColumn}
        canWrite={canWrite}
      />
      <TableFilterBar columns={columns} />
      <FancyTable
        readOnly={!canWrite}
        columns={columns}
        columnSizes={columnSizes}
        itemCount={
          ready ? memberCount + newRowSubjects.length : collection.totalMembers
        }
        itemKey={itemKey}
        columnToKey={columnToKey}
        labelledBy={titleId}
        onClearRow={handleDeleteRow}
        onCellResize={handleColumnResize}
        onClearCells={handleClearCells}
        onCopyCommand={handleCopyCommand}
        onPasteCommand={handlePaste}
        onUndoCommand={undoLastItem}
        onColumnReorder={reorderColumns}
        onRowExpand={handleRowExpand}
        HeadingComponent={TableHeading}
        NewColumnButtonComponent={NewColumnButton}
      >
        {Row}
      </FancyTable>
      <ExpandedRowDialog
        subject={expandedRowSubject ?? unknownSubject}
        open={showExpandedRowDialog}
        bindOpen={setShowExpandedRowDialog}
      />
    </TablePageContext>
  );
};
