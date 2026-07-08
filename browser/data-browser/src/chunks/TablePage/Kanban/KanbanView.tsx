import {
  Collection,
  JSONValue,
  Property,
  Resource,
  commits,
  core,
  unknownSubject,
  useArray,
  useResource,
  useResources,
  useStore,
} from '@tomic/react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  closestCorners,
} from '@dnd-kit/core';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { styled } from 'styled-components';
import { useDragSensors } from '@chunks/TableEditor/hooks/useDragSensors';
import { LoaderBlock } from '@components/Loader';
import { KanbanColumn, UNCATEGORIZED_COLUMN_ID } from './KanbanColumn';
import { KanbanCard } from './KanbanCard';
import { ExpandedRowDialog } from '../ExpandedRowDialog';
import { useKanbanGroupBy } from './useKanbanGroupBy';
import { TablePresenceContext } from '../TablePresence';
import { KanbanFlipContext, type CardFlipRecord } from './cardFlip';

interface KanbanViewProps {
  /** The Table resource; new cards are created as its children. */
  tableSubject: string;
  tableClass: Resource;
  /** Every property of the class (used to find/adopt a group-by enum). */
  allColumns: Property[];
  /** The view's visible columns, in order (used for card field previews). */
  columns: Property[];
  collection: Collection;
  ready: boolean;
  viewGroupBy: string | undefined;
  setViewGroupBy: (property: string) => void;
  readOnly: boolean;
}

const MAX_CARD_FIELDS = 3;

