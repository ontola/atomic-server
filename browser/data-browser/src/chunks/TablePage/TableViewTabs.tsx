import { TableRowSelectionActions } from '@tomic/table';
import {
  dataBrowser,
  Property,
  useResource,
  useResources,
  useString,
  useTitle,
} from '@tomic/react';
import { useContext, useMemo, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  ViewTab as SharedViewTab,
  ViewTabsBar as Bar,
  ViewTabList as Tabs,
  ViewTabActions as Actions,
  TableFilterMenu as SharedFilterMenu,
  TableColumnsMenu as SharedColumnsMenu,
  type TableColumnsMenuPresentation,
  type TableFilterAddMenuProps,
} from '@tomic/table';
import { ghostButtonStyles } from '@components/Button';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  FaCopy,
  FaFilter,
  FaPencil,
  FaPlus,
  FaTableColumns,
  FaWindowMaximize,
  FaTrash,
} from 'react-icons/fa6';
import { DIVIDER, DropdownMenu, DropdownItem } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { AutoOpenTrigger } from '@components/Dropdown/AutoOpenTrigger';
import {
  ConfirmationDialog,
  ConfirmationDialogTheme,
} from '@components/ConfirmationDialog';
import { useStore } from '@tomic/react';
import { TablePageContext } from './tablePageContext';
import {
  appsForClass,
  useDriveApps,
  type DriveApp,
} from '@chunks/AppPage/useDriveApps';
import type { DerivedColumnSpec } from './derivedColumns';
import { derivedFilterKey } from './tableFiltering';
import { usePropertyTitles } from './helpers/usePropertyTitles';
import { ColumnFilterDropdown } from './ColumnFilterDropdown';
import {
  normalizeViewKind,
  VIEW_KINDS,
  VIEW_KIND_LABELS,
  VIEW_KIND_ICONS,
  ViewKind,
} from './tableViewKinds';
import {
  canChangeViewType,
  canDeleteView,
  viewTypeKey,
} from './viewTypeChoice';
import type { QuickAddSpec } from './quickAdd';
import { QuickFilterField } from './QuickFilterField';

/** Tabs sit in a row: a dragged one must not wander off it. */
const keepHorizontal: Modifier = ({ transform }) => ({ ...transform, y: 0 });

interface TableViewTabsProps {
  /** The class of this table's rows, which decides what apps can show it. */
  rowClass: string;
  views: string[];
  activeView: string | undefined;
  setActiveView: (subject: string) => void;
  createView: (kind?: ViewKind | string, label?: string) => void;
  setViewKind: (
    subject: string,
    kind: ViewKind | string,
    label?: string,
  ) => void;
  duplicateView: (subject: string) => void;
  deleteView: (subject: string) => void;
  /** Persist a new tab order. */
  reorderViews: (views: string[]) => void;
  viewName: string;
  renameView: (name: string) => void;
  allColumns: Property[];
  columns: Property[];
  /** The view's computed columns — filterable, like the stored ones. */
  derivedColumns: DerivedColumnSpec[];
  showColumn: (subject: string) => void;
  hideColumn: (subject: string) => void;
  /**
   * Properties the active view kind uses structurally (a timer's start/end, a
   * kanban's group-by). Toggling them would be a lie — the view renders them
   * either way — so they're shown as locked instead.
   */
  lockedColumns: ReadonlySet<string>;
  /** Why those are locked, e.g. "Always used by the timer view". */
  lockedReason: string;
  canWrite: boolean;
  /** The active view's create button, if it has one. */
  quickAdd: QuickAddSpec | undefined;
  /** Open the page-owned editor for the active view's create button. */
  requestQuickAddEdit: () => void;
  /**
   * The quick filter over the rows the view shows. Absent for views that show
   * no rows (a dashboard, an app).
   */
  quickFilter?: { value: string; onChange: (value: string) => void };
}

/**
 * The view-settings row (Notion-style): one tab per saved View on the left
 * with a `+` to add one, and a column-visibility menu on the right. The active
 * tab is renamed inline by double-clicking it.
 */
