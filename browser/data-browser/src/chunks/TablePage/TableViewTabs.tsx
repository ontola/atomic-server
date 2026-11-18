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
import toast from 'react-hot-toast';
import {
  FaCopy,
  FaFilter,
  FaPencil,
  FaPlus,
  FaTableColumns,
  FaWindowMaximize,
  FaTrash,
  FaLock,
  FaLockOpen,
  FaCircle,
  FaTriangleExclamation,
  FaArrowsRotate,
  FaPlug,
} from 'react-icons/fa6';
import { DIVIDER, DropdownMenu, DropdownItem } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { AutoOpenTrigger } from '@components/Dropdown/AutoOpenTrigger';
import type { DropdownTriggerProps } from '@components/Dropdown/DropdownTrigger';
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
  appViewOf,
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
import { RowGrantDialog } from './RowGrantDialog';
import { addAppView } from './appViewGrant';
import { grantRowAccess, revokeRowAccess } from '@chunks/AppPage/rowGrant';
import { followTable } from '@chunks/AppPage/afterCommit';
import { useAfterCommit } from '@chunks/AppPage/useAfterCommit';
import { useRowGrant } from '@chunks/AppPage/useRowGrant';
import { piecesEnabled } from '@chunks/Pieces/piecesFlag';
import {
  offerHelper,
  usePieceOffers,
  type PieceOffers,
} from '@chunks/Pieces/usePieceOffers';
import type { QuickAddSpec } from './quickAdd';
import { QuickFilterField } from './QuickFilterField';

/** Tabs sit in a row: a dragged one must not wander off it. */
const keepHorizontal: Modifier = ({ transform }) => ({ ...transform, y: 0 });

interface TableViewTabsProps {
  /** The table these are views of. An app view's row grant is scoped to it. */
  table: string;
  /** The class of this table's rows, which decides what apps can show it. */
  rowClass: string;
  views: string[];
  activeView: string | undefined;
  setActiveView: (subject: string) => void;
  createView: (
    kind?: ViewKind | string,
    label?: string,
  ) => Promise<string | undefined>;
  setViewKind: (
    subject: string,
    kind: ViewKind | string,
    label?: string,
  ) => Promise<string | undefined>;
  duplicateView: (subject: string) => void;
  deleteView: (subject: string) => void;
  /** Persist a new tab order. */
  reorderViews: (views: string[]) => void;
  viewName: string;
  renameView: (name: string, subject?: string) => void;
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
  table,
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
  const store = useStore();
  const drive = store.getDrive();
  const driveApps = useDriveApps(drive);
  // The split-pieces exploration: views and integrations offered by row class
  // and through lenses. Off by default; then this is exactly `appsForClass`.
  const pieces = piecesEnabled();
  const offers = usePieceOffers(drive, driveApps.apps, rowClass, pieces);
  const apps = pieces
    ? offers.views.map(o => o.piece)
    : appsForClass(driveApps.apps, rowClass);
  // Which tab already shows which integration, for the Connect menu. Reads
  // nothing while the exploration is off.
  const typesBySubject = useViewTypes(views);
  // An app about to become a view, waiting on the person's answer to "may
  // it edit rows?" (#1740). `view` is set when an existing tab is switched.
  const [pendingApp, setPendingApp] = useState<{
    app: DriveApp;
    view?: string;
  }>();

  const onAppViewChosen = (allowEditing: boolean) => {
    const pending = pendingApp;
    if (!pending || !drive) return;

    addAppView({
      app: pending.app,
      view: pending.view,
      allowEditing,
      createView,
      setViewKind,
      grant: (view, via) =>
        grantRowAccess(store, {
          drive,
          table,
          app: pending.app.subject,
          view,
          via,
        }),
      // Read-only still follows the table's changes (#1851, decision 1).
      follow: (view, via) =>
        followTable(store, {
          drive,
          table,
          app: pending.app.subject,
          view,
          via,
        }),
    }).catch((e: Error) => toast.error(e.message));
  };

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
                onRename={name => renameView(name, subject)}
                createView={createView}
                setViewKind={setViewKind}
                canChangeType={
                  !!subject && canChangeViewType(subject, typesBySubject)
                }
                canDelete={!subject || canDeleteView(subject, typesBySubject)}
                chooseApp={(view, app) => setPendingApp({ app, view })}
                table={table}
                integrations={offers}
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
                chooseApp={app => setPendingApp({ app })}
                apps={apps}
                refreshApps={driveApps.refresh}
              />
            )}
          </Tabs>
        </SortableContext>
      </DndContext>
      {pendingApp && (
        <RowGrantDialog
          show
          app={pendingApp.app.subject}
          appName={pendingApp.app.name}
          bindShow={show => !show && setPendingApp(undefined)}
          onChoose={onAppViewChosen}
          readOnlyLabel='Read-only'
        />
      )}
      <Actions>
        {pieces && canWrite && offers.integrations.length > 0 && (
          <ConnectMenu
            offers={offers}
            typesBySubject={typesBySubject}
            createView={createView}
            setActiveView={setActiveView}
            refreshApps={driveApps.refresh}
          />
        )}
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

