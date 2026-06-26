import { Property, useResource, useTitle } from '@tomic/react';
import { useMemo, useState, type JSX } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { styled } from 'styled-components';
import { FaTableColumns } from 'react-icons/fa6';
import { Popover } from '@components/Popover';
import { Column, Row } from '@components/Row';
import { Checkbox } from '@components/forms/Checkbox';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';

interface TableToolbarProps {
  viewName: string;
  renameView: (name: string) => void;
  /** Every property of the table's class. */
  allColumns: Property[];
  /** The currently visible columns, in order. */
  columns: Property[];
  showColumn: (subject: string) => void;
  hideColumn: (subject: string) => void;
  canWrite: boolean;
}

/**
 * The bar above the table: the active view's (editable) name and a column
 * visibility menu. The filter chips render in their own bar below this.
 */
export function TableToolbar({
  viewName,
  renameView,
  allColumns,
  columns,
  showColumn,
  hideColumn,
  canWrite,
}: TableToolbarProps): JSX.Element {
  const [name, setName] = useState(viewName);
  const [columnsOpen, setColumnsOpen] = useState(false);

  const visible = useMemo(
    () => new Set(columns.map(c => c.subject)),
    [columns],
  );

  return (
    <Bar>
      <NameInputWrapper>
        <NameInput
          aria-label='View name'
          value={name}
          disabled={!canWrite}
          onChange={e => setName(e.target.value)}
          onBlur={() => {
            const trimmed = name.trim();

            if (trimmed && trimmed !== viewName) {
              renameView(trimmed);
            } else {
              setName(viewName);
            }
          }}
        />
      </NameInputWrapper>
      <Popover
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        Trigger={
          <ColumnsTrigger disabled={!canWrite}>
            <FaTableColumns />
            <span>Columns</span>
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
    </Bar>
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
  gap: 0.5rem;
  padding-block: 0.25rem;
`;

const NameInputWrapper = styled(InputWrapper)`
  flex: 0 1 16rem;
  border-color: transparent;
  background-color: transparent;
`;

const NameInput = styled(InputStyled)`
  font-weight: bold;
  background-color: transparent;
`;

const ColumnsTrigger = styled(RadixPopover.Trigger)`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: 1.75rem;
  padding: 0.1rem 0.6rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  font-size: 0.85rem;

  &:hover:not(:disabled) {
    border-color: ${p => p.theme.colors.main};
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