export function KanbanView({
  tableSubject,
  tableClass,
  allColumns,
  columns,
  collection,
  ready,
  viewGroupBy,
  setViewGroupBy,
  readOnly,
}: KanbanViewProps): JSX.Element {
  const store = useStore();
  const sensors = useDragSensors();

  const { groupBy, status } = useKanbanGroupBy(
    tableClass,
    allColumns,
    viewGroupBy,
    setViewGroupBy,
    !readOnly,
  );

  // All rows of the table, loaded up front so cards can be bucketed by their
  // group-by value (including the "no status" bucket, which the query index
  // can't express as an "is empty" filter). Re-fetched when the collection
  // identity or size changes (new/removed rows).
  const [memberSubjects, setMemberSubjects] = useState<string[]>([]);
  const totalMembers = collection.totalMembers;

  useEffect(() => {
    let cancelled = false;

    void collection
      .getAllMembers()
      .then(members => {
        if (!cancelled) {
          setMemberSubjects(members);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [collection, totalMembers]);

  const rows = useResources(memberSubjects);

  const groupByResource = useResource(groupBy);
  const [columnTags] = useArray(groupByResource, core.properties.allowsOnly);

  // Bucket each row into its column by the first value of the group-by
  // property. Reactive: `useResources` re-snapshots when a card's status
  // changes (e.g. after a drag), so the buckets recompute.
  const buckets = useMemo(() => {
    const map = new Map<string, string[]>();
    map.set(UNCATEGORIZED_COLUMN_ID, []);

    for (const tag of columnTags) {
      map.set(tag, []);
    }

    if (!groupBy) {
      return map;
    }

    for (const subject of memberSubjects) {
      const resource = rows.get(subject);
      const value = resource?.get(groupBy) as string[] | undefined;
      const tag = value?.find(t => map.has(t));
      map.get(tag ?? UNCATEGORIZED_COLUMN_ID)?.push(subject);
    }

    return map;
  }, [columnTags, memberSubjects, rows, groupBy]);

  // Card preview fields: the view's columns minus the name (shown as the title)
  // and the group-by property (implied by the column), capped for density.
  const cardFields = useMemo(
    () =>
      columns
        .filter(
          c => c.subject !== core.properties.name && c.subject !== groupBy,
        )
        .slice(0, MAX_CARD_FIELDS),
    [columns, groupBy],
  );

  const [draggingSubject, setDraggingSubject] = useState<string>();

  // Presence: broadcast which card we're dragging so other sessions see
  // it pulse (hover is announced per card, in KanbanCard). Retract the
  // announcement when the board unmounts (e.g. a switch to grid view).
  const { setActiveCard } = useContext(TablePresenceContext);

  useEffect(() => () => setActiveCard(undefined), [setActiveCard]);

  // Last-commit card positions, for the FLIP move animation (see
  // `cardFlip.ts`). Board-wide so a card can animate across columns.
  const flipRegistry = useRef(new Map<string, CardFlipRecord>());

  // Open a card in the same modal the table's row-expand uses, rather than
  // navigating away to the full resource page.
  const [expandedSubject, setExpandedSubject] = useState<string>();
  const [showExpanded, setShowExpanded] = useState(false);

  const handleOpenCard = useCallback((subject: string) => {
    setExpandedSubject(subject);
    setShowExpanded(true);
  }, []);

  // Create a new card already assigned to a column: a row of the table's class
  // with its group-by property preset to that column's tag (empty for the
  // "No status" column). `createdAt` is required for it to appear in the table.
  const handleCreateCard = useCallback(
    async (tagSubject: string | undefined, name: string) => {
      const trimmed = name.trim();

      if (!trimmed) {
        return;
      }

      const propVals: Record<string, JSONValue> = {
        [core.properties.name]: trimmed,
        [commits.properties.createdAt]: Date.now(),
      };

      if (groupBy && tagSubject) {
        propVals[groupBy] = [tagSubject];
      }

      const row = await store.newResource({
        parent: tableSubject,
        isA: tableClass.subject,
        propVals,
      });
      await row.save();
      store.notifyResourceManuallyCreated(row);
    },
    [store, tableSubject, tableClass, groupBy],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setDraggingSubject(event.active.id as string);
      setActiveCard(event.active.id as string, true);
    },
    [setActiveCard],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingSubject(undefined);
      setActiveCard(undefined);
      const { active, over } = event;

      if (!over || !groupBy) {
        return;
      }

      const rowSubject = active.id as string;
      const targetTag = (over.data.current as { tagSubject?: string })
        ?.tagSubject;
      const resource = store.getResourceLoading(rowSubject);
      const current = (resource.get(groupBy) as string[] | undefined) ?? [];
      const nextValue = targetTag ? [targetTag] : [];

      // No-op if the card was dropped back onto its own column.
      if (
        current.length === nextValue.length &&
        current.every((v, i) => v === nextValue[i])
      ) {
        return;
      }

      void (async () => {
        await resource.set(groupBy, nextValue);
        await resource.save();
      })().catch(() => undefined);
    },
    [groupBy, store, setActiveCard],
  );

  if (status === 'creating' || (!ready && memberSubjects.length === 0)) {
    return (
      <Center>
        <LoaderBlock />
      </Center>
    );
  }

  if (status === 'resolving') {
    return <Center>Setting up the board…</Center>;
  }

  const columnIds = [...columnTags, UNCATEGORIZED_COLUMN_ID];

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <KanbanFlipContext value={flipRegistry}>
          <Board data-testid='kanban-board'>
            {columnIds.map(columnId => {
              const isUncategorized = columnId === UNCATEGORIZED_COLUMN_ID;

              return (
                <KanbanColumn
                  key={columnId}
                  columnId={columnId}
                  tagSubject={isUncategorized ? undefined : columnId}
                  cardSubjects={buckets.get(columnId) ?? []}
                  fields={cardFields}
                  readOnly={readOnly}
                  onAddCard={name =>
                    handleCreateCard(
                      isUncategorized ? undefined : columnId,
                      name,
                    )
                  }
                  onOpenCard={handleOpenCard}
                />
              );
            })}
          </Board>
        </KanbanFlipContext>
        {/* No overlay drop animation — the CARD animates instead: on drop it
         * re-renders in its new column and the FLIP hook glides it over from
         * the source slot (see cardFlip.ts). Animating the overlay too would
         * double the motion. */}
        <DragOverlay dropAnimation={null}>
          {draggingSubject ? (
            <KanbanCard
              subject={draggingSubject}
              fields={cardFields}
              readOnly
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      <ExpandedRowDialog
        subject={expandedSubject ?? unknownSubject}
        open={showExpanded}
        bindOpen={setShowExpanded}
      />
    </>
  );
}

const Board = styled.div`
  display: flex;
  gap: 1rem;
  /* Stretch columns to the board's full height so each column's own card list
   * is the scroll region — the column header stays pinned above it. */
  align-items: stretch;
  overflow-x: auto;
  /* Never scroll the board vertically; the per-column card lists do that. This
   * is what keeps the column headers visible while dragging a card downward. */
  overflow-y: hidden;
  padding: 1rem;
  /* Fill the viewport below the title + view tabs, capped so a tall board still
   * leaves the page chrome visible. Mirrors FancyTable's bounded-height model. */
  height: min(80vh, calc(100dvh - 13rem));
  min-height: 18rem;
`;

const Center = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2rem;
  color: ${p => p.theme.colors.textLight};
`;