export function TableViewTabs({
  rowClass,
  views,
  activeView,
  setActiveView,
  createView,
  setViewKind,
  duplicateView,
  deleteView,
  reorderViews,
  viewName,
  renameView,
  allColumns,
  columns,
  derivedColumns,
  showColumn,
  hideColumn,
  lockedColumns,
  lockedReason,
  canWrite,
  quickAdd,
  requestQuickAddEdit,
  quickFilter,
}: TableViewTabsProps): JSX.Element {
  // A table with no saved views yet still shows one implicit "Default View" tab.
  const tabs = views.length > 0 ? views : [undefined];
  const driveApps = useDriveApps(useStore().getDrive());
  const apps = appsForClass(driveApps.apps, rowClass);
  const typesBySubject = useViewTypes(views);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // Touch scrolls the tab strip, so dragging a tab takes a press first.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 8 },
    }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return;
    }

    const from = views.indexOf(active.id as string);
    const to = views.indexOf(over.id as string);

    if (from !== -1 && to !== -1) {
      reorderViews(arrayMove(views, from, to));
    }
  };

  return (
    <Bar>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[keepHorizontal]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={views} strategy={horizontalListSortingStrategy}>
          <Tabs role='tablist'>
            {tabs.map((subject, i) => (
              <ViewTab
                key={subject ?? `implicit-${i}`}
                subject={subject}
                active={subject === activeView || (!activeView && i === 0)}
                fallbackName={subject ? undefined : viewName}
                canWrite={canWrite}
                onSelect={() => subject && setActiveView(subject)}
                onRename={renameView}
                createView={createView}
                setViewKind={setViewKind}
                canChangeType={
                  !!subject && canChangeViewType(subject, typesBySubject)
                }
                canDelete={!subject || canDeleteView(subject, typesBySubject)}
                apps={apps}
                refreshApps={driveApps.refresh}
                duplicateView={duplicateView}
                deleteView={deleteView}
                quickAdd={quickAdd}
                requestQuickAddEdit={requestQuickAddEdit}
              />
            ))}
            {canWrite && (
              <AddViewMenu
                createView={createView}
                apps={apps}
                refreshApps={driveApps.refresh}
              />
            )}
          </Tabs>
        </SortableContext>
      </DndContext>
      <Actions>
        <RowSelectionActions />
        {quickFilter && (
          <QuickFilterField
            value={quickFilter.value}
            onChange={quickFilter.onChange}
          />
        )}
        <FilterMenu columns={columns} derivedColumns={derivedColumns} />
        <ColumnsMenu
          allColumns={allColumns}
          columns={columns}
          showColumn={showColumn}
          hideColumn={hideColumn}
          lockedColumns={lockedColumns}
          lockedReason={lockedReason}
          canWrite={canWrite}
        />
      </Actions>
    </Bar>
  );
}

/**
 * Each saved view's type (built-in kind or app subject), live, so the tab menu
 * knows which choices would leave a type with no view left (#1806).
 */
function useViewTypes(views: string[]): Map<string, string> {
  // `useResources` wants a stable array; the tab list's identity may not be.
  const key = views.join('\n');
  const stableViews = useMemo(() => (key ? key.split('\n') : []), [key]);
  const resources = useResources(stableViews);

  return useMemo(
    () =>
      new Map(
        stableViews.map(s => [
          s,
          viewTypeKey(
            resources.get(s)?.get(dataBrowser.properties.viewKind) as
              | string
              | undefined,
          ),
        ]),
      ),
    [stableViews, resources],
  );
}

const AddViewTrigger = buildDefaultTrigger(<FaPlus />, 'Add view');

