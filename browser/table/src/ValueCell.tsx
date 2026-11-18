import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Cell, type CellProps } from './chunks/TableEditor/Cell.js';
import {
  CursorMode,
  useTableEditorContext,
} from './chunks/TableEditor/TableEditorContext.js';
import type { JSONValue } from './value.js';

export type CellEditStart =
  | {
      kind: 'text';
      accepts: (key: string) => boolean;
      onSeed?: (key: string) => void;
    }
  | { kind: 'picker' }
  | {
      kind: 'value';
      fromCharacter: (key: string, current: JSONValue) => JSONValue;
    };

export interface ValueCellState {
  value: JSONValue;
  onChange: (value: JSONValue) => void | Promise<void>;
  seed?: string;
}

export interface ValueCellProps extends Pick<
  CellProps,
  'rowIndex' | 'columnIndex' | 'align' | 'onContextMenu' | 'disabled'
> {
  /** Stable row/property/language identity; changing it discards edit seeds. */
  identity: string;
  label: string;
  value: JSONValue;
  onChange: ValueCellState['onChange'];
  editStart: CellEditStart;
  renderEditor: (state: ValueCellState) => ReactNode;
  renderDisplay: (state: ValueCellState) => ReactNode;
  /** Reads fresh host state before Enter advances from a draft row. */
  canAdvance?: () => boolean;
  children?: ReactNode;
}

/** Shared edit-mode orchestration; storage, history and permissions stay in the
 * host's value adapter. No Resource, Store, router or datatype registry needed. */
export function ValueCell(props: ValueCellProps) {
  return <ValueCellSession key={props.identity} {...props} />;
}

function ValueCellSession({
  rowIndex,
  columnIndex,
  label,
  value,
  onChange,
  editStart,
  renderEditor,
  renderDisplay,
  canAdvance,
  onContextMenu,
  children,
  ...cellProps
}: ValueCellProps) {
  const { cursorMode, selectedRow, selectedColumn, setActiveCell } =
    useTableEditorContext();
  const isEditing =
    !cellProps.disabled &&
    cursorMode === CursorMode.Edit &&
    selectedRow === rowIndex &&
    selectedColumn === columnIndex;
  const [pendingValue, setPendingValue] = useState<JSONValue>();
  const [seed, setSeed] = useState<string>();

  const startWithCharacter = useCallback(
    (key: string) => {
      if (editStart.kind === 'text') {
        if (editStart.accepts(key)) {
          setSeed(key);
          editStart.onSeed?.(key);
        }

        return;
      }

      if (editStart.kind === 'picker') return;
      const next = editStart.fromCharacter(key, value);
      // An unaccepted key opens the editor without clearing a stored value.
      if (next === undefined) return;
      setPendingValue(next);
      void onChange(next);
    },
    [editStart, value, onChange],
  );

  const change = useCallback(
    (next: JSONValue) => {
      setPendingValue(undefined);

      return onChange(next);
    },
    [onChange],
  );

  useEffect(() => {
    if (!isEditing) {
      setPendingValue(undefined);
      setSeed(undefined);
    }
  }, [isEditing]);

  return (
    <Cell
      rowIndex={rowIndex}
      columnIndex={columnIndex}
      align={cellProps.align}
      disabled={cellProps.disabled}
      ariaDescription={`${label}, row ${rowIndex + 1}`}
      onEnterEditModeWithCharacter={startWithCharacter}
      onEditNextRow={() => {
        if (!canAdvance || canAdvance())
          setActiveCell(rowIndex + 1, columnIndex);
      }}
      onContextMenu={event => {
        if (!isEditing) onContextMenu?.(event);
      }}
    >
      {isEditing
        ? renderEditor({ value: pendingValue ?? value, onChange: change, seed })
        : renderDisplay({ value, onChange })}
      {children}
    </Cell>
  );
}