const AddViewTrigger = buildDefaultTrigger(<FaPlus />, () => 'Add view');

/** The `+` tab: a dropdown to add a new view of a chosen kind (Table/Kanban). */
function AddViewMenu({
  createView,
  chooseApp,
  apps,
  refreshApps,
}: {
  createView: (kind?: ViewKind | string, label?: string) => unknown;
  /** An app is added only after the person answers whether it may edit. */
  chooseApp: (app: DriveApp) => void;
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
        onClick: () => chooseApp(app),
      })),
    ],
    [createView, chooseApp, apps],
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

const FilterTrigger = buildDefaultTrigger(<FaFilter />, () => 'Filter');

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
  chooseApp,
  table,
  integrations,
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
  createView: (
    kind?: ViewKind | string,
    label?: string,
  ) => Promise<string | undefined>;
  setViewKind: (
    subject: string,
    kind: ViewKind | string,
    label?: string,
  ) => Promise<string | undefined>;
  /** Another view of this one's type remains, so changing it hides nothing. */
  canChangeType: boolean;
  /** False for the last table view while other views exist. */
  canDelete: boolean;
  /** Resolved once by the tab bar rather than once per tab. */
  apps: DriveApp[];
  /** Switching this tab to an app asks first whether it may edit rows. */
  chooseApp: (view: string, app: DriveApp) => void;
  table: string;
  /** Integrations this table offers (split-pieces exploration). */
  integrations: PieceOffers;
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
  const isIntegration = integrations.integrations.some(
    o => o.piece.subject === storedKind,
  );
  const ViewKindIcon = isIntegration
    ? FaArrowsRotate
    : VIEW_KIND_ICONS[currentKind];

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
  const [showRowGrant, setShowRowGrant] = useState(false);

  // The app this tab shows, if any, and whether it may edit the rows.
  const viewApp = appViewOf(storedKind);
  const appName =
    apps.find(app => app.subject === viewApp)?.name ?? (title || 'This app');
  const store = useStore();
  const drive = store.getDrive();
  const rowGrant = useRowGrant(
    canWrite && subject ? table : undefined,
    viewApp,
  );
  // A quiet mark when the app's `afterCommit` hook stopped following this
  // table, or has edits waiting (#1851, decisions 2 and 3).
  const hook = useAfterCommit(subject ? viewApp : undefined, table);
  const following = hook?.subscriptions.find(s => s.view === subject);
  const hookMark = following?.stopped
    ? `${appName} stopped following changes to this table`
    : following?.pending
      ? `${appName} wants to change rows`
      : undefined;

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
        // An app view's permission to edit rows, given or taken back here as
        // well as by adding or removing the view.
        ...(viewApp && rowGrant !== undefined
          ? [
              DIVIDER,
              rowGrant
                ? {
                    id: 'row-grant-revoke',
                    label: `Stop ${appName} editing rows`,
                    helper: 'It keeps showing the rows, read-only.',
                    icon: <FaLock />,
                    onClick: () => {
                      if (!drive) return;
                      revokeRowAccess(store, {
                        drive,
                        table,
                        app: viewApp,
                      }).catch((e: Error) => toast.error(e.message));
                    },
                  }
                : {
                    id: 'row-grant',
                    label: `Let ${appName} edit rows`,
                    icon: <FaLockOpen />,
                    onClick: () => setShowRowGrant(true),
                  },
            ]
          : []),
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
          onClick: () => chooseApp(subject, app),
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
        role='tab'
        aria-selected={active}
        onClick={e => {
          // Clicking the already-active tab opens its menu; otherwise select.
          if (active && hasMenu) {
            openMenuAt(e);
          } else {
            onSelect();
          }
        }}
        onContextMenu={openMenuAt}
        type='button'
      >
        {hookMark && (
          <HookMark
            role='img'
            aria-label={hookMark}
            title={hookMark}
            data-testid='after-commit-tab-mark'
            data-kind={following?.stopped ? 'stopped' : 'pending'}
          >
            {following?.stopped ? <FaTriangleExclamation /> : <FaCircle />}
          </HookMark>
        )}
      </SharedViewTab>
      {menuPoint && (
        <DropdownMenu
          items={menuItems}
          Trigger={AutoOpenTrigger}
          anchorPoint={menuPoint}
          bindActive={a => (a ? refreshApps() : setMenuPoint(undefined))}
        />
      )}
      {showRowGrant && subject && viewApp && (
        <RowGrantDialog
          show
          app={viewApp}
          appName={appName}
          bindShow={setShowRowGrant}
          onChoose={allow => {
            if (!allow || !drive) return;
            grantRowAccess(store, {
              drive,
              table,
              app: viewApp,
              view: subject,
              via: 'menu',
            }).catch((e: Error) => toast.error(e.message));
          }}
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
  () => 'Toggle properties',
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

/** The app view's `afterCommit` state on its tab (#1851). */
const HookMark = styled.span`
  display: inline-flex;
  font-size: 0.75em;

  &[data-kind='stopped'] {
    color: ${p => p.theme.colors.warning};
  }

  &[data-kind='pending'] {
    color: ${p => p.theme.colors.main};
    font-size: 0.5em;
  }
`;

/** Keeps unchecked rows aligned with the checked ones. */

/** The Connect button: labelled, since an icon alone would not say "sync". */
function ConnectTrigger({
  onClick,
  menuId,
  isActive,
  ref,
  id,
}: DropdownTriggerProps): JSX.Element {
  return (
    <ConnectButton
      id={id}
      ref={ref}
      type='button'
      aria-controls={menuId}
      aria-expanded={isActive}
      aria-haspopup='menu'
      onClick={onClick}
      title='Connect'
    >
      <FaPlug />
      <ConnectLabel>Connect</ConnectLabel>
    </ConnectButton>
  );
}

/**
 * Integrations get their own entry beside the view tabs (Q-092) instead of a
 * section of the "+" view menu: connecting a table to a platform is a
 * different act from choosing a way to look at it. Connecting still adds a
 * tab, which shows that integration's sync state. Several integrations can
 * be connected to one table (Q-090). One reachable only through an
 * unreviewed lens is listed, disabled, with the lens that holds it back.
 */
function ConnectMenu({
  offers: { integrations, lensNames, refresh },
  typesBySubject,
  createView,
  setActiveView,
  refreshApps,
}: {
  offers: PieceOffers;
  typesBySubject: Map<string, string>;
  createView: (kind?: ViewKind | string, label?: string) => void;
  setActiveView: (subject: string) => void;
  refreshApps: () => void;
}): JSX.Element {
  const tabOf = (app: string) =>
    [...typesBySubject].find(([, type]) => type === app)?.[0];

  const items: DropdownItem[] = [
    {
      id: 'connect-header',
      label: 'Sync this table with',
      header: true,
      onClick: () => undefined,
    },
    ...integrations.map(offer => {
      const { subject, name } = offer.piece;
      const tab = tabOf(subject);
      const waiting = offer.pendingReview.length > 0;

      return {
        id: `connect-${subject}`,
        label: name,
        icon: <FaArrowsRotate />,
        disabled: waiting,
        helper: waiting
          ? `Waiting for review of ${offer.pendingReview
              .map(l => lensNames.get(l) ?? l)
              .join(', ')}`
          : offerHelper(offer, lensNames),
        suffix: (
          <ViaLens>
            {waiting
              ? 'needs review'
              : tab
                ? 'connected'
                : offer.path.length === 0
                  ? undefined
                  : offer.path.length === 1
                    ? 'via lens'
                    : `via ${offer.path.length} lenses`}
          </ViaLens>
        ),
        onClick: () => (tab ? setActiveView(tab) : createView(subject, name)),
      };
    }),
  ];

  return (
    <DropdownMenu
      Trigger={ConnectTrigger}
      items={items}
      searchable={false}
      bindActive={active => {
        if (!active) return;
        // Lenses too: one approved since this table opened (Q-089) should
        // stop showing as waiting without a page reload.
        refreshApps();
        refresh();
      }}
    />
  );
}

/** Icon-only on phones, where the view tabs need the room. */
const ConnectLabel = styled.span`
  @media (max-width: 600px) {
    display: none;
  }
`;

const ConnectButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: 1.85rem;
  padding: 0.1rem 0.7rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: transparent;
  color: ${p => p.theme.colors.text};
  cursor: pointer;
  white-space: nowrap;

  &:hover,
  &[aria-expanded='true'] {
    background-color: ${p => p.theme.colors.bg1};
  }
`;

const ViaLens = styled.span`
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
  margin-left: auto;
  padding-left: ${p => p.theme.size(2)};
`;