/** The `+` tab: a dropdown to add a new view of a chosen kind (Table/Kanban). */
function AddViewMenu({
  createView,
  apps,
  refreshApps,
}: {
  createView: (kind?: ViewKind | string, label?: string) => void;
  apps: DriveApp[];
  /** Asks the drive for its apps again; called as the menu opens. */
  refreshApps: () => void;
}): JSX.Element {
  const items = useMemo(
    (): DropdownItem[] => [
      ...VIEW_KINDS.map(kind => {
        const Icon = VIEW_KIND_ICONS[kind];

        return {
          id: kind,
          label: VIEW_KIND_LABELS[kind],
          icon: <Icon />,
          onClick: () => createView(kind),
        };
      }),
      // An app is another kind of view, added the same way. It arrives as a
      // new tab: the table's own views stay exactly as they were.
      ...apps.map(app => ({
        id: app.subject,
        label: app.name,
        icon: <FaWindowMaximize />,
        onClick: () => createView(app.subject, app.name),
      })),
    ],
    [createView, apps],
  );

  return (
    <DropdownMenu
      Trigger={AddViewTrigger}
      items={items}
      bindActive={active => active && refreshApps()}
    />
  );
}

/**
 * Appears while rows are ticked ("select mode"): how many, and what to do with
 * them. Sits next to the filter button, where the other table actions live.
 */
function RowSelectionActions(): JSX.Element | null {
  const { selectedRows, clearRowSelection, deleteSelectedRows, canWriteTable } =
    useContext(TablePageContext);

  return (
    <TableRowSelectionActions
      count={selectedRows.size}
      Button={IconBtn}
      onDelete={
        canWriteTable
          ? () => {
              void deleteSelectedRows();
            }
          : undefined
      }
      deleteUnavailable={
        !canWriteTable ? 'This table is read-only.' : undefined
      }
      onClear={clearRowSelection}
      messages={{
        label: 'Selected rows',
        count: <>{selectedRows.size} selected</>,
        delete: 'Delete selected rows',
        clear: 'Clear selection',
      }}
    />
  );
}

const FilterTrigger = buildDefaultTrigger(<FaFilter />, 'Filter');

function AtomicFilterMenu({
  items,
  disabled,
  description,
}: TableFilterAddMenuProps): JSX.Element {
  if (disabled)
    return (
      <IconBtn disabled title='Filter' type='button'>
        <FaFilter />
      </IconBtn>
    );

  return (
    <ColumnFilterDropdown
      Trigger={FilterTrigger}
      items={[
        {
          id: 'filter-header',
          label: description ?? '',
          header: true,
          onClick: () => undefined,
        },
        ...items.map(item => ({
          id: item.key,
          label: item.label,
          onClick: item.onSelect,
        })),
      ]}
    />
  );
}

/** Atomic labels and dropdown primitive for the shared filter selector. */
function FilterMenu({
  columns,
  derivedColumns,
}: {
  columns: Property[];
  derivedColumns: DerivedColumnSpec[];
}): JSX.Element {
  const { filters, addFilter } = useContext(TablePageContext);
  const titles = usePropertyTitles(columns);
  const targets = [
    ...columns.map(column => ({
      key: column.subject,
      label: titles.get(column.subject)!,
    })),
    ...derivedColumns.map(spec => ({
      key: derivedFilterKey(spec.id),
      label: spec.label,
    })),
  ];

  return (
    <SharedFilterMenu
      filters={filters}
      targets={targets}
      onAdd={addFilter}
      Menu={AtomicFilterMenu}
      messages={{
        label: 'Filter',
        search: 'Find a column to filter by',
        noMatch: 'No column matches',
        description: 'Filter rows by a column',
      }}
    />
  );
}

