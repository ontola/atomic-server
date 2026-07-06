import {
  dataBrowser,
  Property,
  useResource,
  useString,
  useTitle,
} from '@tomic/react';
import { useContext, useMemo, useState, type JSX } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { styled } from 'styled-components';
import {
  FaCheck,
  FaCopy,
  FaFilter,
  FaPencil,
  FaPlus,
  FaTableColumns,
  FaTrash,
} from 'react-icons/fa6';
import { Popover } from '@components/Popover';
import { DIVIDER, DropdownMenu, DropdownItem } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { AutoOpenTrigger } from '@components/Dropdown/AutoOpenTrigger';
import {
  ConfirmationDialog,
  ConfirmationDialogTheme,
} from '@components/ConfirmationDialog';
import { Column, Row } from '@components/Row';
import { Checkbox } from '@components/forms/Checkbox';
import { InputStyled } from '@components/forms/InputStyles';
import { TablePageContext } from './tablePageContext';
import {
  normalizeViewKind,
  VIEW_KINDS,
  VIEW_KIND_LABELS,
  ViewKind,
} from './tableViewKinds';

interface TableViewTabsProps {
  views: string[];
  activeView: string | undefined;
  setActiveView: (subject: string) => void;
  createView: (kind?: ViewKind) => void;
  setViewKind: (subject: string, kind: ViewKind) => void;
  duplicateView: (subject: string) => void;
  deleteView: (subject: string) => void;
  viewName: string;
  renameView: (name: string) => void;
  allColumns: Property[];
  columns: Property[];
  showColumn: (subject: string) => void;
  hideColumn: (subject: string) => void;
  canWrite: boolean;
}

/**
 * The view-settings row (Notion-style): one tab per saved View on the left
 * with a `+` to add one, and a column-visibility menu on the right. The active
 * tab is renamed inline by double-clicking it.
 */
export function TableViewTabs({
  views,
  activeView,
  setActiveView,
  createView,
  setViewKind,
  duplicateView,
  deleteView,
  viewName,
  renameView,
  allColumns,
  columns,
  showColumn,
  hideColumn,
  canWrite,
}: TableViewTabsProps): JSX.Element {
  // A table with no saved views yet still shows one implicit "Default View" tab.
  const tabs = views.length > 0 ? views : [undefined];

  return (
    <Bar>
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
            setViewKind={setViewKind}
            duplicateView={duplicateView}
            deleteView={deleteView}
          />
        ))}
        {canWrite && <AddViewMenu createView={createView} />}
      </Tabs>
      <Actions>
        <FilterMenu columns={columns} />
        <ColumnsMenu
          allColumns={allColumns}
          columns={columns}
          showColumn={showColumn}
          hideColumn={hideColumn}
          canWrite={canWrite}
        />
      </Actions>
    </Bar>
  );
}

const AddViewTrigger = buildDefaultTrigger(<FaPlus />, 'Add view');

/** The `+` tab: a dropdown to add a new view of a chosen kind (Table/Kanban). */
function AddViewMenu({
  createView,
}: {
  createView: (kind?: ViewKind) => void;
}): JSX.Element {
  const items = useMemo(
    (): DropdownItem[] =>
      VIEW_KINDS.map(kind => ({
        id: kind,
        label: VIEW_KIND_LABELS[kind],
        onClick: () => createView(kind),
      })),
    [createView],
  );

  return <DropdownMenu Trigger={AddViewTrigger} items={items} />;
}

const FilterTrigger = buildDefaultTrigger(<FaFilter />, 'Filter');

/** Dropdown that adds a filter for one of the table's columns. */
function FilterMenu({ columns }: { columns: Property[] }): JSX.Element {
  const { filters, addFilter } = useContext(TablePageContext);

  const items = useMemo(
    (): DropdownItem[] =>
      columns
        .filter(c => !filters.some(f => f.property === c.subject))
        .map(c => ({
          id: c.subject,
          label: c.shortname,
          onClick: () => addFilter(c.subject),
        })),
    [columns, filters, addFilter],
  );

  // `DropdownMenu` with an empty item list recurses forever in its
  // index-finder, so render a disabled button when there's nothing to filter
  // (columns still loading, or every column already filtered).
  if (items.length === 0) {
    return (
      <IconBtn disabled title='Filter' type='button'>
        <FaFilter />
      </IconBtn>
    );
  }

  return <DropdownMenu Trigger={FilterTrigger} items={items} />;
}