function ViewTab({
  subject,
  active,
  fallbackName,
  canWrite,
  onSelect,
  onRename,
  createView,
  setViewKind,
  canChangeType,
  canDelete,
  apps,
  refreshApps,
  duplicateView,
  deleteView,
  quickAdd,
  requestQuickAddEdit,
}: {
  subject: string | undefined;
  active: boolean;
  fallbackName?: string;
  canWrite: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  createView: (kind?: ViewKind | string, label?: string) => void;
  setViewKind: (
    subject: string,
    kind: ViewKind | string,
    label?: string,
  ) => void;
  /** Another view of this one's type remains, so changing it hides nothing. */
  canChangeType: boolean;
  /** False for the last table view while other views exist. */
  canDelete: boolean;
  /** Resolved once by the tab bar rather than once per tab. */
  apps: DriveApp[];
  /** Asks the drive for its apps again; called as the menu opens. */
  refreshApps: () => void;
  duplicateView: (subject: string) => void;
  deleteView: (subject: string) => void;
  quickAdd: QuickAddSpec | undefined;
  requestQuickAddEdit: () => void;
}): JSX.Element {
  const resource = useResource(subject ?? 'unknown-subject');
  const [title] = useTitle(resource);
  const [storedKind] = useString(resource, dataBrowser.properties.viewKind);
  const currentKind = normalizeViewKind(storedKind);
  const ownType = viewTypeKey(storedKind);
  const name = subject ? title || 'Untitled view' : (fallbackName ?? 'View');
  const ViewKindIcon = VIEW_KIND_ICONS[currentKind];

  const [editing, setEditing] = useState(false);
  // The implicit tab of a table with no saved views has nothing to reorder.
  const sortable = useSortable({
    id: subject ?? 'implicit',
    disabled: !subject || !canWrite || editing,
  });
  // The cursor point of an open context menu (right-click, or clicking the
  // already-active tab). `undefined` = closed.
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number }>();
  const [showDelete, setShowDelete] = useState(false);

  const startRename = () => {
    setEditing(true);
  };

  // The menu is only meaningful for saved views (real subject) with write access.
  const hasMenu = canWrite && !!subject;

  const openMenuAt = (e: React.MouseEvent) => {
    if (!hasMenu) {
      return;
    }

    e.preventDefault();
    setMenuPoint({ x: e.clientX, y: e.clientY });
  };

  const menuItems: DropdownItem[] = subject
    ? [
        {
          id: 'rename',
          label: 'Rename',
          icon: <FaPencil />,
          onClick: startRename,
        },
        {
          id: 'duplicate',
          label: 'Duplicate',
          icon: <FaCopy />,
          onClick: () => duplicateView(subject),
        },
        {
          id: 'delete',
          label: 'Delete',
          icon: <FaTrash />,
          disabled: !canDelete,
          helper: canDelete
            ? undefined
            : 'The last table view stays, so the rows can always be seen as a table.',
          onClick: () => setShowDelete(true),
        },
        // Only on the active tab: the page captures its current view, so
        // offering it elsewhere would edit a view the user is not looking at.
        ...(active
          ? [
              DIVIDER,
              {
                id: 'quick-add',
                label: quickAdd ? 'Edit the add button' : 'Add a create button',
                helper:
                  'A button above the rows that creates one — "Log a feed", "Add item".',
                icon: <FaPlus />,
                onClick: requestQuickAddEdit,
              },
            ]
          : []),
        // Picking a type adds a view of it next to this one (#1806): the user
        // should always be able to switch between all the applicable views,
        // so no choice here takes one away. Same list as the `+` tab.
        DIVIDER,
        {
          id: 'add-view',
          label: 'Add a view',
          header: true,
          onClick: () => undefined,
        },
        ...VIEW_KINDS.map(kind => {
          const Icon = VIEW_KIND_ICONS[kind];

          return {
            id: `add-${kind}`,
            label: VIEW_KIND_LABELS[kind],
            icon: <Icon />,
            onClick: () => createView(kind),
          };
        }),
        ...apps.map(app => ({
          id: `add-${app.subject}`,
          label: app.name,
          icon: <FaWindowMaximize />,
          onClick: () => createView(app.subject, app.name),
        })),
        // Changing this view in place, only while another view of its type
        // remains — so the last table view can never be converted away.
        ...(canChangeType
          ? [
              DIVIDER,
              {
                id: 'change-view',
                label: 'Change this view to',
                header: true,
                onClick: () => undefined,
              },
              ...VIEW_KINDS.filter(kind => kind !== ownType).map(kind => {
                const Icon = VIEW_KIND_ICONS[kind];

                return {
                  id: `kind-${kind}`,
                  label: VIEW_KIND_LABELS[kind],
                  icon: <Icon />,
                  onClick: () => setViewKind(subject, kind),
                };
              }),
              ...apps
                .filter(app => app.subject !== ownType)
                .map(app => ({
                  id: `kind-${app.subject}`,
                  label: app.name,
                  icon: <FaWindowMaximize />,
                  onClick: () => setViewKind(subject, app.subject, app.name),
                })),
            ]
          : []),
      ]
    : [];

  return (
    <>
      <SharedViewTab
        name={name}
        icon={<ViewKindIcon />}
        active={active}
        editing={editing}
        renameLabel='Rename view'
        onRename={onRename}
        onEditingChange={setEditing}
        ref={sortable.setNodeRef}
        style={{
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          opacity: sortable.isDragging ? 0.6 : undefined,
        }}
        {...sortable.attributes}
        {...sortable.listeners}
        onClick={e => {
          // Clicking the already-active tab opens its menu; otherwise select.
          if (active && hasMenu) {
            openMenuAt(e);
          } else {
            onSelect();
          }
        }}
        onContextMenu={openMenuAt}
      />
      {menuPoint && (
        <DropdownMenu
          items={menuItems}
          Trigger={AutoOpenTrigger}
          anchorPoint={menuPoint}
          bindActive={a => (a ? refreshApps() : setMenuPoint(undefined))}
        />
      )}
      {subject && (
        <ConfirmationDialog
          title='Delete view'
          show={showDelete}
          bindShow={setShowDelete}
          theme={ConfirmationDialogTheme.Alert}
          confirmLabel='Delete'
          onConfirm={() => deleteView(subject)}
        >
          <p>
            Are you sure you want to delete the <strong>{name}</strong> view?
            This only removes the view, not the rows.
          </p>
        </ConfirmationDialog>
      )}
    </>
  );
}

const ColumnsTrigger = buildDefaultTrigger(
  <FaTableColumns />,
  'Toggle properties',
);

function AtomicColumnsMenu({
  label,
  items,
  disabled,
}: TableColumnsMenuPresentation): JSX.Element {
  if (disabled)
    return (
      <IconBtn disabled title={label} type='button'>
        <FaTableColumns />
      </IconBtn>
    );

  return (
    <DropdownMenu
      Trigger={ColumnsTrigger}
      items={[
        { id: 'columns-header', label, header: true, onClick: () => undefined },
        ...items.map(item => ({
          id: item.key,
          label: item.label,
          icon: item.icon,
          helper: item.helper,
          disabled: item.disabled,
          keepOpen: true,
          onClick: item.toggle,
        })),
      ]}
    />
  );
}

/** Atomic titles and menu primitive for shared visibility/lock behavior. */
function ColumnsMenu({
  allColumns,
  columns,
  showColumn,
  hideColumn,
  lockedColumns,
  lockedReason,
  canWrite,
}: {
  allColumns: Property[];
  columns: Property[];
  showColumn: (subject: string) => void;
  hideColumn: (subject: string) => void;
  lockedColumns: ReadonlySet<string>;
  lockedReason: string;
  canWrite: boolean;
}): JSX.Element {
  const titles = usePropertyTitles(allColumns);
  const visible = new Set(columns.map(column => column.subject));

  return (
    <SharedColumnsMenu
      disabled={!canWrite}
      Menu={AtomicColumnsMenu}
      columns={allColumns.map(column => ({
        key: column.subject,
        label: titles.get(column.subject)!,
        shown: visible.has(column.subject),
        locked: lockedColumns.has(column.subject),
        lockReason: lockedReason,
      }))}
      onChange={(key, shown) => (shown ? showColumn(key) : hideColumn(key))}
      messages={{
        label: 'Toggle properties',
        show: 'Show this property',
        hide: 'Hide this property',
      }}
    />
  );
}

const IconBtn = styled.button`
  ${ghostButtonStyles}
  justify-content: center;
  height: 1.85rem;
  width: 1.85rem;
  padding: 0;
`;