function ViewTab({
  subject,
  active,
  fallbackName,
  canWrite,
  onSelect,
  onRename,
  setViewKind,
  duplicateView,
  deleteView,
}: {
  subject: string | undefined;
  active: boolean;
  fallbackName?: string;
  canWrite: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  setViewKind: (subject: string, kind: ViewKind) => void;
  duplicateView: (subject: string) => void;
  deleteView: (subject: string) => void;
}): JSX.Element {
  const resource = useResource(subject ?? 'unknown-subject');
  const [title] = useTitle(resource);
  const [storedKind] = useString(resource, dataBrowser.properties.viewKind);
  const currentKind = normalizeViewKind(storedKind);
  const name = subject ? title || 'Untitled view' : (fallbackName ?? 'View');

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // The cursor point of an open context menu (right-click, or clicking the
  // already-active tab). `undefined` = closed.
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number }>();
  const [showDelete, setShowDelete] = useState(false);

  const startRename = () => {
    setDraft(name);
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
          onClick: () => setShowDelete(true),
        },
        DIVIDER,
        {
          id: 'view-type',
          label: 'View type',
          header: true,
          onClick: () => undefined,
        },
        ...VIEW_KINDS.map(kind => ({
          id: `kind-${kind}`,
          label: VIEW_KIND_LABELS[kind],
          icon: kind === currentKind ? <FaCheck /> : undefined,
          onClick: () => setViewKind(subject, kind),
        })),
      ]
    : [];

  if (editing) {
    return (
      <TabInput
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim();

          if (trimmed && trimmed !== name) {
            onRename(trimmed);
          }

          setEditing(false);
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraft(name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <>
      <Tab
        role='tab'
        aria-selected={active}
        $active={active}
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
        {name}
      </Tab>
      {menuPoint && (
        <DropdownMenu
          items={menuItems}
          Trigger={AutoOpenTrigger}
          anchorPoint={menuPoint}
          bindActive={a => !a && setMenuPoint(undefined)}
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

function ColumnsMenu({
  allColumns,
  columns,
  showColumn,
  hideColumn,
  canWrite,
}: {
  allColumns: Property[];
  columns: Property[];
  showColumn: (subject: string) => void;
  hideColumn: (subject: string) => void;
  canWrite: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const visible = useMemo(
    () => new Set(columns.map(c => c.subject)),
    [columns],
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      Trigger={
        <ColumnsTrigger disabled={!canWrite} title='Show / hide columns'>
          <FaTableColumns />
        </ColumnsTrigger>
      }
    >
      <PopoverInner>
        {allColumns.map(column => (
          <ColumnToggle
            key={column.subject}
            column={column}
            checked={visible.has(column.subject)}
            onToggle={checked =>
              checked ? showColumn(column.subject) : hideColumn(column.subject)
            }
          />
        ))}
      </PopoverInner>
    </Popover>
  );
}

function ColumnToggle({
  column,
  checked,
  onToggle,
}: {
  column: Property;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}): JSX.Element {
  const resource = useResource(column.subject);
  const [title] = useTitle(resource);

  return (
    <ToggleRow>
      <Checkbox checked={checked} onChange={onToggle} />
      <span>{title || column.shortname}</span>
    </ToggleRow>
  );
}

const Bar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding-block: 0.25rem;
`;

const Tabs = styled.div`
  display: flex;
  align-items: center;
  gap: 0.25rem;
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 0.25rem;
`;

const IconBtn = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 1.85rem;
  width: 1.85rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background-color: transparent;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &:hover:not(:disabled) {
    background-color: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }
`;

const Tab = styled.button<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  height: 1.85rem;
  padding: 0.1rem 0.7rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background-color: ${p => (p.$active ? p.theme.colors.bg1 : 'transparent')};
  color: ${p => (p.$active ? p.theme.colors.text : p.theme.colors.textLight)};
  font-weight: ${p => (p.$active ? 'bold' : 'normal')};
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
  }
`;

const TabInput = styled(InputStyled)`
  height: 1.85rem;
  width: 10rem;
  font-weight: bold;
`;

const ColumnsTrigger = styled(RadixPopover.Trigger)`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 1.85rem;
  width: 1.85rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background-color: transparent;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;

  &:hover:not(:disabled) {
    background-color: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }
`;

const PopoverInner = styled(Column)`
  padding: ${p => p.theme.size()};
  gap: 0.25rem;
  min-width: 14rem;
  max-height: 24rem;
  overflow-y: auto;
`;

const ToggleRow = styled(Row)`
  align-items: center;
  gap: 0.5rem;
  padding: 0.15rem 0.25rem;
`;
